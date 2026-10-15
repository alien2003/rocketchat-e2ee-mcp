#!/usr/bin/env bash
# Thin wrapper around `docker-compose` (v2+, provided by mise) for docker/compose.yaml.
#
# Works with Docker Engine as-is. With rootless Podman (where `docker` is the podman shim and there is
# no Docker socket), it starts a project-local Podman API service under ./.local/podman and points
# DOCKER_HOST at it, so nothing is written outside the repository and no system service is enabled.
#
#   scripts/compose.sh up -d            # any docker-compose arguments
#   scripts/compose.sh --stop-podman-service
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PODMAN_DIR="$ROOT/.local/podman"
SOCK="$PODMAN_DIR/podman.sock"
PIDFILE="$PODMAN_DIR/service.pid"

is_podman() {
  command -v podman >/dev/null 2>&1 || return 1
  # Prefer Docker when a real Docker daemon is reachable.
  if command -v docker >/dev/null 2>&1 && docker version 2>/dev/null | grep -qi 'podman'; then
    return 0
  fi
  ! command -v docker >/dev/null 2>&1
}

sock_alive() {
  [ -S "$SOCK" ] && curl -fsS --max-time 2 --unix-socket "$SOCK" http://d/_ping >/dev/null 2>&1
}

start_podman_service() {
  mkdir -p "$PODMAN_DIR"
  if sock_alive; then
    return 0
  fi
  rm -f "$SOCK"
  nohup podman system service --time=0 "unix://$SOCK" >"$PODMAN_DIR/service.log" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 50); do
    sock_alive && return 0
    sleep 0.2
  done
  echo "compose.sh: podman API socket did not come up; see $PODMAN_DIR/service.log" >&2
  exit 1
}

stop_podman_service() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE" "$SOCK"
  fi
}

if [ "${1:-}" = "--stop-podman-service" ]; then
  stop_podman_service
  exit 0
fi

if [ -z "${DOCKER_HOST:-}" ] && is_podman; then
  start_podman_service
  export DOCKER_HOST="unix://$SOCK"
fi

if command -v docker-compose >/dev/null 2>&1 && docker-compose version 2>/dev/null | grep -q 'version v[2-9]'; then
  COMPOSE=(docker-compose)
else
  COMPOSE=(docker compose)
fi

exec "${COMPOSE[@]}" -f "$ROOT/docker/compose.yaml" --project-directory "$ROOT/docker" "$@"

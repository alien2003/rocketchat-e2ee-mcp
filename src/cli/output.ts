/**
 * The ONLY module allowed to write to stdout, and only for non-`serve` commands (doctor, search, export, ...).
 * `rc-mcp serve` never imports this: its stdout is the MCP JSON-RPC channel (enforced by test/unit/stdout-guard).
 */
export function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function outJson(data: unknown): void {
  out(JSON.stringify(data, null, 2));
}

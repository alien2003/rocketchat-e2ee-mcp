/**
 * Renders a room or a thread as Markdown with dates and authors — the "documentation buried in chat" use case.
 */
import type { App } from '../app.ts';
import type { MessageRecord, RoomRecord } from '../index/store.ts';
import { stripQuoteMarkers } from '../mcp/format.ts';
import { normalizeDate, resolveRoom } from '../mcp/operations.ts';

function author(m: MessageRecord): string {
  if (!m.username) return 'unknown';
  return m.userName && m.userName !== m.username ? `${m.userName} (@${m.username})` : `@${m.username}`;
}

function time(ts: string): string {
  return ts.slice(11, 16);
}

function body(m: MessageRecord): string {
  if (m.decryption.state === 'undecryptable')
    return `_[encrypted message could not be decrypted: ${m.decryption.reason}]_`;
  const parts: string[] = [];
  const text = stripQuoteMarkers(m.text).trim();
  const quoted = m.text.match(/\?msg=([A-Za-z0-9]+)/)?.[1];
  if (quoted && text !== m.text.trim()) parts.push(`_(quoting message ${quoted})_`);
  if (text) parts.push(text);
  for (const a of m.attachments) {
    if (a.fileId) {
      const meta = [a.mimeType, a.size ? `${a.size} bytes` : undefined, a.encrypted ? 'encrypted' : undefined]
        .filter(Boolean)
        .join(', ');
      parts.push(`📎 ${a.fileName ?? a.title ?? 'file'}${meta ? ` (${meta})` : ''} — file_id \`${a.fileId}\``);
    } else if (a.text || a.title) {
      parts.push(`> ${(a.authorName ? `${a.authorName}: ` : '') + (a.text ?? a.title ?? '')}`.replace(/\n/g, '\n> '));
    }
  }
  if (m.editedAt) parts.push('_(edited)_');
  return parts.join('\n\n');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => (l.length ? prefix + l : prefix.trimEnd()))
    .join('\n');
}

function renderMessage(m: MessageRecord, replies: MessageRecord[]): string {
  const lines = [`**${author(m)}** · ${time(m.ts)} UTC`, '', body(m)];
  if (replies.length) {
    lines.push('', `> **Thread — ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}**`);
    for (const r of replies) {
      lines.push('>', indent(`**${author(r)}** · ${r.ts.slice(0, 10)} ${time(r.ts)} UTC\n\n${body(r)}`, '> '));
    }
  }
  return lines.join('\n');
}

export interface ExportOptions {
  room: string;
  thread?: string;
  since?: string;
  until?: string;
}

export async function exportMarkdown(
  app: App,
  opts: ExportOptions,
): Promise<{ markdown: string; room: RoomRecord; count: number }> {
  const room = await resolveRoom(app, opts.room);
  const since = normalizeDate(opts.since, '--since');
  const until = normalizeDate(opts.until, '--until');
  const syncer = await app.syncer();
  await syncer.syncRoom(room.rid);
  const generated = new Date().toISOString();
  const header = (title: string, count: number) =>
    [
      `# ${title}`,
      '',
      `_Exported from ${app.siteUrl} on ${generated.slice(0, 16).replace('T', ' ')} UTC by rc-mcp · ${count} messages._`,
      ...(room.encrypted
        ? ['', '> ⚠️ This export contains decrypted end-to-end encrypted content. Store and share it accordingly.']
        : []),
      '',
    ].join('\n');

  if (opts.thread) {
    const root = app.store.getMessage(opts.thread);
    if (!root || root.rid !== room.rid) throw new Error(`thread ${opts.thread} not found in ${room.displayName}`);
    const replies = app.store.threadMessages(root.id, 100_000);
    const md = `${header(`Thread in ${room.displayName}`, replies.length + 1)}\n${renderMessage(root, replies)}\n`;
    return { markdown: md, room, count: replies.length + 1 };
  }

  const all = app.store
    .listMessages(room.rid, {
      limit: 1_000_000,
      includeThreads: true,
      ...(since ? { after: since } : {}),
      ...(until ? { before: until } : {}),
    })
    .reverse();
  const replies = new Map<string, MessageRecord[]>();
  for (const m of all) {
    if (m.tmid) replies.set(m.tmid, [...(replies.get(m.tmid) ?? []), m]);
  }
  const ids = new Set(all.map((m) => m.id));
  const roots = all.filter((m) => !m.tmid || !ids.has(m.tmid));
  const sections: string[] = [header(room.displayName, all.length)];
  let day = '';
  for (const m of roots) {
    const d = m.ts.slice(0, 10);
    if (d !== day) {
      sections.push(`## ${d}`, '');
      day = d;
    }
    sections.push(renderMessage(m, m.tmid ? [] : (replies.get(m.id) ?? [])), '', '---', '');
  }
  return { markdown: `${sections.join('\n').trimEnd()}\n`, room, count: all.length };
}

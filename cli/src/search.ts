import type Database from 'better-sqlite3';

/**
 * Full-text search over chat messages (SQLite FTS5).
 *
 * The index is a plain FTS5 table keyed by the message id and is brought up to date lazily, right before a
 * search: new messages are indexed, deleted ones dropped. That keeps every write path (turns, edits,
 * deletes, cascades) free of index bookkeeping, and is cheap at personal-assistant scale.
 */
export function migrateSearch(db: Database.Database): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, conversation_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
}

/** Visible text of a stored message: strings and text blocks; tool plumbing is not searchable. */
export function messageText(content: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  if (typeof parsed === 'string') return parsed;
  if (!Array.isArray(parsed)) return '';
  return parsed
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n');
}

export function syncSearchIndex(db: Database.Database): void {
  const last = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM messages_fts`).get() as { m: number }).m;
  const rows = db.prepare(`
    SELECT m.id, m.content, m.conversation_id AS cid FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id > ? AND c.kind = 'chat' AND m.role IN ('user','assistant') ORDER BY m.id
  `).all(last) as Array<{ id: number; content: string; cid: string }>;
  const ins = db.prepare(`INSERT INTO messages_fts (rowid, text, conversation_id) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const r of rows) {
      const text = messageText(r.content).trim();
      if (text) ins.run(r.id, text, r.cid);
    }
    db.prepare(`DELETE FROM messages_fts WHERE rowid NOT IN (SELECT id FROM messages)`).run();
  })();
}

export interface SearchHit {
  conversationId: string;
  title: string;
  messageId: number;
  /** HTML-free snippet; matches are wrapped in ⟦ ⟧ so the UI can highlight without trusting markup. */
  snippet: string;
}

/** User input → a safe FTS5 query: every word becomes a quoted prefix term (no operators, no syntax errors). */
export function toFtsQuery(q: string): string | null {
  const words = q.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  return words.length ? words.map(w => `"${w}"*`).join(' ') : null;
}

export function searchMessages(db: Database.Database, q: string, limit = 30): SearchHit[] {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  syncSearchIndex(db);
  const rows = db.prepare(`
    SELECT f.rowid AS messageId, f.conversation_id AS conversationId, c.title AS title,
           snippet(messages_fts, 0, '⟦', '⟧', '…', 14) AS snippet
    FROM messages_fts f JOIN conversations c ON c.id = f.conversation_id
    WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?
  `).all(fts, limit) as SearchHit[];
  return rows;
}

/** One chat as Markdown (user/assistant text only; tool calls are summarized in one line). */
export function exportMarkdown(title: string, messages: Array<{ role: string; content: unknown }>): string {
  const out = [`# ${title}`, ''];
  for (const m of messages) {
    const c = m.content;
    let text = '';
    const tools: string[] = [];
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const b of c as Array<{ type: string; text?: string; name?: string }>) {
        if (b.type === 'text' && b.text) text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use' && b.name) tools.push(b.name);
      }
    }
    if (!text.trim() && tools.length === 0) continue;
    out.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '');
    if (text.trim()) out.push(text.trim(), '');
    if (tools.length) out.push(`*Used tools: ${tools.join(', ')}*`, '');
  }
  return out.join('\n');
}

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const DEFAULT_DB_PATH = join(homedir(), '.everythingapp', 'everythingapp.db');

export function dbPath(): string {
  return process.env['EVERYTHINGAPP_DB_PATH'] ?? DEFAULT_DB_PATH;
}

export function openDb(path: string = dbPath()): Database.Database {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      title         TEXT NOT NULL DEFAULT 'New conversation',
      system_prompt TEXT,
      model         TEXT,
      sandbox_enabled INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gazeta_items (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      type            TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      input_schema    TEXT,
      response        TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      responded_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gazeta_status ON gazeta_items(status);

    CREATE TABLE IF NOT EXISTS batch_jobs (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      custom_id       TEXT NOT NULL,
      user_text       TEXT NOT NULL,
      preview         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      result_text     TEXT,
      submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_batch_conv ON batch_jobs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_batch_status ON batch_jobs(status);
  `);

  // Seed default settings
  const seedSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  seedSetting.run('global_system_prompt', '');
  seedSetting.run('default_model', 'claude-sonnet-5');
  seedSetting.run('custom_instructions', '');
}

// ─── Conversations ───────────────────────────────────────────────────────────

export interface ConversationRow {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string | null;
  sandboxEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export function createConversation(
  db: Database.Database,
  opts: { title?: string; systemPrompt?: string; model?: string; sandboxEnabled?: boolean } = {},
): { id: string } {
  const stmt = db.prepare(`
    INSERT INTO conversations (title, system_prompt, model, sandbox_enabled)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `);
  const row = stmt.get(
    opts.title ?? 'New conversation',
    opts.systemPrompt ?? null,
    opts.model ?? null,
    opts.sandboxEnabled ? 1 : 0,
  ) as { id: string };
  return { id: row.id };
}

export function listConversations(db: Database.Database): ConversationListItem[] {
  return (
    db
      .prepare(
        `SELECT c.id, c.title, c.updated_at as updatedAt,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as messageCount
         FROM conversations c
         ORDER BY c.updated_at DESC`,
      )
      .all() as ConversationListItem[]
  );
}

export function getConversation(db: Database.Database, id: string): ConversationRow | null {
  const row = db
    .prepare(
      `SELECT id, title, system_prompt as systemPrompt, model,
              sandbox_enabled as sandboxEnabled, created_at as createdAt, updated_at as updatedAt
       FROM conversations WHERE id = ?`,
    )
    .get(id) as ({ id: string; title: string; systemPrompt: string | null; model: string | null; sandboxEnabled: number; createdAt: string; updatedAt: string }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    systemPrompt: row.systemPrompt,
    model: row.model,
    sandboxEnabled: Boolean(row.sandboxEnabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function updateConversation(
  db: Database.Database,
  id: string,
  patch: { title?: string; systemPrompt?: string | null; model?: string | null; sandboxEnabled?: boolean },
): boolean {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
  if (patch.systemPrompt !== undefined) { sets.push('system_prompt = ?'); values.push(patch.systemPrompt); }
  if (patch.model !== undefined) { sets.push('model = ?'); values.push(patch.model); }
  if (patch.sandboxEnabled !== undefined) { sets.push('sandbox_enabled = ?'); values.push(patch.sandboxEnabled ? 1 : 0); }
  if (sets.length === 1) return false;
  values.push(id);
  const result = db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteConversation(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface MessageParam {
  role: string;
  content: unknown;
}

export function getMessages(db: Database.Database, conversationId: string): MessageParam[] {
  const rows = db
    .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId) as Array<{ role: string; content: string }>;
  return rows.map(r => ({ role: r.role, content: JSON.parse(r.content) }));
}

export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: string,
  content: unknown,
): number {
  const result = db
    .prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`)
    .run(conversationId, role, JSON.stringify(content));
  // Touch updated_at on the conversation
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
  return result.lastInsertRowid as number;
}

export function clearMessages(db: Database.Database, conversationId: string): void {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
}

// ─── Settings ────────────────────────────────────────────────────────────────

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

export function getAllSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ─── Gazeta ──────────────────────────────────────────────────────────────────

export interface GazetaItem {
  id: string;
  type: string;
  conversationId: string | null;
  title: string;
  description: string | null;
  inputSchema: unknown | null;
  response: unknown | null;
  status: string;
  createdAt: string;
  respondedAt: string | null;
}

export function createGazetaItem(
  db: Database.Database,
  item: { type: string; conversationId?: string; title: string; description?: string; inputSchema?: unknown },
): string {
  const row = db
    .prepare(
      `INSERT INTO gazeta_items (type, conversation_id, title, description, input_schema)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      item.type,
      item.conversationId ?? null,
      item.title,
      item.description ?? null,
      item.inputSchema !== undefined ? JSON.stringify(item.inputSchema) : null,
    ) as { id: string };
  return row.id;
}

export function listGazetaItems(db: Database.Database, status?: string): GazetaItem[] {
  const sql = status
    ? `SELECT * FROM gazeta_items WHERE status = ? ORDER BY created_at DESC`
    : `SELECT * FROM gazeta_items ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...(status ? [status] : [])) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: r['id'] as string,
    type: r['type'] as string,
    conversationId: r['conversation_id'] as string | null,
    title: r['title'] as string,
    description: r['description'] as string | null,
    inputSchema: r['input_schema'] ? JSON.parse(r['input_schema'] as string) : null,
    response: r['response'] ? JSON.parse(r['response'] as string) : null,
    status: r['status'] as string,
    createdAt: r['created_at'] as string,
    respondedAt: r['responded_at'] as string | null,
  }));
}

export function respondToGazetaItem(db: Database.Database, id: string, response: unknown): boolean {
  const result = db
    .prepare(
      `UPDATE gazeta_items SET status = 'responded', response = ?, responded_at = datetime('now') WHERE id = ?`,
    )
    .run(JSON.stringify(response), id);
  return result.changes > 0;
}

export function dismissGazetaItem(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(`UPDATE gazeta_items SET status = 'dismissed' WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

// ─── Batch jobs ───────────────────────────────────────────────────────────────

export interface BatchJob {
  id: string;
  conversationId: string;
  customId: string;
  userText: string;
  preview: string;
  status: string;
  resultText: string | null;
  submittedAt: string;
  resolvedAt: string | null;
}

export function createBatchJob(
  db: Database.Database,
  job: { id: string; conversationId: string; customId: string; userText: string; preview: string },
): void {
  db.prepare(
    `INSERT INTO batch_jobs (id, conversation_id, custom_id, user_text, preview) VALUES (?, ?, ?, ?, ?)`,
  ).run(job.id, job.conversationId, job.customId, job.userText, job.preview);
}

export function listBatchJobs(
  db: Database.Database,
  opts: { conversationId?: string; status?: string } = {},
): BatchJob[] {
  let sql = `SELECT id, conversation_id as conversationId, custom_id as customId,
               user_text as userText, preview, status, result_text as resultText,
               submitted_at as submittedAt, resolved_at as resolvedAt
             FROM batch_jobs`;
  const conditions: string[] = [];
  const values: string[] = [];
  if (opts.conversationId) { conditions.push('conversation_id = ?'); values.push(opts.conversationId); }
  if (opts.status) { conditions.push('status = ?'); values.push(opts.status); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ` ORDER BY submitted_at DESC`;
  return db.prepare(sql).all(...values) as BatchJob[];
}

export function resolveBatchJob(db: Database.Database, id: string, status: string, resultText?: string): void {
  db.prepare(
    `UPDATE batch_jobs SET status = ?, result_text = ?, resolved_at = datetime('now') WHERE id = ?`,
  ).run(status, resultText ?? null, id);
}

export function getPendingBatchJobs(db: Database.Database): BatchJob[] {
  return listBatchJobs(db, { status: 'pending' });
}

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

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
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
  `);

  // Message branching (edit/regenerate — Phase 1 of the Full Build Roadmap):
  // `parent_id` links a message to whichever message it branches off of;
  // `is_active` marks which branch is currently the visible one.
  // ALTER TABLE ADD COLUMN has no "IF NOT EXISTS" in SQLite, so this is
  // guarded manually — safe to run on both a fresh db (columns already
  // exist from CREATE TABLE below) and an existing pre-branching db.
  if (!columnExists(db, 'messages', 'parent_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN parent_id INTEGER`);
  }
  if (!columnExists(db, 'messages', 'is_active')) {
    db.exec(`ALTER TABLE messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(conversation_id, is_active, id);

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

    -- Phase 2: Custom Skills system
    -- allowed_tools is a JSON array of tool name strings (informational; not
    -- a hard filter on the tool registry — just surfaced in the UI so the user
    -- knows what a skill was designed to use).
    CREATE TABLE IF NOT EXISTS skills (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      prompt        TEXT NOT NULL DEFAULT '',
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Many-to-many: a conversation can have multiple skills attached,
    -- and a skill can be reused across conversations.
    CREATE TABLE IF NOT EXISTS conversation_skills (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, skill_id)
    );

    -- Phase 3: BYOK key vault. Only ciphertext ever lands here — see
    -- providers/key-vault.ts (AES-256-GCM, key derived from KEY_VAULT_SECRET
    -- which lives in the environment, never in this database).
    CREATE TABLE IF NOT EXISTS provider_keys (
      provider   TEXT PRIMARY KEY,
      salt       TEXT NOT NULL,
      iv         TEXT NOT NULL,
      tag        TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      last4      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-provider soft spend cap (a warning, not a hard stop). Separate from
    -- provider_keys so an env-supplied key can have a threshold too.
    CREATE TABLE IF NOT EXISTS provider_limits (
      provider         TEXT PRIMARY KEY,
      warn_usd_monthly REAL,
      warned_period    TEXT
    );

    -- Phase 3: one row per billed API response. Not FK'd to conversations on
    -- purpose: deleting a chat must not rewrite spend history.
    CREATE TABLE IF NOT EXISTS usage_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT NOT NULL,
      conversation_id TEXT,
      provider        TEXT NOT NULL,
      model           TEXT NOT NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      pricing_known   INTEGER NOT NULL DEFAULT 1,
      batch           INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_conv ON usage_log(conversation_id);

    -- Phase 3: provider-specific state that has no home in the Anthropic-shaped
    -- message format (Gemini 3 thought signatures, DeepSeek reasoning_content),
    -- keyed by tool call id. Lets history stay in one canonical format while
    -- each adapter can still replay what its provider insists on getting back.
    CREATE TABLE IF NOT EXISTS tool_call_meta (
      tool_call_id TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      meta         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
  /** Present from getMessages(); a bare type-cast to Anthropic.MessageParam[] elsewhere in
   * the codebase ignores it, and sanitizeHistory() in anthropic-loop.ts strips it before any
   * request actually reaches the API. */
  id?: number;
  role: string;
  content: unknown;
}

export interface FullMessageRow {
  id: number;
  role: string;
  content: unknown;
  parentId: number | null;
  isActive: boolean;
  createdAt: string;
}

/** Only the currently-active branch, in order — what every turn (live, batch, regenerate) is built from. */
export function getMessages(db: Database.Database, conversationId: string): MessageParam[] {
  const rows = db
    .prepare(`SELECT id, role, content FROM messages WHERE conversation_id = ? AND is_active = 1 ORDER BY id ASC`)
    .all(conversationId) as Array<{ id: number; role: string; content: string }>;
  return rows.map(r => ({ id: r.id, role: r.role, content: JSON.parse(r.content) }));
}

/** Every message including inactive branches — for history/debugging, not for building a turn. */
export function getAllMessagesFull(db: Database.Database, conversationId: string): FullMessageRow[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, parent_id as parentId, is_active as isActive, created_at as createdAt
       FROM messages WHERE conversation_id = ? ORDER BY id ASC`,
    )
    .all(conversationId) as Array<{ id: number; role: string; content: string; parentId: number | null; isActive: number; createdAt: string }>;
  return rows.map(r => ({
    id: r.id,
    role: r.role,
    content: JSON.parse(r.content),
    parentId: r.parentId,
    isActive: Boolean(r.isActive),
    createdAt: r.createdAt,
  }));
}

export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: string,
  content: unknown,
  parentId: number | null = null,
): number {
  const result = db
    .prepare(`INSERT INTO messages (conversation_id, role, content, parent_id) VALUES (?, ?, ?, ?)`)
    .run(conversationId, role, JSON.stringify(content), parentId);
  // Touch updated_at on the conversation
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
  return result.lastInsertRowid as number;
}

export function clearMessages(db: Database.Database, conversationId: string): void {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
}

/**
 * Hard-deletes a message and everything after it (across every branch, not
 * just the active one) — an explicit user "delete" is a real removal, not a
 * new branch. Distinct from clearMessages(), which wipes an entire
 * conversation.
 */
export function deleteMessagesFrom(db: Database.Database, conversationId: string, fromMessageId: number): boolean {
  const result = db
    .prepare(`DELETE FROM messages WHERE conversation_id = ? AND id >= ?`)
    .run(conversationId, fromMessageId);
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
  return result.changes > 0;
}

/**
 * Soft-deletes: marks a message and everything currently active after it as
 * inactive, without deleting rows — used by edit/regenerate to retire the
 * old branch while keeping it around for potential future branch-history UI.
 */
export function deactivateMessagesFrom(db: Database.Database, conversationId: string, fromMessageId: number): void {
  db.prepare(`UPDATE messages SET is_active = 0 WHERE conversation_id = ? AND id >= ? AND is_active = 1`).run(
    conversationId,
    fromMessageId,
  );
}

export function getLastActiveMessage(
  db: Database.Database,
  conversationId: string,
): { id: number; role: string; content: unknown; parentId: number | null } | null {
  const row = db
    .prepare(
      `SELECT id, role, content, parent_id as parentId FROM messages
       WHERE conversation_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId) as { id: number; role: string; content: string; parentId: number | null } | undefined;
  if (!row) return null;
  return { id: row.id, role: row.role, content: JSON.parse(row.content), parentId: row.parentId };
}

/**
 * Walks backward from (and including) `fromId` through the active branch to
 * find the nearest user message — the "anchor" a regenerate/retry re-sends.
 * Needed because a single logical turn can span several raw rows (one per
 * tool-loop round trip per anthropic-loop.ts), so "the message right before
 * this one" isn't necessarily the user turn that started it — pass null for
 * fromId to search from the end of the conversation (used by retry).
 */
export function findRegenerationAnchor(
  db: Database.Database,
  conversationId: string,
  fromId: number | null,
): { id: number; content: unknown; parentId: number | null } | null {
  const row = db
    .prepare(
      `SELECT id, content, parent_id as parentId FROM messages
       WHERE conversation_id = ? AND is_active = 1 AND role = 'user' AND (? IS NULL OR id <= ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId, fromId, fromId) as { id: number; content: string; parentId: number | null } | undefined;
  if (!row) return null;
  return { id: row.id, content: JSON.parse(row.content), parentId: row.parentId };
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

// ─── Skills ───────────────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  allowedTools: string[];
  createdAt: string;
  updatedAt: string;
}

function rowToSkill(r: Record<string, unknown>): Skill {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    description: r['description'] as string,
    prompt: r['prompt'] as string,
    allowedTools: JSON.parse(r['allowed_tools'] as string) as string[],
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
}

export function listSkills(db: Database.Database): Skill[] {
  return (db.prepare(`SELECT * FROM skills ORDER BY created_at ASC`).all() as Record<string, unknown>[]).map(rowToSkill);
}

export function getSkill(db: Database.Database, id: string): Skill | null {
  const row = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : null;
}

export function createSkill(
  db: Database.Database,
  opts: { name: string; description?: string; prompt?: string; allowedTools?: string[] },
): Skill {
  const row = db
    .prepare(
      `INSERT INTO skills (name, description, prompt, allowed_tools)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(
      opts.name,
      opts.description ?? '',
      opts.prompt ?? '',
      JSON.stringify(opts.allowedTools ?? []),
    ) as Record<string, unknown>;
  return rowToSkill(row);
}

export function updateSkill(
  db: Database.Database,
  id: string,
  patch: { name?: string; description?: string; prompt?: string; allowedTools?: string[] },
): boolean {
  const sets: string[] = [`updated_at = datetime('now')`];
  const values: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
  if (patch.prompt !== undefined) { sets.push('prompt = ?'); values.push(patch.prompt); }
  if (patch.allowedTools !== undefined) { sets.push('allowed_tools = ?'); values.push(JSON.stringify(patch.allowedTools)); }
  if (sets.length === 1) return false;
  values.push(id);
  const result = db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteSkill(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM skills WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getConversationSkills(db: Database.Database, conversationId: string): Skill[] {
  const rows = db
    .prepare(
      `SELECT s.* FROM skills s
       JOIN conversation_skills cs ON cs.skill_id = s.id
       WHERE cs.conversation_id = ?
       ORDER BY s.created_at ASC`,
    )
    .all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

export function attachSkill(db: Database.Database, conversationId: string, skillId: string): boolean {
  try {
    db.prepare(`INSERT OR IGNORE INTO conversation_skills (conversation_id, skill_id) VALUES (?, ?)`).run(conversationId, skillId);
    return true;
  } catch {
    return false;
  }
}

export function detachSkill(db: Database.Database, conversationId: string, skillId: string): boolean {
  const result = db.prepare(`DELETE FROM conversation_skills WHERE conversation_id = ? AND skill_id = ?`).run(conversationId, skillId);
  return result.changes > 0;
}

// ─── Phase 3: provider keys / limits / usage / tool-call meta ────────────────

export interface ProviderKeyRow {
  provider: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  last4: string;
  updatedAt: string;
}

export function getProviderKeyRow(db: Database.Database, provider: string): ProviderKeyRow | null {
  const row = db
    .prepare(`SELECT provider, salt, iv, tag, ciphertext, last4, updated_at AS updatedAt FROM provider_keys WHERE provider = ?`)
    .get(provider) as ProviderKeyRow | undefined;
  return row ?? null;
}

export function upsertProviderKeyRow(
  db: Database.Database,
  row: Omit<ProviderKeyRow, 'updatedAt'>,
): void {
  db.prepare(
    `INSERT INTO provider_keys (provider, salt, iv, tag, ciphertext, last4)
     VALUES (@provider, @salt, @iv, @tag, @ciphertext, @last4)
     ON CONFLICT(provider) DO UPDATE SET
       salt = excluded.salt, iv = excluded.iv, tag = excluded.tag,
       ciphertext = excluded.ciphertext, last4 = excluded.last4,
       updated_at = datetime('now')`,
  ).run(row);
}

export function deleteProviderKeyRow(db: Database.Database, provider: string): boolean {
  return db.prepare(`DELETE FROM provider_keys WHERE provider = ?`).run(provider).changes > 0;
}

export interface ProviderLimit {
  warnUsdMonthly: number | null;
  warnedPeriod: string | null;
}

export function getProviderLimit(db: Database.Database, provider: string): ProviderLimit {
  const row = db
    .prepare(`SELECT warn_usd_monthly AS warnUsdMonthly, warned_period AS warnedPeriod FROM provider_limits WHERE provider = ?`)
    .get(provider) as ProviderLimit | undefined;
  return row ?? { warnUsdMonthly: null, warnedPeriod: null };
}

export function setProviderWarnLimit(db: Database.Database, provider: string, warnUsdMonthly: number | null): void {
  // Changing the threshold re-arms the warning for the current month.
  db.prepare(
    `INSERT INTO provider_limits (provider, warn_usd_monthly, warned_period) VALUES (?, ?, NULL)
     ON CONFLICT(provider) DO UPDATE SET warn_usd_monthly = excluded.warn_usd_monthly, warned_period = NULL`,
  ).run(provider, warnUsdMonthly);
}

export function markProviderWarned(db: Database.Database, provider: string, period: string): void {
  db.prepare(`UPDATE provider_limits SET warned_period = ? WHERE provider = ?`).run(period, provider);
}

export function setToolCallMeta(db: Database.Database, toolCallId: string, provider: string, meta: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO tool_call_meta (tool_call_id, provider, meta) VALUES (?, ?, ?)
     ON CONFLICT(tool_call_id) DO UPDATE SET provider = excluded.provider, meta = excluded.meta`,
  ).run(toolCallId, provider, JSON.stringify(meta));
}

export function getToolCallMeta(db: Database.Database, toolCallId: string, provider: string): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT meta FROM tool_call_meta WHERE tool_call_id = ? AND provider = ?`)
    .get(toolCallId, provider) as { meta: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    return null;
  }
}

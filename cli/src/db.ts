import Database from 'better-sqlite3';
import { migrateRuns } from './runs.js';
import { migrateSearch } from './search.js';
import { isUserTurn } from './context.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

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

export function columnExists(db: Database.Database, table: string, column: string): boolean {
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
  // conversations.kind: 'chat' (user-visible) vs 'subagent' (isolated transcript of a spawn_agent run,
  // kept for the UI's run view but never listed in the sidebar).
  if (!columnExists(db, 'conversations', 'kind')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`);
  }
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

    -- Phase 3: one row per billed API response. Not FK'd to conversations on
    -- purpose: deleting a chat must not rewrite usage history.
    CREATE TABLE IF NOT EXISTS usage_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT NOT NULL,
      conversation_id TEXT,
      provider        TEXT NOT NULL,
      model           TEXT NOT NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_conv ON usage_log(conversation_id);

    -- Phase 3: provider-specific state that has no home in the
    -- message format (Gemini 3 thought signatures, DeepSeek reasoning_content),
    -- keyed by tool call id. Lets history stay in one canonical format while
    -- each adapter can still replay what its provider insists on getting back.
    CREATE TABLE IF NOT EXISTS tool_call_meta (
      tool_call_id TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      meta         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Report snapshots: the copy of a workspace file a Gazeta report was posted with, so the report never changes when the
    -- file is edited later. (Files the user wants at hand are pins of the workspace, see workspace_pins.)
    -- filename: basename only (no directory), used to construct the file URL.
    -- mime_type: e.g. 'text/markdown', 'image/png'.
    -- size_bytes: file size at save time — used for display, not a security boundary.
    -- source: 'report-pin'.
    CREATE TABLE IF NOT EXISTS artifacts (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      filename        TEXT NOT NULL,
      mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes      INTEGER NOT NULL DEFAULT 0,
      source          TEXT NOT NULL DEFAULT 'unknown',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id, created_at);

    -- Pins: files of a workspace the user (or the agent) keeps at hand. A pin is only a pointer: the file stays in the
    -- workspace, so it is always the current version. owner = a project id, or a chat id for a chat without a project.
    CREATE TABLE IF NOT EXISTS workspace_pins (
      owner      TEXT NOT NULL,
      path       TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner, path)
    );

    -- §6b Chunk B: Subagent-with-a-goal tracking.
    -- One row per subagent invocation. The parent agent spawns a subagent
    -- with a goal + tool allowlist + model; the subagent runs an isolated loop
    -- and writes its result here. The parent polls this row to get the result.
    -- Only the structured result re-enters the parent's context — the full
    -- subagent transcript is kept here for debugging but never injected into
    -- the parent's message history.
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      goal            TEXT NOT NULL,
      model           TEXT NOT NULL,
      allowed_tools   TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
      status          TEXT NOT NULL DEFAULT 'running', -- running | done | error
      result          TEXT,                          -- JSON { summary, artifacts }
      error           TEXT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_conv ON subagent_runs(conversation_id, started_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      description TEXT,
      workspace_volume TEXT,
      policy TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_repos (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      push_mode TEXT NOT NULL DEFAULT 'ask',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, owner, repo)
    );
  `);

  if (!columnExists(db, 'conversations', 'project_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);

    CREATE TABLE IF NOT EXISTS approval_grants (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      tool_label TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'always',
      subject_type TEXT,
      subject_id TEXT,
      conversation_id TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_grants_tool ON approval_grants(tool_label);
    CREATE INDEX IF NOT EXISTS idx_grants_conv ON approval_grants(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_grants_proj ON approval_grants(project_id);

    CREATE TABLE IF NOT EXISTS approval_audit (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      grant_id TEXT,
      action TEXT NOT NULL,
      tool_label TEXT NOT NULL,
      tool_args TEXT,
      conversation_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tool ON approval_audit(tool_label, created_at);
  `);

  // N6: Gazeta as the one inbox — who asked, from which run/project, and whether it's urgent.
  for (const [col, def] of [['project_id', 'TEXT'], ['run_id', 'TEXT'], ['agent', 'TEXT'], ['urgent', 'INTEGER NOT NULL DEFAULT 0'], ['attachments', 'TEXT']] as const) {
    if (!columnExists(db, 'gazeta_items', col)) db.exec(`ALTER TABLE gazeta_items ADD COLUMN ${col} ${def}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_state (
      conversation_id   TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      mode              TEXT NOT NULL DEFAULT 'normal',
      effort            TEXT,
      todos             TEXT NOT NULL DEFAULT '[]',
      last_input_tokens INTEGER
    );
  `);
  migrateRuns(db);
  migrateSearch(db);

  // Seed default settings
  const seedSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  // Empty = automatic (a usable free model, else any chat model); the `chat` model slot in Settings sets it.
  seedSetting.run('default_model', '');
  seedSetting.run('custom_instructions', '');

  applyVersionedMigrations(db);
}

// ─── Versioned migrations ────────────────────────────────────────────────────
// Everything above is the baseline: idempotent "create if missing" statements that predate versioning and run on
// every start. From here on a schema change is a numbered entry in MIGRATIONS, applied exactly once, in order, each in
// its own transaction, and recorded in `PRAGMA user_version`. Never edit or reorder an entry that has shipped — add a
// new one. A database stamped by a NEWER build than this one is refused instead of being silently misread.

export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'ghost mode: immutable flag on chats and projects, ghost-aware inbox',
    up: db => {
      for (const table of ['conversations', 'projects', 'gazeta_items'] as const) {
        if (!columnExists(db, table, 'ghost')) db.exec(`ALTER TABLE ${table} ADD COLUMN ghost INTEGER NOT NULL DEFAULT 0`);
      }
      // The flag is the privacy boundary of a chat, so it is enforced by the database itself, not only by the API:
      // no UPDATE statement from anywhere in the code base can flip it in either direction.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS conversations_ghost_immutable BEFORE UPDATE OF ghost ON conversations
        WHEN OLD.ghost IS NOT NEW.ghost
        BEGIN SELECT RAISE(ABORT, 'ghost_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS projects_ghost_immutable BEFORE UPDATE OF ghost ON projects
        WHEN OLD.ghost IS NOT NEW.ghost
        BEGIN SELECT RAISE(ABORT, 'ghost_immutable'); END;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;

export function schemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function applyVersionedMigrations(db: Database.Database): void {
  const current = schemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`The database is at schema version ${current}, newer than this build understands (${LATEST_SCHEMA_VERSION}). Update EverythingApp, or restore a backup made before the upgrade.`);
  }
  const pending = MIGRATIONS.filter(m => m.id > current);
  if (pending.length === 0) return;
  // A file-backed database that already holds data gets a safety copy before its first pending migration runs.
  const file = db.name;
  if (current > 0 || hasUserData(db)) snapshotBeforeMigration(db, file, current);
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.id}`);
    })();
  }
}

function hasUserData(db: Database.Database): boolean {
  return (db.prepare(`SELECT EXISTS(SELECT 1 FROM conversations) OR EXISTS(SELECT 1 FROM projects) AS n`).get() as { n: number }).n === 1;
}

/** `<db>.pre-v<version>.bak` via VACUUM INTO (a consistent copy even in WAL mode). Best effort: never blocks startup. */
function snapshotBeforeMigration(db: Database.Database, file: string, version: number): void {
  if (!file || file === ':memory:' || !existsSync(file)) return;
  const target = `${file}.pre-v${version}.bak`;
  if (existsSync(target)) return; // one safety copy per version step is enough
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (err) {
    console.warn(`[db] could not write the pre-migration backup ${target}: ${(err as Error).message}`);
  }
}

// ─── Conversations ───────────────────────────────────────────────────────────

export interface ConversationRow {
  id: string;
  projectId: string | null;
  title: string;
  systemPrompt: string | null;
  model: string | null;
  /** Ghost chat: its own flag or its project's. Immutable (see MIGRATIONS[0] and ghost.ts). */
  ghost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListItem {
  id: string;
  projectId: string | null;
  title: string;
  updatedAt: string;
  messageCount: number;
  ghost: boolean;
}

/** Raised for a change the Ghost-mode rules forbid; `code` is what the API returns to the client. */
export class GhostRuleError extends Error {
  constructor(readonly code: 'ghost_immutable' | 'ghost_move', message: string) { super(message); this.name = 'GhostRuleError'; }
}

export function createConversation(
  db: Database.Database,
  opts: { title?: string; projectId?: string; systemPrompt?: string; model?: string; kind?: 'chat' | 'subagent'; ghost?: boolean } = {},
): { id: string } {
  // A chat inside a ghost project is a ghost chat — the flag is stored on the row too, so it never depends on a join.
  const ghost = opts.ghost === true || (opts.projectId ? isGhostProject(db, opts.projectId) : false);
  const stmt = db.prepare(`
    INSERT INTO conversations (title, project_id, system_prompt, model, kind, ghost)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const row = stmt.get(
    opts.title ?? 'New conversation',
    opts.projectId ?? null,
    opts.systemPrompt ?? null,
    opts.model ?? null,
    opts.kind ?? 'chat',
    ghost ? 1 : 0,
  ) as { id: string };
  return { id: row.id };
}

export function listConversations(db: Database.Database): ConversationListItem[] {
  return (
    db
      .prepare(
        `SELECT c.id, c.project_id as projectId, c.title, c.updated_at as updatedAt, c.ghost as ghost,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as messageCount
         FROM conversations c
         WHERE c.kind = 'chat'
         ORDER BY c.updated_at DESC`,
      )
      .all() as Array<Omit<ConversationListItem, 'ghost'> & { ghost: number }>
  ).map(r => ({ ...r, ghost: r.ghost === 1 }));
}

export function getConversation(db: Database.Database, id: string): ConversationRow | null {
  const row = db
    .prepare(
      `SELECT c.id, c.project_id as projectId, c.title, c.system_prompt as systemPrompt, c.model,
              c.created_at as createdAt, c.updated_at as updatedAt,
              (c.ghost = 1 OR COALESCE((SELECT p.ghost FROM projects p WHERE p.id = c.project_id), 0) = 1) as ghost
       FROM conversations c WHERE c.id = ?`,
    )
    .get(id) as ({ id: string; projectId: string | null; title: string; systemPrompt: string | null; model: string | null; ghost: number; createdAt: string; updatedAt: string }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    systemPrompt: row.systemPrompt,
    model: row.model,
    ghost: row.ghost === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** True for a ghost chat (own flag or ghost project); also for the agent transcripts that belong to one. */
export function isGhostConversation(db: Database.Database, id: string | null | undefined): boolean {
  if (!id) return false;
  return getConversation(db, id)?.ghost === true;
}

export function isGhostProject(db: Database.Database, id: string | null | undefined): boolean {
  if (!id) return false;
  return (db.prepare(`SELECT ghost FROM projects WHERE id = ?`).get(id) as { ghost: number } | undefined)?.ghost === 1;
}

export function updateConversation(
  db: Database.Database,
  id: string,
  patch: { title?: string; projectId?: string | null; systemPrompt?: string | null; model?: string | null },
): boolean {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
  if (patch.projectId !== undefined) {
    // Ghost chats never change project; no chat moves INTO a ghost project (it would inherit the flag from its project
    // while its history was written under looser rules).
    const cur = db.prepare(`SELECT project_id as projectId, ghost FROM conversations WHERE id = ?`).get(id) as { projectId: string | null; ghost: number } | undefined;
    if (cur && cur.projectId !== patch.projectId) {
      if (cur.ghost === 1 || isGhostProject(db, cur.projectId)) throw new GhostRuleError('ghost_move', 'A ghost chat cannot be moved out of its place.');
      if (isGhostProject(db, patch.projectId)) throw new GhostRuleError('ghost_move', 'A chat cannot be moved into a ghost project — start a new chat there.');
    }
    sets.push('project_id = ?'); values.push(patch.projectId);
  }
  if (patch.systemPrompt !== undefined) { sets.push('system_prompt = ?'); values.push(patch.systemPrompt); }
  if (patch.model !== undefined) { sets.push('model = ?'); values.push(patch.model); }
  if (sets.length === 1) return false;
  values.push(id);
  const result = db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteConversation(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  if (result.changes > 0) db.prepare(`DELETE FROM workspace_pins WHERE owner = ?`).run(id);
  return result.changes > 0;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface MessageParam {
  /** Present from getMessages(); a bare type-cast to Llm.MessageParam[] elsewhere in
   * the codebase ignores it, and sanitizeHistory() in llm-loop.ts strips it before any
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

// ─── Compaction view ─────────────────────────────────────────────────────────
// A compaction is a row with role 'summary' and content { text, upTo }: every message with id <= upTo is replaced,
// for the model, by that text. The UI still lists the originals (getMessages returns them and the summary row).

export interface SummaryContent { text: string; upTo: number; replaced: number }

export interface LlmHistory {
  /** The active summary's text, if the history was compacted. */
  summary: string | null;
  /** Messages the model sees verbatim (id included, summary rows excluded). */
  rows: Array<{ id: number; role: 'user' | 'assistant'; content: unknown }>;
}

/**
 * What a turn starts from: the latest summary plus every active message after the part it replaces.
 * `beforeId` stops short of the user message that is about to be sent (it is added by the loop itself).
 */
export function loadLlmHistory(db: Database.Database, conversationId: string, beforeId?: number): LlmHistory {
  const all = db
    .prepare(`SELECT id, role, content FROM messages WHERE conversation_id = ? AND is_active = 1 ORDER BY id ASC`)
    .all(conversationId) as Array<{ id: number; role: string; content: string }>;
  let summary: SummaryContent | null = null;
  for (const r of all) {
    if (r.role !== 'summary') continue;
    const c = JSON.parse(r.content) as SummaryContent;
    if (beforeId === undefined || c.upTo < beforeId) summary = c;
  }
  const rows = all
    .filter(r => r.role !== 'summary' && (!summary || r.id > summary.upTo) && (beforeId === undefined || r.id < beforeId))
    .map(r => ({ id: r.id, role: r.role as 'user' | 'assistant', content: JSON.parse(r.content) as unknown }));
  return { summary: summary?.text ?? null, rows };
}

export function appendSummary(db: Database.Database, conversationId: string, content: SummaryContent): number {
  return appendMessage(db, conversationId, 'summary', content, null);
}

// ─── Conversation state (reasoning effort, todo list, last measured context size) ──────

export type ReasoningEffort = 'low' | 'medium' | 'high';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem { content: string; status: TodoStatus }

export interface ConversationState {
  effort: ReasoningEffort | null;
  todos: TodoItem[];
  lastInputTokens: number | null;
}

export function getConversationState(db: Database.Database, conversationId: string): ConversationState {
  const r = db
    .prepare(`SELECT effort, todos, last_input_tokens as lastInputTokens FROM conversation_state WHERE conversation_id = ?`)
    .get(conversationId) as { effort: string | null; todos: string; lastInputTokens: number | null } | undefined;
  if (!r) return { effort: null, todos: [], lastInputTokens: null };
  let todos: TodoItem[] = [];
  try { todos = JSON.parse(r.todos) as TodoItem[]; } catch { /* keep empty */ }
  return {
    effort: (REASONING_EFFORTS as readonly string[]).includes(r.effort ?? '') ? (r.effort as ReasoningEffort) : null,
    todos,
    lastInputTokens: r.lastInputTokens,
  };
}

export function setConversationState(db: Database.Database, conversationId: string, patch: Partial<ConversationState>): ConversationState {
  const cur = getConversationState(db, conversationId);
  const next: ConversationState = { ...cur, ...patch };
  db.prepare(
    `INSERT INTO conversation_state (conversation_id, effort, todos, last_input_tokens) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET effort = excluded.effort, todos = excluded.todos, last_input_tokens = excluded.last_input_tokens`,
  ).run(conversationId, next.effort, JSON.stringify(next.todos), next.lastInputTokens);
  return next;
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
/**
 * A summary row that only covers messages BEFORE the cut point is still true after the cut (it may have been written
 * after the message being replaced, hence its higher id) — so retiring/deleting "from here" leaves it alone.
 */
const SPARED_SUMMARY = `role = 'summary' AND json_extract(content, '$.upTo') < ?`;

export function deleteMessagesFrom(db: Database.Database, conversationId: string, fromMessageId: number): boolean {
  const result = db
    .prepare(`DELETE FROM messages WHERE conversation_id = ? AND id >= ? AND NOT (${SPARED_SUMMARY})`)
    .run(conversationId, fromMessageId, fromMessageId);
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
  return result.changes > 0;
}

/**
 * Soft-deletes: marks a message and everything currently active after it as
 * inactive, without deleting rows — used by edit/regenerate to retire the
 * old branch while keeping it around for potential future branch-history UI.
 */
export function deactivateMessagesFrom(db: Database.Database, conversationId: string, fromMessageId: number): void {
  db.prepare(`UPDATE messages SET is_active = 0 WHERE conversation_id = ? AND id >= ? AND is_active = 1 AND NOT (${SPARED_SUMMARY})`).run(
    conversationId,
    fromMessageId,
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
 * tool-loop round trip per llm-loop.ts), so "the message right before
 * this one" isn't necessarily the user turn that started it — pass null for
 * fromId to search from the end of the conversation (used by retry).
 */
export function findRegenerationAnchor(
  db: Database.Database,
  conversationId: string,
  fromId: number | null,
): { id: number; content: unknown; parentId: number | null } | null {
  // Rows with role 'user' also carry tool results, and a turn that was killed leaves such a row at its end:
  // the anchor must be a message the person typed.
  const rows = db
    .prepare(
      `SELECT id, content, parent_id as parentId FROM messages
       WHERE conversation_id = ? AND is_active = 1 AND role = 'user' AND (? IS NULL OR id <= ?)
       ORDER BY id DESC`,
    )
    .iterate(conversationId, fromId, fromId) as Iterable<{ id: number; content: string; parentId: number | null }>;
  for (const row of rows) {
    const content = JSON.parse(row.content) as unknown;
    if (isUserTurn({ role: 'user', content })) return { id: row.id, content, parentId: row.parentId };
  }
  return null;
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
  projectId: string | null;
  runId: string | null;
  /** Who asked: "assistant" for the chat agent, or a worker's label. */
  agent: string | null;
  urgent: boolean;
  /** Report pins: [{ path, sha256, artifactId? }] snapshots. */
  attachments: unknown[] | null;
  /** Came from a ghost chat or project: never summarised by a model, never shown in a notification. */
  ghost: boolean;
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
  item: {
    type: string; conversationId?: string; title: string; description?: string; inputSchema?: unknown;
    projectId?: string | null; runId?: string | null; agent?: string | null; urgent?: boolean; attachments?: unknown[];
  },
): string {
  const ghost = isGhostConversation(db, item.conversationId) || isGhostProject(db, item.projectId);
  const row = db
    .prepare(
      `INSERT INTO gazeta_items (type, conversation_id, title, description, input_schema, project_id, run_id, agent, urgent, attachments, ghost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      item.type,
      item.conversationId ?? null,
      item.title,
      item.description ?? null,
      item.inputSchema !== undefined ? JSON.stringify(item.inputSchema) : null,
      item.projectId ?? null,
      item.runId ?? null,
      item.agent ?? null,
      item.urgent ? 1 : 0,
      item.attachments ? JSON.stringify(item.attachments) : null,
      ghost ? 1 : 0,
    ) as { id: string };
  return row.id;
}

export function listGazetaItems(
  db: Database.Database,
  status?: string,
  filter: { conversationId?: string; projectId?: string; type?: string; agent?: string; limit?: number; before?: string } = {},
): GazetaItem[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (filter.conversationId) { where.push('conversation_id = ?'); args.push(filter.conversationId); }
  if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId); }
  if (filter.type) { where.push('type = ?'); args.push(filter.type); }
  if (filter.agent) { where.push('agent = ?'); args.push(filter.agent); }
  if (filter.before) { where.push('created_at < ?'); args.push(filter.before); }
  // Urgent open items are pinned on top; everything else newest first.
  const sql = `SELECT * FROM gazeta_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (urgent = 1 AND status = 'pending') DESC, created_at DESC, rowid DESC ${filter.limit ? 'LIMIT ' + Math.floor(filter.limit) : ''}`;
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: r['id'] as string,
    type: r['type'] as string,
    conversationId: r['conversation_id'] as string | null,
    projectId: (r['project_id'] as string | null) ?? null,
    runId: (r['run_id'] as string | null) ?? null,
    agent: (r['agent'] as string | null) ?? null,
    urgent: r['urgent'] === 1,
    attachments: r['attachments'] ? JSON.parse(r['attachments'] as string) : null,
    ghost: r['ghost'] === 1,
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

export function getGazetaItem(db: Database.Database, id: string): GazetaItem | null {
  const row = db.prepare(`SELECT created_at FROM gazeta_items WHERE id = ?`).get(id) as { created_at: string } | undefined;
  if (!row) return null;
  return listGazetaItems(db).find(i => i.id === id) ?? null;
}

export function expireGazetaItem(db: Database.Database, id: string): boolean {
  return db.prepare(`UPDATE gazeta_items SET status = 'expired' WHERE id = ? AND status = 'pending'`).run(id).changes > 0;
}

export function dismissGazetaItem(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(`UPDATE gazeta_items SET status = 'dismissed' WHERE id = ?`)
    .run(id);
  return result.changes > 0;
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

// ─── Projects ────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  workspaceVolume: string | null;
  policy: Record<string, unknown>;
  /** Ghost project: every chat in it is a ghost chat. Fixed at creation. */
  ghost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  description: string | null;
  ghost: boolean;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
}

export function createProject(
  db: Database.Database,
  opts: { name: string; description?: string; ghost?: boolean },
): ProjectRow {
  const row = db.prepare(`
    INSERT INTO projects (name, description, ghost)
    VALUES (?, ?, ?)
    RETURNING *
  `).get(opts.name, opts.description ?? null, opts.ghost ? 1 : 0) as Record<string, unknown>;
  return rowToProject(row);
}

function rowToProject(row: Record<string, unknown>): ProjectRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | null,
    workspaceVolume: row['workspace_volume'] as string | null,
    policy: JSON.parse(row['policy'] as string),
    ghost: row['ghost'] === 1,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function listProjects(db: Database.Database): ProjectListItem[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.created_at as createdAt, p.updated_at as updatedAt, p.ghost as ghost,
           (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) as conversationCount
    FROM projects p
    ORDER BY p.updated_at DESC
  `).all() as Array<{ id: string; name: string; description: string | null; createdAt: string; updatedAt: string; ghost: number; conversationCount: number }>;
  return rows.map(r => ({ ...r, ghost: r.ghost === 1 }));
}

export function getProject(db: Database.Database, id: string): ProjectRow | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

export function updateProject(
  db: Database.Database,
  id: string,
  patch: { name?: string; description?: string; policy?: Record<string, unknown> },
): boolean {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
  if (patch.policy !== undefined) { sets.push('policy = ?'); values.push(JSON.stringify(patch.policy)); }
  
  if (sets.length === 1) return false;
  values.push(id);
  const result = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

/**
 * Removes a project. By default its conversations go with it (messages, agent transcripts and runs cascade);
 * `conversations: 'keep'` detaches them into plain quick chats instead. Sandbox workspace files on the Pi
 * are never touched — they outlive the project record by design.
 */
export function deleteProject(db: Database.Database, id: string, opts: { conversations?: 'delete' | 'keep' } = {}): boolean {
  const run = db.transaction(() => {
    if ((opts.conversations ?? 'delete') === 'delete') {
      db.prepare(`DELETE FROM conversations WHERE project_id = ?`).run(id);
    }
    const removed = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
    if (removed) db.prepare(`DELETE FROM workspace_pins WHERE owner = ?`).run(id);
    return removed;
  });
  return run();
}

/** Ids of every conversation (chats and agent transcripts) that belongs to a project. */
export function listProjectConversationIds(db: Database.Database, projectId: string): string[] {
  return (db.prepare(`SELECT id FROM conversations WHERE project_id = ?`).all(projectId) as Array<{ id: string }>).map(r => r.id);
}

export function listProjectConversations(db: Database.Database, projectId: string): ConversationListItem[] {
  return db.prepare(`
    SELECT c.id, c.project_id as projectId, c.title, c.updated_at as updatedAt, c.ghost as ghost,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as messageCount
    FROM conversations c
    WHERE c.project_id = ? AND c.kind = 'chat'
    ORDER BY c.updated_at DESC
  `).all(projectId).map(r => ({ ...(r as Omit<ConversationListItem, 'ghost'> & { ghost: number }), ghost: (r as { ghost: number }).ghost === 1 }));
}

// ─── Approval Grants ──────────────────────────────────────────────────────────

export interface ApprovalGrantRow {
  id: string;
  toolLabel: string;
  scope: 'chat' | 'project' | 'always';
  subjectType: 'model' | 'skill' | null;
  subjectId: string | null;
  conversationId: string | null;
  projectId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export function createApprovalGrant(
  db: Database.Database,
  grant: Omit<ApprovalGrantRow, 'id' | 'createdAt'>,
): ApprovalGrantRow {
  const row = db.prepare(`
    INSERT INTO approval_grants (tool_label, scope, subject_type, subject_id, conversation_id, project_id, expires_at)
    VALUES (@toolLabel, @scope, @subjectType, @subjectId, @conversationId, @projectId, @expiresAt)
    RETURNING *
  `).get(grant) as Record<string, unknown>;
  return {
    id: row.id as string,
    toolLabel: row.tool_label as string,
    scope: row.scope as 'chat' | 'project' | 'always',
    subjectType: row.subject_type as 'model' | 'skill' | null,
    subjectId: row.subject_id as string | null,
    conversationId: row.conversation_id as string | null,
    projectId: row.project_id as string | null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string | null,
  };
}

export function listApprovalGrants(
  db: Database.Database,
  filter?: { conversationId?: string; projectId?: string; scope?: string; toolLabel?: string },
): ApprovalGrantRow[] {
  let sql = `SELECT * FROM approval_grants`;
  const conditions: string[] = [];
  const values: string[] = [];
  
  if (filter?.conversationId) { conditions.push('conversation_id = ?'); values.push(filter.conversationId); }
  if (filter?.projectId) { conditions.push('project_id = ?'); values.push(filter.projectId); }
  if (filter?.scope) { conditions.push('scope = ?'); values.push(filter.scope); }
  if (filter?.toolLabel) { conditions.push('tool_label = ?'); values.push(filter.toolLabel); }
  
  if (conditions.length > 0) sql += ` WHERE ` + conditions.join(' AND ');
  sql += ` ORDER BY created_at DESC`;
  
  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  return rows.map(row => ({
    id: row.id as string,
    toolLabel: row.tool_label as string,
    scope: row.scope as 'chat' | 'project' | 'always',
    subjectType: row.subject_type as 'model' | 'skill' | null,
    subjectId: row.subject_id as string | null,
    conversationId: row.conversation_id as string | null,
    projectId: row.project_id as string | null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string | null,
  }));
}

export function deleteApprovalGrant(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM approval_grants WHERE id = ?`).run(id).changes > 0;
}

export function findMatchingGrant(
  db: Database.Database,
  toolLabel: string,
  opts?: { conversationId?: string; projectId?: string; modelId?: string; skillId?: string }
): ApprovalGrantRow | null {
  const grants = listApprovalGrants(db, { toolLabel });
  
  for (const grant of grants) {
    if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) continue;
    
    let matches = false;
    if (grant.scope === 'always') matches = true;
    else if (grant.scope === 'project' && grant.projectId === opts?.projectId) matches = true;
    else if (grant.scope === 'chat' && grant.conversationId === opts?.conversationId) matches = true;
    
    if (matches) {
      if (grant.subjectType === 'model' && grant.subjectId !== opts?.modelId) matches = false;
      if (grant.subjectType === 'skill' && grant.subjectId !== opts?.skillId) matches = false;
    }
    
    if (matches) return grant;
  }
  return null;
}

/** Prefix of the grant label for "this chat/project/everywhere may open this domain" (web_fetch and the browser). */
export const WEB_GRANT_PREFIX = 'web:';

/**
 * Domains the user has allowed for this conversation (scopes chat / project / always, same matching as findMatchingGrant).
 * Handed to the browser as its allowlist on every call, so revoking a grant takes effect on the next action.
 */
export function listGrantedWebHosts(
  db: Database.Database,
  opts: { conversationId?: string; projectId?: string; modelId?: string; skillId?: string },
): string[] {
  const rows = db.prepare(`SELECT * FROM approval_grants WHERE tool_label LIKE 'web:%'`).all() as Record<string, unknown>[];
  const hosts = new Set<string>();
  const nowMs = Date.now();
  for (const row of rows) {
    const expires = row.expires_at as string | null;
    if (expires && new Date(expires).getTime() < nowMs) continue;
    const scope = row.scope as string;
    const matches =
      scope === 'always' ||
      (scope === 'project' && opts.projectId !== undefined && row.project_id === opts.projectId) ||
      (scope === 'chat' && opts.conversationId !== undefined && row.conversation_id === opts.conversationId);
    if (!matches) continue;
    if (row.subject_type === 'model' && row.subject_id !== opts.modelId) continue;
    if (row.subject_type === 'skill' && row.subject_id !== opts.skillId) continue;
    const host = (row.tool_label as string).slice(WEB_GRANT_PREFIX.length).trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts].sort();
}

/** Tokens and passwords that end up in a command line must not be copied into the audit trail. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"'\\]+/gi, '$1[redacted]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted]')
    .replace(/((?:pass(?:word|wd)?|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&\\]{3,}/gi, '$1[redacted]')
    .replace(/(:\/\/[^\s:@/]+:)[^\s@/]+(@)/g, '$1[redacted]$2');
}

export function logApprovalAudit(
  db: Database.Database,
  entry: { grantId?: string; action: string; toolLabel: string; toolArgs?: string; conversationId?: string; runId?: string },
): void {
  db.prepare(`
    INSERT INTO approval_audit (grant_id, action, tool_label, tool_args, conversation_id, run_id)
    VALUES (@grantId, @action, @toolLabel, @toolArgs, @conversationId, @runId)
  `).run({
    grantId: entry.grantId ?? null,
    action: entry.action,
    toolLabel: entry.toolLabel,
    toolArgs: entry.toolArgs === undefined ? null : redactSecrets(entry.toolArgs).slice(0, 8000),
    conversationId: entry.conversationId ?? null,
    runId: entry.runId ?? null,
  });
}

// ─── Phase 3: provider keys / usage / tool-call meta ────────────────

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

// ─── Report snapshots (the `artifacts` table) ─────────────────────────────────

export interface ArtifactRow {
  id: string;
  conversationId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  createdAt: string;
}

export function createArtifact(
  db: Database.Database,
  row: Omit<ArtifactRow, 'id' | 'createdAt'>,
): ArtifactRow {
  const result = db
    .prepare(
      `INSERT INTO artifacts (conversation_id, filename, mime_type, size_bytes, source)
       VALUES (@conversationId, @filename, @mimeType, @sizeBytes, @source)
       RETURNING id, conversation_id AS conversationId, filename, mime_type AS mimeType,
                 size_bytes AS sizeBytes, source, created_at AS createdAt`,
    )
    .get(row) as ArtifactRow;
  return result;
}

export function getArtifact(db: Database.Database, id: string): ArtifactRow | null {
  return (
    db
      .prepare(
        `SELECT id, conversation_id AS conversationId, filename, mime_type AS mimeType,
                size_bytes AS sizeBytes, source, created_at AS createdAt
         FROM artifacts WHERE id = ?`,
      )
      .get(id) as ArtifactRow | undefined
  ) ?? null;
}

// ─── Workspace pins ──────────────────────────────────────────────────────────

export interface WorkspacePin { path: string; note: string | null; createdAt: string }

export function listPins(db: Database.Database, owner: string): WorkspacePin[] {
  return db.prepare(`SELECT path, note, created_at AS createdAt FROM workspace_pins WHERE owner = ? ORDER BY created_at DESC, path`).all(owner) as WorkspacePin[];
}

/** Pins a path (already normalised by resolveWorkspacePath); pinning twice only updates the note. */
export function addPin(db: Database.Database, owner: string, path: string, note?: string | null): WorkspacePin {
  return db.prepare(
    `INSERT INTO workspace_pins (owner, path, note) VALUES (?, ?, ?)
     ON CONFLICT(owner, path) DO UPDATE SET note = COALESCE(excluded.note, workspace_pins.note)
     RETURNING path, note, created_at AS createdAt`,
  ).get(owner, path, note ? note.slice(0, 300) : null) as WorkspacePin;
}

export function removePin(db: Database.Database, owner: string, path: string): boolean {
  return db.prepare(`DELETE FROM workspace_pins WHERE owner = ? AND path = ?`).run(owner, path).changes > 0;
}

// ─── §6b Chunk B: Subagent runs ──────────────────────────────────────────────

export interface SubagentRunRow {
  id: string;
  conversationId: string;
  goal: string;
  model: string;
  allowedTools: string[]; // parsed from JSON
  status: 'running' | 'done' | 'error';
  result: { summary: string; artifactIds: string[] } | null; // parsed from JSON
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function createSubagentRun(
  db: Database.Database,
  opts: { conversationId: string; goal: string; model: string; allowedTools: string[] },
): SubagentRunRow {
  const row = db
    .prepare(
      `INSERT INTO subagent_runs (conversation_id, goal, model, allowed_tools)
       VALUES (@conversationId, @goal, @model, @allowedTools)
       RETURNING id, conversation_id AS conversationId, goal, model,
                 allowed_tools AS allowedToolsJson, status, result, error,
                 started_at AS startedAt, finished_at AS finishedAt`,
    )
    .get({ ...opts, allowedTools: JSON.stringify(opts.allowedTools) }) as {
      id: string; conversationId: string; goal: string; model: string;
      allowedToolsJson: string; status: 'running'; result: null; error: null;
      startedAt: string; finishedAt: null;
    };
  return { ...row, allowedTools: JSON.parse(row.allowedToolsJson), result: null };
}

export function resolveSubagentRun(
  db: Database.Database,
  id: string,
  result: { summary: string; artifactIds: string[] },
): void {
  db.prepare(
    `UPDATE subagent_runs SET status = 'done', result = ?, finished_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(result), id);
}

export function failSubagentRun(db: Database.Database, id: string, error: string): void {
  db.prepare(
    `UPDATE subagent_runs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?`,
  ).run(error, id);
}

export function getSubagentRun(db: Database.Database, id: string): SubagentRunRow | null {
  const row = db
    .prepare(
      `SELECT id, conversation_id AS conversationId, goal, model,
              allowed_tools AS allowedToolsJson, status,
              result AS resultJson, error, started_at AS startedAt, finished_at AS finishedAt
       FROM subagent_runs WHERE id = ?`,
    )
    .get(id) as {
      id: string; conversationId: string; goal: string; model: string;
      allowedToolsJson: string; status: 'running' | 'done' | 'error';
      resultJson: string | null; error: string | null; startedAt: string; finishedAt: string | null;
    } | undefined;
  if (!row) return null;
  return {
    ...row,
    allowedTools: JSON.parse(row.allowedToolsJson),
    result: row.resultJson ? JSON.parse(row.resultJson) as { summary: string; artifactIds: string[] } : null,
  };
}

export function listSubagentRuns(db: Database.Database, conversationId: string): SubagentRunRow[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id AS conversationId, goal, model,
              allowed_tools AS allowedToolsJson, status,
              result AS resultJson, error, started_at AS startedAt, finished_at AS finishedAt
       FROM subagent_runs WHERE conversation_id = ? ORDER BY started_at DESC`,
    )
    .all(conversationId) as Array<{
      id: string; conversationId: string; goal: string; model: string;
      allowedToolsJson: string; status: 'running' | 'done' | 'error';
      resultJson: string | null; error: string | null; startedAt: string; finishedAt: string | null;
    }>;
  return rows.map(r => ({
    ...r,
    allowedTools: JSON.parse(r.allowedToolsJson),
    result: r.resultJson ? JSON.parse(r.resultJson) as { summary: string; artifactIds: string[] } : null,
  }));
}


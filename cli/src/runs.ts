import type Database from 'better-sqlite3';

/**
 * Durable runs (Plan v3 N6/N7). A run is one agent working on one goal: every live chat turn is a
 * root run, and Agents-lite workers are child runs. Rows survive restarts; v1 does not resume them —
 * anything still active at startup is marked `interrupted` (heartbeat_at shows when it last lived).
 */

export type RunStatus = 'running' | 'waiting_input' | 'waiting_children' | 'done' | 'error' | 'aborted' | 'interrupted';
export const ACTIVE_STATUSES: RunStatus[] = ['running', 'waiting_input', 'waiting_children'];

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunRow {
  id: string;
  parentRunId: string | null;
  rootRunId: string;
  projectId: string | null;
  /** The user-facing chat the run tree belongs to (root's conversation). */
  conversationId: string | null;
  /** Worker transcript (kind = 'subagent' conversation); null for root runs. */
  transcriptConversationId: string | null;
  label: string;
  model: string;
  goal: string;
  tools: string[];
  depth: number;
  status: RunStatus;
  result: string | null;
  error: string | null;
  usage: RunUsage;
  heartbeatAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunMessage {
  id: number;
  runId: string;
  fromRunId: string | null;
  fromLabel: string;
  body: string;
  createdAt: string;
}

export function migrateRuns(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id                         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      parent_run_id              TEXT REFERENCES runs(id) ON DELETE CASCADE,
      root_run_id                TEXT,
      project_id                 TEXT REFERENCES projects(id) ON DELETE SET NULL,
      conversation_id            TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      transcript_conversation_id TEXT,
      label                      TEXT NOT NULL DEFAULT 'agent',
      model                      TEXT NOT NULL,
      goal                       TEXT NOT NULL,
      tools                      TEXT NOT NULL DEFAULT '[]',
      depth                      INTEGER NOT NULL DEFAULT 0,
      status                     TEXT NOT NULL DEFAULT 'running',
      result                     TEXT,
      error                      TEXT,
      usage                      TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"costUsd":0}',
      heartbeat_at               TEXT,
      created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_root ON runs(root_run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

    CREATE TABLE IF NOT EXISTS run_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      from_run_id TEXT,
      from_label  TEXT NOT NULL,
      body        TEXT NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_run_messages ON run_messages(run_id, delivered);
  `);
}

function toRow(r: Record<string, unknown>): RunRow {
  return {
    id: r['id'] as string,
    parentRunId: (r['parent_run_id'] as string | null) ?? null,
    rootRunId: (r['root_run_id'] as string | null) ?? (r['id'] as string),
    projectId: (r['project_id'] as string | null) ?? null,
    conversationId: (r['conversation_id'] as string | null) ?? null,
    transcriptConversationId: (r['transcript_conversation_id'] as string | null) ?? null,
    label: r['label'] as string,
    model: r['model'] as string,
    goal: r['goal'] as string,
    tools: JSON.parse(r['tools'] as string) as string[],
    depth: r['depth'] as number,
    status: r['status'] as RunStatus,
    result: (r['result'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    usage: JSON.parse(r['usage'] as string) as RunUsage,
    heartbeatAt: (r['heartbeat_at'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
    finishedAt: (r['finished_at'] as string | null) ?? null,
  };
}

export function createRun(
  db: Database.Database,
  opts: {
    parentRunId?: string | null;
    rootRunId?: string | null;
    projectId?: string | null;
    conversationId?: string | null;
    transcriptConversationId?: string | null;
    label?: string;
    model: string;
    goal: string;
    tools?: string[];
    depth?: number;
  },
): RunRow {
  const row = db.prepare(`
    INSERT INTO runs (parent_run_id, root_run_id, project_id, conversation_id, transcript_conversation_id, label, model, goal, tools, depth, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    RETURNING *
  `).get(
    opts.parentRunId ?? null,
    opts.rootRunId ?? null,
    opts.projectId ?? null,
    opts.conversationId ?? null,
    opts.transcriptConversationId ?? null,
    opts.label ?? 'agent',
    opts.model,
    opts.goal.slice(0, 4000),
    JSON.stringify(opts.tools ?? []),
    opts.depth ?? 0,
  ) as Record<string, unknown>;
  if (!opts.rootRunId) {
    db.prepare(`UPDATE runs SET root_run_id = id WHERE id = ?`).run(row['id']);
    row['root_run_id'] = row['id'];
  }
  return toRow(row);
}

export function getRun(db: Database.Database, id: string): RunRow | null {
  const r = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? toRow(r) : null;
}

export function listRuns(db: Database.Database, filter: { rootRunId?: string; conversationId?: string; parentRunId?: string; limit?: number }): RunRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.rootRunId) { where.push('root_run_id = ?'); args.push(filter.rootRunId); }
  if (filter.conversationId) { where.push('conversation_id = ?'); args.push(filter.conversationId); }
  if (filter.parentRunId) { where.push('parent_run_id = ?'); args.push(filter.parentRunId); }
  const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, filter.limit ?? 200) as Record<string, unknown>[]).map(toRow);
}

export function setRunStatus(db: Database.Database, id: string, status: RunStatus, extra?: { result?: string; error?: string }): void {
  const finished = !ACTIVE_STATUSES.includes(status);
  db.prepare(`
    UPDATE runs SET status = ?, result = COALESCE(?, result), error = COALESCE(?, error),
      finished_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE finished_at END,
      heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(status, extra?.result ?? null, extra?.error ?? null, finished ? 1 : 0, id);
}

export function heartbeatRun(db: Database.Database, id: string): void {
  db.prepare(`UPDATE runs SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
}

export function addRunUsage(db: Database.Database, id: string, delta: RunUsage): RunUsage {
  const run = getRun(db, id);
  if (!run) return delta;
  const usage = {
    inputTokens: run.usage.inputTokens + delta.inputTokens,
    outputTokens: run.usage.outputTokens + delta.outputTokens,
    costUsd: run.usage.costUsd + delta.costUsd,
  };
  db.prepare(`UPDATE runs SET usage = ? WHERE id = ?`).run(JSON.stringify(usage), id);
  return usage;
}

/** Sum of usage across a whole run tree (for the per-tree budget). */
export function treeUsage(db: Database.Database, rootRunId: string): RunUsage {
  const rows = db.prepare(`SELECT usage FROM runs WHERE root_run_id = ?`).all(rootRunId) as Array<{ usage: string }>;
  return rows.reduce<RunUsage>((acc, r) => {
    const u = JSON.parse(r.usage) as RunUsage;
    return { inputTokens: acc.inputTokens + u.inputTokens, outputTokens: acc.outputTokens + u.outputTokens, costUsd: acc.costUsd + u.costUsd };
  }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

export function countTreeRuns(db: Database.Database, rootRunId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE root_run_id = ? AND id != ?`).get(rootRunId, rootRunId) as { n: number }).n;
}

/** Startup: v1 has no resume — every run that was alive when the process died becomes `interrupted`. */
export function interruptOrphanedRuns(db: Database.Database): number {
  return db.prepare(`
    UPDATE runs SET status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      error = COALESCE(error, 'server restarted while the run was active')
    WHERE status IN ('running', 'waiting_input', 'waiting_children')
  `).run().changes;
}

export function postRunMessage(db: Database.Database, msg: { runId: string; fromRunId: string | null; fromLabel: string; body: string }): number {
  return Number(db.prepare(`INSERT INTO run_messages (run_id, from_run_id, from_label, body) VALUES (?, ?, ?, ?)`)
    .run(msg.runId, msg.fromRunId, msg.fromLabel, msg.body.slice(0, 20_000)).lastInsertRowid);
}

/** Returns undelivered messages for a run and marks them delivered (atomic). */
export function drainRunMessages(db: Database.Database, runId: string): RunMessage[] {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM run_messages WHERE run_id = ? AND delivered = 0 ORDER BY id`).all(runId) as Record<string, unknown>[];
    if (rows.length) db.prepare(`UPDATE run_messages SET delivered = 1 WHERE run_id = ? AND delivered = 0`).run(runId);
    return rows.map(r => ({
      id: r['id'] as number,
      runId: r['run_id'] as string,
      fromRunId: (r['from_run_id'] as string | null) ?? null,
      fromLabel: r['from_label'] as string,
      body: r['body'] as string,
      createdAt: r['created_at'] as string,
    }));
  })();
}

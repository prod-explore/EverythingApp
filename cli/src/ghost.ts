import { getModelInfo, isCatalogModel, isLocalModel } from './providers/registry.js';

/**
 * Ghost mode: a chat or a project whose content must not leave the machine it runs on.
 *
 * The promise is narrow and checkable: a ghost chat talks only to models that are positively known to be local
 * (ModelInfo.locality === 'local'), and nothing in the app that touches its content — the helper model for titles and
 * compaction, worker agents, the daily digest, notifications, web search/fetch and the browser — reaches a third party.
 * The flag is set when the chat or project is created and can never change (a database trigger enforces it, see
 * MIGRATIONS in db.ts); "can't turn it off" is the point — a ghost chat has no moment where its history is exposed to a
 * cloud model because somebody changed a setting or picked another model.
 *
 * Fail-closed everywhere: an unknown model, a model without a locality, a provider nobody marked local — all count as
 * not local.
 */

export const GHOST_MODEL_CODE = 'ghost_requires_local_model';
export const GHOST_IMMUTABLE_CODE = 'ghost_immutable';
export const GHOST_MOVE_CODE = 'ghost_move';

export class GhostModelError extends Error {
  readonly code = GHOST_MODEL_CODE;
  constructor(message: string) { super(message); this.name = 'GhostModelError'; }
}

/** Why `modelId` cannot be used in a ghost chat, or null when it can. */
export function ghostModelProblem(modelId: string | null | undefined): string | null {
  if (!modelId) return 'A ghost chat needs a local model — choose one for this chat.';
  if (!isCatalogModel(modelId)) return `"${modelId}" is not in the model list, so it cannot be verified as local. A ghost chat only uses models marked local.`;
  const info = getModelInfo(modelId);
  if (!isLocalModel(info)) {
    return `"${info.label}" is not marked as a local model. A ghost chat only uses local models — a MindGate node, or a provider/model you marked local in Settings → Models.`;
  }
  return null;
}

export function assertLocalModel(modelId: string | null | undefined): asserts modelId is string {
  const problem = ghostModelProblem(modelId);
  if (problem) throw new GhostModelError(problem);
}

/**
 * Connectors (MCP servers) whose tools a ghost chat may use: the operator's own, on their own infrastructure. The
 * default is the sandbox and the vault; web/browser connectors, GitHub and connectors added by hand are left out.
 * Operators can change the list with GHOST_CONNECTORS (comma-separated; empty = no connector tools at all).
 */
export const DEFAULT_GHOST_CONNECTORS = ['sandbox', 'obsidian'] as const;

export function ghostConnectorNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['GHOST_CONNECTORS'];
  if (raw === undefined) return [...DEFAULT_GHOST_CONNECTORS];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** The text of a push notification for something that came from a ghost chat: it says nothing about the content. */
export const GHOST_PUSH = { title: 'EverythingApp', body: 'A private chat needs your attention.' } as const;

/** What a push notification for an inbox item contains. */
export function gazetaPushPayload(item: { title: string; description?: string | null; ghost: boolean }): { title: string; body?: string; url: string } {
  return item.ghost ? { ...GHOST_PUSH, url: '/' } : { title: item.title, body: item.description ?? undefined, url: '/' };
}

/** What the model is told in a ghost chat, so it does not try to reach out. */
export const GHOST_PROMPT =
  'This is a ghost chat: everything stays on this machine. You have no internet access here — no web search, no page fetching, no browser — and you only see local tools. ' +
  'If the task needs the internet, say so and let the user continue in a normal chat instead.';

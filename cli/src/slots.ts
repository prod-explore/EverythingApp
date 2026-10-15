import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './db.js';
import type { ModelInfo } from './providers/registry.js';

/**
 * Model slots: which model does which job. Instead of hard-wiring "a cheap model for titles" into the code, the
 * user picks one model per slot in Settings; an unset slot is resolved automatically from the model tags:
 *
 *   chat        what a new conversation starts on (the `default_model` setting)
 *   helper      housekeeping: chat titles, the daily digest            → auto: first available `free` model
 *   subagent    default model for worker agents                        → auto: first available `free` model (independent of helper)
 *   escalation  what the orchestrator reaches for when the job is hard → never automatic
 *
 * The `free` tag is also the cost guard for agents: a chat that runs on a free model cannot start paid workers
 * unless the user switched "Allow agents to use paid models" on (see agents.ts).
 */
export const SLOT_KEYS = ['chat', 'helper', 'subagent', 'escalation'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
export const isSlotKey = (v: unknown): v is SlotKey => typeof v === 'string' && (SLOT_KEYS as readonly string[]).includes(v);

const SETTING_KEY: Record<SlotKey, string> = {
  chat: 'default_model',
  helper: 'slot_helper',
  subagent: 'slot_subagent',
  escalation: 'slot_escalation',
};
const ALLOW_PAID_KEY = 'agents_allow_paid';

export const FREE_TAG = 'free';
export const isFreeModel = (info: Pick<ModelInfo, 'tags'>): boolean => info.tags.includes(FREE_TAG);

/** The explicitly chosen model per slot; '' = automatic. */
export function getSlots(db: Database.Database): Record<SlotKey, string> {
  const out = {} as Record<SlotKey, string>;
  for (const k of SLOT_KEYS) out[k] = getSetting(db, SETTING_KEY[k]) ?? '';
  return out;
}

export function setSlots(db: Database.Database, patch: Partial<Record<SlotKey, string>>): Record<SlotKey, string> {
  for (const k of SLOT_KEYS) if (typeof patch[k] === 'string') setSetting(db, SETTING_KEY[k], patch[k]!);
  return getSlots(db);
}

export const allowPaidAgents = (db: Database.Database): boolean => getSetting(db, ALLOW_PAID_KEY) === '1';
export const setAllowPaidAgents = (db: Database.Database, on: boolean): void => setSetting(db, ALLOW_PAID_KEY, on ? '1' : '0');

type Available = (modelId: string) => boolean;

/** First usable model tagged `free`, in catalog order. */
export function firstFree(candidates: readonly ModelInfo[], available: Available): string | null {
  return candidates.find(m => isFreeModel(m) && available(m.id))?.id ?? null;
}

/**
 * The concrete model for a slot, or null when there is nothing usable. `candidates` are the enabled chat-capable
 * models in catalog order; `available` says whether a turn on a model could start now (provider has its key).
 */
export function resolveSlot(db: Database.Database, slot: SlotKey, candidates: readonly ModelInfo[], available: Available): string | null {
  const explicit = getSlots(db)[slot];
  switch (slot) {
    case 'chat':
      // An explicit default is honoured as-is (as before); otherwise a free model, otherwise whatever works.
      return explicit || firstFree(candidates, available) || candidates.find(m => available(m.id))?.id || null;
    case 'helper':
      return (explicit && available(explicit) ? explicit : null) ?? firstFree(candidates, available);
    case 'subagent':
      return (explicit && available(explicit) ? explicit : null) ?? firstFree(candidates, available);
    case 'escalation':
      return explicit && available(explicit) ? explicit : null;
  }
}

const MAX_LISTED = 40;

/**
 * The model list the orchestrator sees (in the system prompt of a chat that can start agents). Generated from the
 * catalog — ids, tags and the one-line description — so what the model is told always matches what is installed.
 */
export function modelsPrompt(
  candidates: readonly ModelInfo[],
  slots: { subagent: string | null; escalation: string | null },
  opts: { parentIsFree: boolean; allowPaid: boolean },
): string {
  if (candidates.length === 0) return '';
  const lines = candidates.slice(0, MAX_LISTED).map(m => {
    const marks = [m.id === slots.subagent ? 'default for agents' : '', m.id === slots.escalation ? 'escalation model' : ''].filter(Boolean);
    const tags = m.tags.length ? `tags: ${m.tags.join(', ')}` : 'no tags';
    return `- ${m.id} — ${m.label}; ${tags}${m.description ? `; ${m.description}` : ''}${marks.length ? ` [${marks.join('; ')}]` : ''}`;
  });
  if (candidates.length > MAX_LISTED) lines.push(`- … and ${candidates.length - MAX_LISTED} more (not listed).`);
  const guard = opts.parentIsFree && !opts.allowPaid
    ? '\n- You are running on a free model, so workers must be free too. For a paid model the user must switch this chat to one or turn on "Allow agents to use paid models" in Settings.'
    : '';
  return [
    '## Models for agents',
    'When you start a worker with spawn_agent, choose its model with "model" (an exact id from this list) or "tag" (the first usable model carrying it). With neither, the default for agents is used.',
    ...lines,
    '',
    'How to choose:',
    '- Routine work — lookups, summaries, drafts, parallel research — goes to a model tagged "free"; it costs nothing.',
    '- Use a stronger, non-free model only when the task is hard or a mistake would be expensive: complex code changes, architecture, long reasoning.',
    '- Match capability tags to the job ("coder", "reasoning", "vision"). Never invent a model id.' + guard,
  ].join('\n');
}

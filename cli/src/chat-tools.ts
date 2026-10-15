import type Database from 'better-sqlite3';
import type * as Llm from './llm-types.js';
import type { VirtualTool } from './llm-loop.js';
import { setConversationState, type ConversationState, type TodoItem, type TodoStatus } from './db.js';

/**
 * Chat functions that are not MCP tools but behave like the ones in Claude Code / Antigravity: a todo list the model
 * keeps up to date, and the plan proposal (propose → approve → work). They are virtual tools — the orchestrator runs them
 * inside the loop — and their state lives in `conversation_state`, so a reload shows the same list.
 */

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_TODOS = 40;

export const TODO_TOOL: Llm.Tool = {
  name: 'todo_write',
  description:
    'Keep a visible task list for multi-step work. Send the COMPLETE list every time (it replaces the previous one). ' +
    'Statuses: pending, in_progress (at most one at a time), completed. Mark an item completed as soon as it is done. ' +
    'Do not use it for a single trivial step.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to do, imperative ("Run the tests").' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
};

export const PROPOSE_PLAN_TOOL: Llm.Tool = {
  name: 'propose_plan',
  description:
    'Show the user a plan before you start work that is large, risky or hard to undo, or when the request leaves real choices open ' +
    '(what you will change or do, in order, and anything you are unsure about). The user approves or rejects it; wait for the answer before changing anything. ' +
    'If it is rejected, revise the plan using their feedback. Do not use it for small or obvious tasks.',
  input_schema: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in Markdown — short, concrete, ordered.' } },
    required: ['plan'],
  },
};

/** Validates the model's list; returns an error sentence for the model when it is unusable. */
export function parseTodos(input: Record<string, unknown>): TodoItem[] | string {
  const raw = input['todos'];
  if (!Array.isArray(raw)) return 'todo_write needs a "todos" array of { content, status }.';
  if (raw.length > MAX_TODOS) return `Keep the list to at most ${MAX_TODOS} items.`;
  const items: TodoItem[] = [];
  for (const [i, t] of raw.entries()) {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const content = typeof o['content'] === 'string' ? o['content'].trim() : '';
    const status = o['status'];
    if (!content) return `Item ${i + 1} has no "content".`;
    if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return `Item ${i + 1}: status must be pending, in_progress or completed.`;
    items.push({ content: content.slice(0, 300), status: status as TodoStatus });
  }
  return items;
}

export function todoTool(db: Database.Database, convId: string, onChange: (state: ConversationState) => void): VirtualTool {
  return {
    definition: TODO_TOOL,
    handler: async input => {
      const items = parseTodos(input);
      if (typeof items === 'string') return { text: items, isError: true };
      const state = setConversationState(db, convId, { todos: items });
      onChange(state);
      const done = items.filter(t => t.status === 'completed').length;
      const active = items.find(t => t.status === 'in_progress');
      return { text: `Todo list saved: ${done}/${items.length} done${active ? `, now: ${active.content}` : ''}.` };
    },
  };
}

export function proposePlanTool(): VirtualTool {
  return {
    definition: PROPOSE_PLAN_TOOL,
    requiresApproval: true,
    alwaysAsk: 'Approve this plan to let the assistant start working on it.',
    // Reaching the handler means the user approved (a rejection never runs it).
    handler: async () => ({ text: 'The user approved the plan. Carry it out now, and keep the todo list current.' }),
  };
}

/** Appended to every chat's system prompt. */
export const WORKING_STYLE_PROMPT =
  'For work with several steps, keep a task list with todo_write (full list each time, one item in_progress, mark items completed as you finish them). ' +
  'For a large, risky or ambiguous job, propose the plan with propose_plan and wait for approval before changing anything; for small, clear tasks just do the work. ' +
  'If tool results or your own earlier messages reveal that you misjudged something, say so and correct course instead of pressing on.';

export const AGENTS_FILE = 'AGENTS.md';
const AGENTS_MAX_CHARS = 20_000;

/** The project instruction file (AGENTS.md in the workspace root) as a system-prompt section. */
export function projectInstructionsPrompt(content: string): string {
  const text = content.length > AGENTS_MAX_CHARS ? `${content.slice(0, AGENTS_MAX_CHARS)}\n…[truncated]` : content;
  return `Project instructions (from ${AGENTS_FILE} in the project workspace — follow them):\n\n${text.trim()}`;
}

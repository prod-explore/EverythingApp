import type Database from 'better-sqlite3';
import { runTurn, StepLimitError, type LlmClient } from './anthropic-loop.js';
import type { ToolRegistry } from './tool-registry.js';
import type { WebApprovalGate } from './web-approval.js';
import type { SSEManager } from './sse.js';
import { appendMessage, createConversation, createSubagentRun, resolveSubagentRun, failSubagentRun } from './db.js';
import type { ProviderRouter } from './providers/router.js';
import type { ProviderId } from './providers/registry.js';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * §6b Chunk B — Subagent-with-a-goal.
 *
 * Standard industry pattern (Claude Code's Task tool, OpenAI Agents SDK
 * handoffs, Antigravity's Manager→specialized-subagents). Parent passes
 * { goal, allowed_tools, model } → subagent runs an isolated loop in its
 * own DB conversation → returns { summary, artifactIds } — only that
 * re-enters the parent's context, full subagent transcript discarded.
 *
 * Security properties:
 *  - Isolated transcript: the subagent runs in its own conversation row
 *    (kind = 'subagent', never listed in the sidebar) and never sees the
 *    parent's history. Only a structured summary flows back.
 *  - Fail-closed allowlist: the subagent is handed a registry RESTRICTED to
 *    allowed_tools (empty/omitted = no tools at all). Tools outside the list
 *    are not merely denied — the model never sees their definitions, and
 *    they cannot be called (ToolRegistry.call → "Unknown tool").
 *  - ONE approval gate, shared with the parent conversation: a subagent's
 *    tool call parks on the same gate the UI lists (/api/pending-approvals)
 *    and answers (/api/approve), labelled "[subagent] server/tool" so that an
 *    "always" grant given to the parent's tool does NOT carry over.
 *  - The parent's kill switch (AbortSignal) propagates: it aborts the
 *    in-flight request, rejects any parked approval, and stops the loop.
 *  - No recursion: subagents get no virtual tools, so they cannot spawn.
 *  - Runaway guard: MAX_STEPS model round-trips, then the run fails.
 *  - Cost is recorded against the parent conversation in the usage ledger.
 */

export interface SubagentInput {
  goal: string;
  model: string;
  /** Tool names the subagent may use ("server__tool", "server/tool" or bare name). Empty/omitted = none. */
  allowedTools?: string[];
  /** Depth guard: a subagent started by a parent subagent is rejected. */
  depth?: number;
}

export interface SubagentResult {
  runId: string;
  status: 'done' | 'error';
  summary: string;
  artifactIds: string[];
  error?: string;
}

const MAX_DEPTH = 1; // parent (depth 0) can spawn subagents (depth 1), no deeper.
const MAX_STEPS = 30; // hard cap on model round-trips to prevent runaway loops.

export interface SubagentDeps {
  db: Database.Database;
  router: ProviderRouter;
  registry: ToolRegistry;
  sse: SSEManager;
  /** The parent conversation id — approvals are filed under it so the UI shows them where the user is looking. */
  parentConvId: string;
  /** The parent conversation's project — its command policy and project grants apply to the subagent too. */
  projectId?: string;
  /** The SAME gate the parent turn uses (see header). */
  approval: WebApprovalGate;
  /** The parent turn's kill-switch signal. */
  signal?: AbortSignal;
  /** Usage of every subagent API call, for the parent's usage ledger. */
  onUsage?: (u: { provider: ProviderId; model: string; usage: Anthropic.Usage }) => void;
  /** System prompt to inject into the subagent. Defaults to a focused task-only prompt. */
  systemPrompt?: string;
}

function lastAssistantText(history: Anthropic.MessageParam[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content.trim();
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

export async function runSubagent(input: SubagentInput, deps: SubagentDeps): Promise<SubagentResult> {
  const depth = input.depth ?? 0;
  if (depth >= MAX_DEPTH) {
    return {
      runId: 'rejected',
      status: 'error',
      summary: '',
      artifactIds: [],
      error: `Subagent depth limit reached (max depth ${MAX_DEPTH}). A subagent cannot spawn its own subagents.`,
    };
  }

  const subConv = createConversation(deps.db, {
    title: `[subagent] ${input.goal.slice(0, 60)}`,
    model: input.model,
    kind: 'subagent',
  });
  const run = createSubagentRun(deps.db, {
    conversationId: deps.parentConvId,
    goal: input.goal,
    model: input.model,
    allowedTools: input.allowedTools ?? [],
  });
  const artifactIds: string[] = [];

  const systemPrompt = deps.systemPrompt ??
    `You are a focused sub-task agent. Your ONLY job is to accomplish the following goal:\n\n${input.goal}\n\n` +
    `When you have finished, output a concise plain-text SUMMARY of what you did and what the result is, ` +
    `then STOP. Do not ask for more instructions. Do not do anything beyond the goal.`;

  try {
    const { provider, info, client } = deps.router.clientFor(input.model);

    const history = await runTurn(
      {
        anthropic: client as LlmClient,
        model: input.model,
        maxTokens: Math.max(4096, info.minOutputTokens ?? 0),
        tools: deps.registry.restrictTo(input.allowedTools),
        systemPrompt,
        conversationId: subConv.id,
        signal: deps.signal,
        maxSteps: MAX_STEPS,
        confirm: async (label, args) => {
          const toolLabel = `[subagent] ${label}`;
          const decision = await deps.approval.confirmDetailed(deps.parentConvId, toolLabel, args, deps.signal, { projectId: deps.projectId, modelId: input.model });
          deps.sse.emit(deps.parentConvId, 'approval:resolved', { toolLabel, approved: decision.approved, reason: decision.reason, subagentRunId: run.id });
          return decision;
        },
        onUsage: usage => deps.onUsage?.({ provider, model: input.model, usage }),
      },
      [],
      input.goal,
    );

    let prevId: number | null = null;
    for (const msg of history) {
      prevId = appendMessage(deps.db, subConv.id, msg.role, msg.content, prevId);
    }

    const summary = lastAssistantText(history);
    if (!summary) {
      const error = 'Subagent finished without producing a summary.';
      failSubagentRun(deps.db, run.id, error);
      return { runId: run.id, status: 'error', summary: '', artifactIds, error };
    }
    resolveSubagentRun(deps.db, run.id, { summary, artifactIds });
    return { runId: run.id, status: 'done', summary, artifactIds };
  } catch (err) {
    const error =
      err instanceof StepLimitError
        ? `Subagent hit the ${err.limit}-step limit without finishing its goal.`
        : deps.signal?.aborted
          ? 'Subagent aborted (kill switch).'
          : deps.router.redact((err as Error).message);
    failSubagentRun(deps.db, run.id, error);
    return { runId: run.id, status: 'error', summary: '', artifactIds, error };
  }
}

/**
 * Virtual tool definition that the orchestrator exposes to the main agent.
 * When the agent calls this, server.ts runs runSubagent() and returns its
 * structured result as the tool result — only the summary re-enters context.
 */
export const SPAWN_SUBAGENT_TOOL = {
  name: 'spawn_subagent',
  description:
    'Spawn a focused sub-task agent that runs an isolated tool loop to accomplish a specific goal. ' +
    'Use this when a task is well-defined and self-contained enough that it can be delegated: ' +
    'web research, document drafting from a brief, running a sequence of bash commands to gather data, etc. ' +
    'The subagent works in isolation — it cannot see your current conversation — and returns a structured ' +
    'summary of what it did. Only that summary re-enters your context; the full transcript is discarded. ' +
    'The subagent cannot spawn its own subagents.',
  input_schema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description: 'The specific, self-contained goal for the subagent to accomplish. Be precise — it has no other context.',
      },
      model: {
        type: 'string',
        description:
          'Model to use for the subagent. Prefer a faster/cheaper model (e.g. claude-haiku-4-5-20251001, ' +
          'deepseek-chat) unless the task requires deep reasoning. Resolves through the existing provider router.',
      },
      allowed_tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Tools the subagent may use, by the exact names you see in your own tool list (e.g. "sandbox__run_bash"). ' +
          'Omit or leave empty for NO tools (pure reasoning). Grant only what the task needs; every call still needs user approval.',
      },
    },
    required: ['goal', 'model'],
  },
} as const;

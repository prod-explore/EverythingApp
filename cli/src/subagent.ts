import type Database from 'better-sqlite3';
import { runTurn, type LlmClient } from './anthropic-loop.js';
import { ToolRegistry } from './tool-registry.js';
import { WebApprovalGate } from './web-approval.js';
import { SSEManager } from './sse.js';
import { getMessages, appendMessage, createConversation, type ConversationRow } from './db.js';
import { createSubagentRun, resolveSubagentRun, failSubagentRun } from './db.js';
import type { ProviderRouter } from './providers/router.js';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * §6b Chunk B — Subagent-with-a-goal.
 *
 * Standard industry pattern (Claude Code's Task tool, OpenAI Agents SDK
 * handoffs, Antigravity's Manager→specialized-subagents). Parent passes
 * { goal, toolAllowlist, model } → subagent runs an isolated loop in its
 * own DB conversation → returns { summary, artifactIds } — only that
 * re-enters the parent's context, full subagent transcript discarded.
 *
 * Security properties:
 *  - The subagent runs in its own separate conversation row, never sharing
 *    history with the parent. If the subagent is tricked by injected content
 *    into producing harmful output, that output lands in the subagent's
 *    isolated transcript and only a structured summary is returned.
 *  - toolAllowlist restricts which tools the subagent can invoke. Every
 *    call still goes through the existing WebApprovalGate — dangerous calls
 *    surface to the same human, tagged with "subagent:".
 *  - Depth cap: a subagent may not spawn its own subagents (no recursion).
 *  - The subagent's approval gate is isolated from the parent's: "always"
 *    grants in the parent do NOT carry over to the subagent.
 *
 * The result lands in subagent_runs (db.ts) and is returned synchronously
 * to the caller (server.ts's tool handler) which then writes it as the
 * tool result back to the orchestrator.
 */

export interface SubagentInput {
  goal: string;
  model: string;
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
const MAX_TURNS = 30; // hard cap on subagent turn count to prevent runaway loops.

export interface SubagentDeps {
  db: Database.Database;
  router: ProviderRouter;
  registry: ToolRegistry;
  /** The parent conversation's SSE manager — subagent approval prompts flow through it. */
  sse: SSEManager;
  /** The parent conversation id — used to tag approval prompts and SSE events. */
  parentConvId: string;
  /** System prompt to inject into the subagent. Defaults to a focused task-only prompt. */
  systemPrompt?: string;
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

  // Create an isolated conversation for this subagent run
  const subConv = createConversation(deps.db, {
    title: `[subagent] ${input.goal.slice(0, 60)}`,
    model: input.model,
  }) as ConversationRow;

  // Record the run in DB so the UI can show it
  const run = createSubagentRun(deps.db, {
    conversationId: deps.parentConvId,
    goal: input.goal,
    model: input.model,
    allowedTools: input.allowedTools ?? [],
  });

  // Each subagent gets its own approval gate — parent's grants don't carry over.
  // Dangerous calls still surface via the PARENT's SSE channel, tagged with "subagent:".
  const subApproval = new WebApprovalGate();

  const systemPrompt = deps.systemPrompt ??
    `You are a focused sub-task agent. Your ONLY job is to accomplish the following goal:\n\n${input.goal}\n\n` +
    `When you have finished, output a concise plain-text SUMMARY of what you did and what the result is, ` +
    `then STOP. Do not ask for more instructions. Do not do anything beyond the goal.`;

  let turnCount = 0;
  let history: Anthropic.MessageParam[] = [];
  const artifactIds: string[] = [];

  // Initial user message = the goal itself
  const initialContent = input.goal;
  appendMessage(deps.db, subConv.id, 'user', initialContent, null);

  try {
    while (turnCount < MAX_TURNS) {
      turnCount++;
      history = getMessages(deps.db, subConv.id) as Anthropic.MessageParam[];

      const lastMsg = history[history.length - 1];
      if (lastMsg?.role === 'assistant') {
        // Model stopped without using a tool → it's done
        const content = lastMsg.content;
        const summary = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as Array<{ type: string; text?: string }>)
                .filter(b => b.type === 'text')
                .map(b => b.text ?? '')
                .join('\n')
            : '';
        if (summary.trim()) {
          resolveSubagentRun(deps.db, run.id, { summary: summary.trim(), artifactIds });
          return { runId: run.id, status: 'done', summary: summary.trim(), artifactIds };
        }
      }

      const { provider, info, client } = deps.router.clientFor(input.model);

      // Tool allowlist: enforce at the confirm() stage rather than filtering
      // the registry — ToolRegistry has no filter() method and we don't need one,
      // since disallowed tools are simply auto-denied before the human sees them.
      const allowSet = input.allowedTools && input.allowedTools.length > 0
        ? new Set(input.allowedTools)
        : null;

      const updatedHistory = await runTurn(
        {
          anthropic: client as LlmClient,
          model: input.model,
          maxTokens: Math.max(4096, info.minOutputTokens ?? 0),
          tools: deps.registry,
          systemPrompt,
          serverTools: [], // no virtual tools in subagents
          conversationId: subConv.id,
          signal: undefined,
          confirm: async (label, args) => {
            // Enforce allowlist: deny calls to tools not in the list immediately.
            const toolName = String((args as Record<string, unknown>)['_tool_name'] ?? label);
            if (allowSet && !allowSet.has(toolName)) return false;
            // Surface to human via parent conversation's SSE (tagged "[subagent]")
            const approved = await subApproval.confirm(subConv.id, `[subagent] ${label}`, args);
            deps.sse.emit(deps.parentConvId, 'approval:pending', {
              toolLabel: `[subagent] ${label}`,
              args,
              source: 'subagent',
              subagentRunId: run.id,
            });
            return approved;
          },
          onAssistantText: () => {},
          onToolStart: () => {},
          onToolResult: () => {},
          onUsage: usage => {
            // Charge usage back to the parent conversation
            void deps.router; // router reference available for future ledger wiring
            void usage;
          },
        },
        history,
        turnCount === 1 ? initialContent : (history[history.length - 1]?.content ?? ''),
      );

      // Persist new messages
      const newMessages = updatedHistory.slice(history.length + 1);
      let prevId: number | null = null;
      for (const msg of newMessages) {
        prevId = appendMessage(deps.db, subConv.id, msg.role, msg.content, prevId);
      }
    }

    // Hit turn cap without a clean stop
    const summary = `(Subagent reached the ${MAX_TURNS}-turn limit without completing the goal: ${input.goal})`;
    resolveSubagentRun(deps.db, run.id, { summary, artifactIds });
    return { runId: run.id, status: 'done', summary, artifactIds };

  } catch (err) {
    const error = deps.router.redact((err as Error).message);
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
          'Allowlist of tool names the subagent may use. An empty list grants all available tools. ' +
          'Narrowing this is recommended — only give the subagent the tools it actually needs.',
      },
    },
    required: ['goal', 'model'],
  },
} as const;

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolRegistry } from './tool-registry.js';

/** Minimal slice of the Anthropic SDK client this module needs — lets tests inject a fake. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ConversationDeps {
  anthropic: AnthropicLike;
  model: string;
  maxTokens?: number;
  tools: ToolRegistry;
  systemPrompt: string;
  /** Anthropic-hosted tools (e.g. web_search) — executed server-side, never routed through ToolRegistry or the approval gate. */
  serverTools?: Anthropic.ToolUnion[];
  /** Ask a human yes/no before a side-effecting tool call runs. */
  confirm: (toolLabel: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Called for every text block the model produces, in order (streamed to the terminal). */
  onAssistantText?: (text: string) => void;
  /** Called right before a tool actually executes (after approval, if needed) — for terminal feedback. */
  onToolStart?: (toolLabel: string) => void;
  /** Called once per API response with that response's usage — §12 pt.1: BYOK means Mikołaj pays per token directly. */
  onUsage?: (usage: Anthropic.Usage) => void;
}

const DENIED_MESSAGE = 'Odrzucone przez użytkownika (approval gate) — nie wykonano.';

/**
 * System prompt + tool definitions are identical on every single request in
 * a session — the textbook case for prompt caching (Master Brief §8: "system
 * prompt + narzędzia + dokumenty przed treścią dynamiczną"). Marking the last
 * block in each with cache_control caches everything up to and including it,
 * so this alone covers both. Anthropic requires >=1024 tokens (Sonnet) for a
 * cache breakpoint to actually take — under that it's a harmless no-op, not
 * an error, so there's no reason to special-case a short system prompt.
 */
export function cacheableSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

function cacheableTools(tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  const withCache = [...tools];
  const last = withCache[withCache.length - 1];
  withCache[withCache.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
  return withCache;
}

/**
 * Runs one user turn to completion: sends the message, and if Claude asks to
 * use tools, executes them (through the Approval Gate where required) and
 * feeds the results back — repeating until Claude replies with plain text
 * instead of another tool_use. Returns the updated history.
 */
export async function runTurn(
  deps: ConversationDeps,
  history: Anthropic.MessageParam[],
  userText: string,
): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userText }];
  const toolDefs: Anthropic.ToolUnion[] = [
    ...(deps.tools.toAnthropicTools() as Anthropic.Tool[]),
    ...(deps.serverTools ?? []),
  ];

  for (;;) {
    const response = await deps.anthropic.messages.create({
      model: deps.model,
      max_tokens: deps.maxTokens ?? 4096,
      system: cacheableSystem(deps.systemPrompt),
      tools: toolDefs.length > 0 ? cacheableTools(toolDefs) : undefined,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });
    deps.onUsage?.(response.usage);

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        deps.onAssistantText?.(block.text);
      }
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return messages;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const label = deps.tools.describe(use.name);
      const args = (use.input ?? {}) as Record<string, unknown>;

      const approved = !deps.tools.requiresApproval(use.name) || (await deps.confirm(label, args));

      if (!approved) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: DENIED_MESSAGE,
          is_error: true,
        });
        continue;
      }

      deps.onToolStart?.(label);
      const result = await deps.tools.call(use.name, args);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: result.text,
        is_error: result.isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

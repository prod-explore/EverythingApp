/**
 * The app's own model-call types. Messages are stored and passed around in one canonical shape — text, image,
 * `tool_use` and `tool_result` content blocks (ADR 0001) — and the OpenAI-compatible adapter
 * (providers/openai-compat.ts) is the only place that translates to and from a wire format.
 * Import as `import type * as Llm from './llm-types.js'`.
 */

export interface TextBlock { type: 'text'; text: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
/** The model's visible reasoning (`reasoning_content` / `reasoning`). Stored and shown, never sent back to a provider. */
export interface ThinkingBlock { type: 'thinking'; thinking: string }
/** What a model can answer with. */
export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock;

export interface TextBlockParam { type: 'text'; text: string }
export interface ImageBlockParam {
  type: 'image';
  source:
    | { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
    | { type: 'url'; url: string };
}
export interface ToolUseBlockParam { type: 'tool_use'; id: string; name: string; input: unknown }
export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<TextBlockParam | ImageBlockParam>;
  is_error?: boolean;
}
/** What can appear in a stored / sent message. */
export type ContentBlockParam = TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam | ThinkingBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens written to / read from the provider's prompt cache, when it reports them. */
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' | 'stop_sequence';

export interface Message {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence?: string | null;
  /** The reply hit the output limit while it was still writing tool calls — their arguments are probably incomplete. */
  cut_off?: boolean;
  usage: Usage;
}

/** A tool as offered to a model: JSON-schema parameters. */
export interface Tool {
  name: string;
  description?: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}
export type ToolUnion = Tool;

export interface MessageCreateParamsNonStreaming {
  model: string;
  max_tokens: number;
  system?: string | TextBlockParam[];
  tools?: Tool[];
  messages: MessageParam[];
  /** How hard a reasoning model should think. Sent only to models that support it (ModelInfo.supportsEffort). */
  reasoning_effort?: 'low' | 'medium' | 'high';
}
export type MessageCreateParams = MessageCreateParamsNonStreaming;

/** The streaming events the app consumes: a piece of reply text or of reasoning. */
export interface MessageStreamEvent {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string };
}

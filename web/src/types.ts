// Mirrors cli/src/db.ts and cli/src/server.ts exactly — keep these two in sync by hand,
// there's no shared package between web/ and cli/.

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface Conversation {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string | null;
  sandboxEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Anthropic-shaped content blocks, as stored (JSON.parse'd) by db.ts's getMessages(). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface RawMessage {
  id: number;
  role: string; // 'user' | 'assistant' — kept loose because db.ts's MessageParam type is loose
  content: string | ContentBlock[];
}

/** What the composer sends up for an image attachment — see api.ts's sendMessage(). */
export interface OutgoingAttachment {
  mediaType: string;
  /** Base64, no `data:...;base64,` prefix. */
  data: string;
}

export interface GazetaField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  options?: string[];
}

/** Mirrors cli/src/gazeta.ts's handleRequestHumanInput schema-shaping. */
export type GazetaInputSchema =
  | { type: 'choice'; choices: string[] }
  | { type: 'text' }
  | { type: 'fields'; fields: GazetaField[] }
  | null;

export interface GazetaItem {
  id: string;
  type: 'approval' | 'batch_result' | 'agent_question' | 'daily_summary';
  conversationId: string | null;
  title: string;
  description: string | null;
  inputSchema: unknown;
  response: unknown;
  status: 'pending' | 'responded' | 'dismissed';
  createdAt: string;
  respondedAt: string | null;
}

export interface BatchJob {
  id: string;
  conversationId: string;
  customId: string;
  userText: string;
  preview: string;
  status: 'pending' | 'succeeded' | 'errored' | 'expired';
  resultText: string | null;
  submittedAt: string;
  resolvedAt: string | null;
}

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolLabel: string;
  args: Record<string, unknown>;
  dangerous: boolean;
  createdAt: string;
}

export interface ConnectorInfo {
  name: string;
  connected: boolean;
  toolCount: number;
  tools: Array<{ name: string; description?: string }>;
}

export type TurnStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted';

export interface TurnState {
  id: number;
  status: TurnStatus;
  error?: string;
}

/**
 * How broadly a single approval grants future auto-approval — mirrors
 * web-approval.ts's ApprovalScope on the backend.
 */
export type ApprovalScope = 'once' | 'chat' | 'always';

/** A user-defined reusable prompt bundle — Phase 2. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  allowedTools: string[];
  createdAt: string;
  updatedAt: string;
}

// ─── Phase 3: providers, models, usage ───────────────────────────────────

export type ProviderId = 'anthropic' | 'gemini' | 'deepseek' | 'mindgate';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  configured: boolean;
  source: 'vault' | 'env' | null;
  last4: string | null;
  needsReentry: boolean;
  keyHint: string;
  warnUsdMonthly: number | null;
}

export interface ProvidersResponse {
  vaultEnabled: boolean;
  vaultDisabledReason: string | null;
  providers: ProviderInfo[];
}

export interface ModelOption {
  id: string;
  provider: ProviderId;
  label: string;
  available: boolean;
  pricingKnown: boolean;
  supportsImages: boolean;
  supportsBatch: boolean;
}

export type UsageRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  unpricedCalls: number;
}

export interface UsageReport {
  range: UsageRange;
  totals: UsageTotals;
  byProvider: Array<UsageTotals & { provider: string }>;
  byModel: Array<UsageTotals & { provider: string; model: string }>;
  byConversation: Array<UsageTotals & { conversationId: string | null; title: string | null }>;
  byDay: Array<{ day: string; costUsd: number; calls: number; tokens: number }>;
  monthToDate: Array<{ provider: string; costUsd: number; warnUsd: number | null }>;
}

export interface SpendWarning {
  provider: ProviderId;
  monthSpendUsd: number;
  thresholdUsd: number;
}

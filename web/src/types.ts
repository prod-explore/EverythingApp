// Mirrors cli/src/db.ts and cli/src/server.ts exactly — keep these two in sync by hand,
// there's no shared package between web/ and cli/.

export interface ConversationSummary {
  id: string;
  projectId?: string | null;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface Conversation {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string | null;
  /** What the next turn will actually use: the conversation's own model, else the default. Set by the server. */
  effectiveModel?: string;
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

/** A report pin: the file as it was when the report was posted (artifactId = snapshot copy). */
export interface GazetaAttachment {
  path: string;
  sha256?: string;
  artifactId?: string;
  error?: string;
}

export type GazetaItemType = 'agent_question' | 'report' | 'batch_result' | 'daily_summary';
export type GazetaStatus = 'pending' | 'responded' | 'dismissed' | 'expired';

export interface GazetaItem {
  id: string;
  type: GazetaItemType | 'approval';
  conversationId: string | null;
  projectId: string | null;
  runId: string | null;
  /** Who asked: "assistant" for the chat agent, or a worker's label. */
  agent: string | null;
  urgent: boolean;
  attachments: GazetaAttachment[] | null;
  title: string;
  description: string | null;
  inputSchema: unknown;
  response: unknown;
  status: GazetaStatus;
  createdAt: string;
  respondedAt: string | null;
}

/** How an answer reached the agent: straight into its waiting tool call, or later as a chat/inbox message. */
export type GazetaDelivery = 'tool_result' | 'message';

export interface GazetaQuery {
  status?: GazetaStatus;
  conversationId?: string;
  projectId?: string;
  type?: string;
  agent?: string;
  /** Cursor: createdAt of the oldest item already loaded. */
  before?: string;
  limit?: number;
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
  /** Shell tools: per-sub-command verdicts from the project command policy. */
  commands?: { command: string; prefix: string; decision: 'allow' | 'ask' | 'deny'; reason: string }[];
  /** Why this call needs a fresh approval (e.g. a page looked like a prompt injection). */
  warning?: string;
}

export type CommandMode = 'strict' | 'auto' | 'allowlist';
export interface CommandPolicy {
  mode: CommandMode;
  allow: string[];
  deny: string[];
  domains: string[];
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
export type ApprovalScope = 'once' | 'chat' | 'project' | 'always';

// ─── N1: Projects ─────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  workspaceVolume: string | null;
  policy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  description: string | null;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── N1: Approval Grants ──────────────────────────────────────────────────

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

// ─── §6b Chunk B: Artifacts & Subagent runs ──────────────────────────────────

export interface ArtifactRow {
  id: string;
  conversationId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  createdAt: string;
}

// ─── N6/N7: durable runs (Agents-lite) — mirrors cli/src/runs.ts ─────────────

export type RunStatus = 'running' | 'waiting_input' | 'waiting_children' | 'done' | 'error' | 'aborted' | 'interrupted';

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
  conversationId: string | null;
  /** Worker transcript conversation; null for root runs (their transcript is the chat itself). */
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

/** agent:budget_warning SSE payload. */
export interface BudgetWarning {
  rootRunId: string;
  usage: RunUsage;
}

export interface SubagentRunSummary {
  id: string;
  conversationId: string;
  goal: string;
  model: string;
  allowedTools: string[];
  status: 'running' | 'done' | 'error';
  result: { summary: string; artifactIds: string[] } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}


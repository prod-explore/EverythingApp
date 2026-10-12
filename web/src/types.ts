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

/** Content blocks as stored (JSON.parse'd) by db.ts's getMessages(). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
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

export type GazetaItemType = 'agent_question' | 'report' | 'daily_summary';
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

export type ProviderId = string;

export type ModelKind = 'chat' | 'image' | 'tts' | 'stt' | 'embedding';
export const MODEL_KINDS: ModelKind[] = ['chat', 'image', 'tts', 'stt', 'embedding'];
export type CompatFlavor = 'gemini' | 'deepseek' | 'mindgate' | 'generic';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  baseUrl: string;
  flavor: CompatFlavor;
  enabled: boolean;
  keyOptional: boolean;
  concurrency: number | null;
  configured: boolean;
  source: 'vault' | null;
  last4: string | null;
  needsReentry: boolean;
  keyHint: string;
  modelCount: number;
  enabledModelCount: number;
  /** How many of the enabled models a gateway reports as online / waking / asleep (empty for providers that report nothing). */
  statusCounts?: Partial<Record<'online' | 'asleep' | 'waking', number>>;
}

/** A starting point for "Add provider" — it only pre-fills the same form every provider goes through. */
export interface ProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  flavor: CompatFlavor;
  keyOptional: boolean;
  keyHint: string;
}

export interface ProvidersResponse {
  vaultEnabled: boolean;
  vaultDisabledReason: string | null;
  providers: ProviderInfo[];
  presets: ProviderPreset[];
}

/** A model as the pickers see it (enabled models of enabled providers). */
export interface ModelOption {
  id: string;
  provider: ProviderId;
  providerLabel: string;
  label: string;
  kind: ModelKind;
  tags: string[];
  description: string;
  available: boolean;
  supportsImages: boolean;
  /** 'none' = the model cannot call tools; the app does not offer such models for chat. */
  toolSchemaMode?: 'full' | 'flat' | 'none';
  status?: 'online' | 'asleep' | 'waking';
}

/** A model in the Settings editor — also the switched-off ones. `overridden` lists the fields the user changed. */
export interface CatalogModelRow extends Omit<ModelOption, 'available' | 'providerLabel'> {
  /** The id as the provider itself names it. */
  upstream: string;
  enabled: boolean;
  source: 'discovered' | 'manual' | 'seed';
  overridden: string[];
}

export type SlotKey = 'chat' | 'helper' | 'subagent' | 'escalation';

export interface SlotsResponse {
  /** What the user picked ('' = automatic). */
  slots: Record<SlotKey, string>;
  /** What each slot resolves to right now (null = nothing usable). */
  resolved: Record<SlotKey, string | null>;
  allowPaidAgents: boolean;
}

export type UsageRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
}

export interface UsageReport {
  range: UsageRange;
  totals: UsageTotals;
  byProvider: Array<UsageTotals & { provider: string }>;
  byModel: Array<UsageTotals & { provider: string; model: string }>;
  byConversation: Array<UsageTotals & { conversationId: string | null; title: string | null }>;
  byDay: Array<{ day: string; calls: number; tokens: number }>;
}

/** A provider answered 429/5xx (e.g. Gemini free tier at peak hours); the server is waiting and will retry on its own. */
export interface ProviderRetry {
  provider: string;
  attempt: number;
  status: number | 'network';
  delayMs: number;
  remainingMs: number;
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


import type {
  ApprovalGrantRow,
  ApprovalScope,
  ConnectorInfo,
  Conversation,
  ConversationSummary,
  GazetaDelivery,
  GazetaItem,
  GazetaQuery,
  OutgoingAttachment,
  CatalogModelRow,
  CompatFlavor,
  ModelKind,
  ModelOption,
  PendingApproval,
  ProjectListItem,
  ProjectRow,
  ProviderId,
  ProvidersResponse,
  RawMessage,
  SlotKey,
  SlotsResponse,
  RunRow,
  Skill,
  TurnState,
  UsageRange,
  UsageReport,
} from './types';

/**
 * Auth is a server-side session in an HttpOnly cookie (set by POST /api/login): nothing secret lives in
 * JS-reachable storage and no credential rides in a URL. Same-origin fetch / EventSource / WebSocket send it by themselves.
 */
export const UNAUTHORIZED_EVENT = 'ea:unauthorized';

/** Any 401 means the session is gone — tell the app shell, which swaps to the login screen (no reload loop). */
export function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/session');
    return res.ok && (await res.json().catch(() => ({ authed: false }))).authed === true;
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<void> {
  // Raw fetch on purpose: a wrong password is a 401 that must fail quietly in place, not trigger notifyUnauthorized().
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `login failed (${res.status})`, res.status);
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** One 401 anywhere means the session expired or was revoked: send the user back to the login screen. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (res.status === 401) {
    notifyUnauthorized();
    throw new ApiError('unauthorized', 401);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) {
    throw new ApiError(body.error ?? `request failed (${res.status})`, res.status);
  }
  return body as T;
}

// ─── Conversations ────────────────────────────────────────────────────────

export function listConversations(): Promise<{ conversations: ConversationSummary[] }> {
  return request('/api/conversations');
}

export function createConversation(opts?: {
  title?: string;
  projectId?: string;
  systemPrompt?: string;
  model?: string;
  sandboxEnabled?: boolean;
}): Promise<{ id: string }> {
  return request('/api/conversations', { method: 'POST', body: JSON.stringify(opts ?? {}) });
}

export function getConversation(id: string): Promise<Conversation> {
  return request(`/api/conversations/${id}`);
}

export function updateConversation(
  id: string,
  patch: { title?: string; systemPrompt?: string; model?: string; sandboxEnabled?: boolean },
): Promise<{ ok: true }> {
  return request(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteConversation(id: string): Promise<{ ok: true }> {
  return request(`/api/conversations/${id}`, { method: 'DELETE' });
}

// ─── Messages & turns ─────────────────────────────────────────────────────

export function getMessages(conversationId: string): Promise<{ messages: RawMessage[] }> {
  return request(`/api/conversations/${conversationId}/messages`);
}

export function clearMessages(conversationId: string): Promise<{ ok: true }> {
  return request(`/api/conversations/${conversationId}/messages`, { method: 'DELETE' });
}

export function sendMessage(
  conversationId: string,
  content: string,
  attachments?: OutgoingAttachment[],
): Promise<{ ok: true; turnId?: number }> {
  return request(`/api/conversations/${conversationId}/message`, {
    method: 'POST',
    body: JSON.stringify({ content, attachments }),
  });
}

export function killTurn(conversationId: string): Promise<{ ok: true }> {
  return request(`/api/conversations/${conversationId}/kill`, { method: 'POST' });
}

/**
 * Edit/regenerate/retry — Phase 1's message branching. `parentId` is the id
 * of the message immediately before the one being replaced (null for the
 * very first message); server.ts figures out the rest. See lib/runtime.ts
 * for how assistant-ui's onEdit/onReload map onto these.
 */
export function editMessage(
  conversationId: string,
  parentId: number | null,
  content: string,
): Promise<{ ok: true; turnId: number }> {
  return request(`/api/conversations/${conversationId}/edit`, {
    method: 'POST',
    body: JSON.stringify({ parentId, content }),
  });
}

export function regenerateMessage(
  conversationId: string,
  parentId: number | null,
): Promise<{ ok: true; turnId: number }> {
  return request(`/api/conversations/${conversationId}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ parentId }),
  });
}

export function retryLastMessage(conversationId: string): Promise<{ ok: true; turnId: number }> {
  return request(`/api/conversations/${conversationId}/retry`, { method: 'POST' });
}

/** Hard delete of one message and everything after it — distinct from clearMessages() above. */
export function deleteMessageFrom(conversationId: string, messageId: number): Promise<{ ok: true }> {
  return request(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' });
}

export function getTurnStatus(conversationId: string): Promise<TurnState & { usage: string }> {
  return request(`/api/conversations/${conversationId}/status`);
}

// ─── Approvals ────────────────────────────────────────────────────────────

export function getPendingApprovals(): Promise<{ pending: PendingApproval[] }> {
  return request('/api/pending-approvals');
}

export function approve(id: string, approved: boolean, scope?: ApprovalScope): Promise<{ ok: true }> {
  return request('/api/approve', { method: 'POST', body: JSON.stringify({ id, approved, scope: scope ?? 'once' }) });
}

// ─── Settings ─────────────────────────────────────────────────────────────

export function getSettings(): Promise<{ settings: Record<string, string> }> {
  return request('/api/settings');
}

export function putSetting(key: string, value: string): Promise<{ ok: true }> {
  return request('/api/settings', { method: 'PUT', body: JSON.stringify({ key, value }) });
}

// ─── Connectors ───────────────────────────────────────────────────────────

export function getConnectors(): Promise<{ connectors: ConnectorInfo[] }> {
  return request('/api/connectors');
}

// ─── Skills ───────────────────────────────────────────────────────────────

export function listSkills(): Promise<{ skills: Skill[] }> {
  return request('/api/skills');
}

export function createSkill(opts: {
  name: string;
  description?: string;
  prompt?: string;
  allowedTools?: string[];
}): Promise<{ skill: Skill }> {
  return request('/api/skills', { method: 'POST', body: JSON.stringify(opts) });
}

export function updateSkill(
  id: string,
  patch: { name?: string; description?: string; prompt?: string; allowedTools?: string[] },
): Promise<{ ok: true; skill: Skill }> {
  return request(`/api/skills/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteSkill(id: string): Promise<{ ok: true }> {
  return request(`/api/skills/${id}`, { method: 'DELETE' });
}

export function getConversationSkills(conversationId: string): Promise<{ skills: Skill[] }> {
  return request(`/api/conversations/${conversationId}/skills`);
}

export function attachSkill(conversationId: string, skillId: string): Promise<{ ok: true }> {
  return request(`/api/conversations/${conversationId}/skills/${skillId}`, { method: 'POST' });
}

export function detachSkill(conversationId: string, skillId: string): Promise<{ ok: true }> {
  return request(`/api/conversations/${conversationId}/skills/${skillId}`, { method: 'DELETE' });
}

// ─── Gazeta ───────────────────────────────────────────────────────────────

/** Server order: urgent pending first, then newest. */
export function getGazetaItems(query: GazetaQuery = {}): Promise<{ items: GazetaItem[] }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return request(`/api/gazeta${qs ? `?${qs}` : ''}`);
}

/** Throws ApiError with status 409 when the item was already answered/dismissed/expired elsewhere. */
export function respondToGazetaItem(id: string, response: unknown): Promise<{ ok: true; delivered: GazetaDelivery }> {
  return request(`/api/gazeta/${id}/respond`, { method: 'POST', body: JSON.stringify({ response }) });
}

export function dismissGazetaItem(id: string): Promise<{ ok: true }> {
  return request(`/api/gazeta/${id}/dismiss`, { method: 'POST' });
}

export function bulkDismissGazetaItems(ids: string[]): Promise<{ ok: true; dismissed: number }> {
  return request('/api/gazeta/bulk-dismiss', { method: 'POST', body: JSON.stringify({ ids }) });
}

// ─── Runs / Agents (N6/N7) ────────────────────────────────────────────────

export function listConversationRuns(conversationId: string): Promise<{ runs: RunRow[] }> {
  return request(`/api/conversations/${conversationId}/runs`);
}

/** 404 for root runs (no separate transcript) — worker transcripts are written when the worker finishes. */
export function getRunTranscript(runId: string): Promise<{ messages: RawMessage[] }> {
  return request(`/api/runs/${runId}/transcript`);
}

export function stopRun(runId: string): Promise<{ ok: true }> {
  return request(`/api/runs/${runId}/stop`, { method: 'POST' });
}

/** Talks to a worker agent: a running one gets it in its inbox, a finished one is resumed with it. */
export function messageRun(runId: string, body: string): Promise<{ ok: true; delivered: 'inbox' | 'resumed' }> {
  return request(`/api/runs/${runId}/message`, { method: 'POST', body: JSON.stringify({ body }) });
}

/** <img>/<a> are same-origin GETs, so the session cookie authenticates them — no credential in the URL. */
export function artifactFileUrl(id: string): string {
  return `/api/artifacts/${id}/file`;
}

// ─── Usage ────────────────────────────────────────────────────────────────

export function getUsage(): Promise<{ summary: string }> {
  return request('/api/usage');
}

export function getUsageReport(range: UsageRange): Promise<UsageReport> {
  // Minutes east of UTC, so "today" and the daily buckets follow this browser's clock.
  const tzOffset = -new Date().getTimezoneOffset();
  return request(`/api/usage/report?range=${range}&tzOffset=${tzOffset}`);
}

// ─── Providers & models ───────────────────────────────────────────────────

export function getProviders(): Promise<ProvidersResponse> {
  return request('/api/providers');
}

/** Enabled models of enabled providers; pickers filter on `kind`. */
export function getModels(): Promise<{ models: ModelOption[] }> {
  return request('/api/models');
}

export interface NewProvider {
  /** A preset pre-fills slug, label, base URL and dialect. */
  preset?: string;
  slug?: string;
  label?: string;
  baseUrl?: string;
  flavor?: CompatFlavor;
  apiKey?: string;
  keyOptional?: boolean;
}

export type RefreshResult = { ok: true; count: number; added: number; removed: number } | { ok: false; error: string };

/** The one way to add any provider — MindGate, Gemini, OpenRouter or a LAN server. Tests the connection and loads its models. */
export function addProvider(p: NewProvider): Promise<{ ok: true; id: string; refresh: RefreshResult | null }> {
  return request('/api/providers', { method: 'POST', body: JSON.stringify(p) });
}

export function updateProvider(
  id: ProviderId,
  patch: Partial<{ label: string; baseUrl: string; flavor: CompatFlavor; keyOptional: boolean; enabled: boolean; concurrency: number | null }>,
): Promise<{ ok: true }> {
  return request(`/api/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function removeProvider(id: ProviderId): Promise<{ ok: boolean }> {
  return request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Keys are write-only: the server never sends one back. */
export function saveProviderKey(
  id: ProviderId,
  key: string,
): Promise<{ ok: true; verified: boolean | null; verifyError: string | null }> {
  return request(`/api/providers/${encodeURIComponent(id)}/key`, { method: 'PUT', body: JSON.stringify({ key }) });
}

export function deleteProviderKey(id: ProviderId): Promise<{ ok: boolean }> {
  return request(`/api/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' });
}

export function testProvider(id: ProviderId): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

/** `GET {base}/models` → catalog. User edits and hand-added models survive. */
export function refreshProviderModels(id: ProviderId): Promise<RefreshResult> {
  return request(`/api/providers/${encodeURIComponent(id)}/refresh-models`, { method: 'POST' });
}

export function setProviderLimit(id: ProviderId, warnUsdMonthly: number | null): Promise<{ ok: true }> {
  return request(`/api/providers/${encodeURIComponent(id)}/limits`, { method: 'PUT', body: JSON.stringify({ warnUsdMonthly }) });
}

export function listProviderModels(id: ProviderId): Promise<{ models: CatalogModelRow[] }> {
  return request(`/api/providers/${encodeURIComponent(id)}/models`);
}

export type ModelPatch = Partial<{
  enabled: boolean;
  label: string | null;
  kind: ModelKind | null;
  tags: string[] | null;
  description: string | null;
  supportsImages: boolean | null;
  pricing: { input: number; output: number } | null;
}>;

/** A field set to null goes back to what the provider reports. */
export function patchModel(id: string, patch: ModelPatch): Promise<{ ok: true }> {
  return request('/api/models', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) });
}

export function addProviderModel(provider: ProviderId, id: string, fields: { kind?: ModelKind; tags?: string[] } = {}): Promise<{ ok: true; id: string }> {
  return request(`/api/providers/${encodeURIComponent(provider)}/models`, { method: 'POST', body: JSON.stringify({ id, ...fields }) });
}

export function removeModel(id: string): Promise<{ ok: true }> {
  return request(`/api/models?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Model slots ──────────────────────────────────────────────────────────

export function getSlots(): Promise<SlotsResponse> {
  return request('/api/slots');
}

export function setSlots(patch: Partial<Record<SlotKey, string>> & { allowPaidAgents?: boolean }): Promise<SlotsResponse> {
  return request('/api/slots', { method: 'PUT', body: JSON.stringify(patch) });
}

// ─── N1: Projects ─────────────────────────────────────────────────────────────

export function listProjects(): Promise<{ projects: ProjectListItem[] }> {
  return request('/api/projects');
}

export function createProject(name: string, description?: string): Promise<ProjectRow> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify({ name, description }) });
}

export function getProject(id: string): Promise<ProjectRow> {
  return request(`/api/projects/${id}`);
}

export function updateProject(id: string, patch: { name?: string; description?: string; policy?: Record<string, unknown> }): Promise<{ ok: boolean }> {
  return request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Deletes a project; its chats are deleted with it unless `keepChats` (they then become quick chats). */
export function deleteProject(id: string, keepChats = false): Promise<{ ok: boolean }> {
  return request(`/api/projects/${id}${keepChats ? '?conversations=keep' : ''}`, { method: 'DELETE' });
}

export function listProjectConversations(id: string): Promise<{ conversations: ConversationSummary[] }> {
  return request(`/api/projects/${id}/conversations`);
}

// ─── N1: Approval Grants ──────────────────────────────────────────────────────

export function listApprovalGrants(filter?: { conversationId?: string; projectId?: string; scope?: string }): Promise<{ grants: ApprovalGrantRow[] }> {
  const params = new URLSearchParams();
  if (filter?.conversationId) params.set('conversationId', filter.conversationId);
  if (filter?.projectId) params.set('projectId', filter.projectId);
  if (filter?.scope) params.set('scope', filter.scope);
  const qs = params.toString();
  return request(`/api/approval/grants${qs ? `?${qs}` : ''}`);
}

export function revokeApprovalGrant(id: string): Promise<{ ok: boolean }> {
  return request(`/api/approval/grants/${id}`, { method: 'DELETE' });
}

export interface SearchHit { conversationId: string; title: string; messageId: number; snippet: string }
export async function searchMessages(q: string): Promise<SearchHit[]> {
  return (await request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`)).hits;
}

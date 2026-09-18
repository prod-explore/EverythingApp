import type {
  ApprovalScope,
  BatchJob,
  ConnectorInfo,
  Conversation,
  ConversationSummary,
  GazetaItem,
  OutgoingAttachment,
  PendingApproval,
  RawMessage,
  Skill,
  TurnState,
} from './types';

const TOKEN_KEY = 'everythingapp_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * One 401 anywhere means the token is gone or wrong — there's no refresh
 * flow (single shared secret, see server.ts), so the only sane move is to
 * drop it and force the login screen again rather than let every caller
 * guess what a stale 401 means.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
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

/** batch=true submits via the Batches API instead of running live — see implementation_plan.md §2.2. Attachments are images only in Phase 1 and are ignored in batch mode by the server. */
export function sendMessage(
  conversationId: string,
  content: string,
  batch?: boolean,
  attachments?: OutgoingAttachment[],
): Promise<{ ok: true; turnId?: number; batchId?: string }> {
  return request(`/api/conversations/${conversationId}/message`, {
    method: 'POST',
    body: JSON.stringify({ content, batch, attachments }),
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

export function getGazetaItems(status?: string): Promise<{ items: GazetaItem[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return request(`/api/gazeta${qs}`);
}

export function respondToGazetaItem(id: string, response: unknown): Promise<{ ok: true }> {
  return request(`/api/gazeta/${id}/respond`, { method: 'POST', body: JSON.stringify({ response }) });
}

export function dismissGazetaItem(id: string): Promise<{ ok: true }> {
  return request(`/api/gazeta/${id}/dismiss`, { method: 'POST' });
}

// ─── Batch jobs ───────────────────────────────────────────────────────────

export function listBatchJobs(): Promise<{ jobs: BatchJob[] }> {
  return request('/api/batches');
}

export function listConversationBatchJobs(conversationId: string): Promise<{ jobs: BatchJob[] }> {
  return request(`/api/conversations/${conversationId}/batches`);
}

// ─── Usage ────────────────────────────────────────────────────────────────

export function getUsage(): Promise<{ summary: string }> {
  return request('/api/usage');
}

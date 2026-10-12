import { ProviderHttpError } from './openai-compat.js';
import { ProviderNotConfiguredError } from './router.js';

/**
 * What went wrong with a model call, in terms the UI and the turn loop can act on.
 * The raw provider message is kept (redacted by the caller) — `message` is the sentence a person should read.
 */
export type IncidentKind =
  | 'context_too_long' // the conversation no longer fits the model's window → compact and retry
  | 'auth' //             key rejected / no permission
  | 'budget_exhausted' // the gateway says the budget is used up (never retried)
  | 'rate_limited' //     429 that outlived the retry window
  | 'busy' //             5xx / network that outlived the retry window
  | 'timeout' //          the single request guard fired
  | 'tool_parse' //       the model produced a tool call the server could not parse
  | 'not_configured' //   no key / no model
  | 'aborted' //          the stop button
  | 'unknown';

export interface Incident {
  kind: IncidentKind;
  /** Plain-language sentence for the UI. */
  message: string;
  /** The context window the provider named in its error, when it did (tokens). */
  limit?: number;
  /** Safe to retry the same request later without changing anything. */
  transient: boolean;
}

const CONTEXT_PATTERNS = [
  /context[_ ]length/i,
  /maximum context/i,
  /context window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (input )?tokens/i,
  /exceeds? the (maximum|max|model'?s?) .{0,40}(tokens|context|limit)/i,
  /token limit/i,
  /reduce the length of the messages/i,
  /request too large/i,
  /input token count .{0,40}exceeds/i,
  /exceeds the maximum number of tokens/i,
];

/** "maximum context length is 32768 tokens" / "limit of 1048576" → 32768 */
export function contextLimitFromMessage(text: string): number | undefined {
  const m =
    /(?:maximum|max)\s+context\s+length\s+(?:is|of)\s+(\d{3,9})/i.exec(text) ??
    /context\s+(?:window|length|limit)\s+(?:is|of)\s+(\d{3,9})/i.exec(text) ??
    /limit\s+(?:is|of)\s+(\d{4,9})\s+tokens/i.exec(text) ??
    /exceeds? the limit of (\d{4,9})/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function looksLikeContextOverflow(status: number, detail: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422 && status !== 500) return false;
  if (/context_length_exceeded/i.test(detail)) return true;
  return CONTEXT_PATTERNS.some(re => re.test(detail));
}

export function classifyError(err: unknown, redact: (s: string) => string = s => s): Incident {
  const raw = err instanceof Error ? err.message : String(err);
  const text = redact(raw);

  if (err instanceof ProviderNotConfiguredError) return { kind: 'not_configured', message: text, transient: false };
  if (/kill switch|aborted by user/i.test(text)) return { kind: 'aborted', message: 'Stopped.', transient: false };

  if (err instanceof ProviderHttpError) {
    const detail = redact(err.message);
    const status = err.status;
    if (looksLikeContextOverflow(status, detail)) {
      const limit = contextLimitFromMessage(detail);
      return {
        kind: 'context_too_long',
        message: `The conversation no longer fits this model's context window${limit ? ` (${limit.toLocaleString('en-US')} tokens)` : ''}. Compact the history or switch to a model with a larger window.`,
        ...(limit ? { limit } : {}),
        transient: false,
      };
    }
    if (/budget_exhausted/i.test(detail)) {
      return { kind: 'budget_exhausted', message: `${err.provider} says its budget is used up. Top it up on the provider's side or pick another model.`, transient: false };
    }
    if (status === 401 || status === 403) {
      return { kind: 'auth', message: `${err.provider} rejected the API key (HTTP ${status}). Check it in Settings → Models.`, transient: false };
    }
    if (status === 429) {
      return { kind: 'rate_limited', message: `${err.provider} is rate-limiting requests (HTTP 429). Try again in a moment — a longer "retry busy errors for" window on the provider card keeps retrying automatically.`, transient: true };
    }
    if (status >= 500 || status === 408) {
      return { kind: 'busy', message: `${err.provider} is not answering properly (HTTP ${status}). Try again in a moment — a longer "retry busy errors for" window on the provider card keeps retrying automatically.`, transient: true };
    }
    if (status === 400 && /tool|function/i.test(detail) && /pars|json|invalid|looks like object|closing/i.test(detail)) {
      return { kind: 'tool_parse', message: 'The model produced a malformed tool call and the server refused it. Retrying usually works.', transient: true };
    }
  }

  if (/timed out after/i.test(text)) {
    return { kind: 'timeout', message: 'The provider did not answer within 15 minutes, so the request was dropped. Try again, or pick another model.', transient: true };
  }
  return { kind: 'unknown', message: text, transient: false };
}

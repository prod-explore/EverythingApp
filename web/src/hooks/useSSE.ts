import { useEffect, useReducer, useRef } from 'react';
import { getToken } from '../api';

/**
 * One entry per tool call made during the currently-running turn, in the
 * order the backend emitted them. Correlated to their result by POSITION,
 * not by id: server.ts's tool loop emits onToolStart → (approval) →
 * onToolResult strictly one call at a time before moving to the next
 * (see anthropic-loop.ts's `for (const use of toolUses)`), and neither SSE
 * event carries a tool_use_id — onToolStart gets the human label
 * (`tools.describe(use.name)`), onToolResult gets the raw registry name
 * (`use.name`), which are different strings for the same call. The oldest
 * unresolved entry is always the right one to attach a result to.
 */
export interface LiveToolCall {
  label: string;
  toolName?: string;
  result?: { truncatedOutput: string; isError: boolean; wasTruncated: boolean };
}

export type LivePart = { type: 'text'; text: string } | { type: 'tool'; call: LiveToolCall };

export interface LiveTurnState {
  /** True from turn:start until turn:done/error/aborted. */
  running: boolean;
  parts: LivePart[];
  error?: string;
  /** Bumped on every turn:done/error/aborted — lets consumers notice "a turn just finished" even if `running` briefly reads false in both the old and new state. */
  finishedCount: number;
}

const INITIAL_STATE: LiveTurnState = { running: false, parts: [], finishedCount: 0 };

type Action =
  | { type: 'clear' }
  | { type: 'start' }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; label: string }
  | { type: 'tool_result'; toolName: string; truncatedOutput: string; isError: boolean; wasTruncated: boolean }
  | { type: 'finish'; error?: string };

function reducer(state: LiveTurnState, action: Action): LiveTurnState {
  switch (action.type) {
    case 'clear':
      return { running: false, parts: [], finishedCount: state.finishedCount };
    case 'start':
      return { running: true, parts: [], finishedCount: state.finishedCount };
    case 'text':
      return { ...state, parts: [...state.parts, { type: 'text', text: action.text }] };
    case 'tool_use':
      return { ...state, parts: [...state.parts, { type: 'tool', call: { label: action.label } }] };
    case 'tool_result': {
      const idx = state.parts.findIndex(p => p.type === 'tool' && !p.call.result);
      if (idx === -1) return state; // defensive — shouldn't happen given the guaranteed emission order
      const parts = [...state.parts];
      const part = parts[idx] as Extract<LivePart, { type: 'tool' }>;
      parts[idx] = {
        type: 'tool',
        call: {
          ...part.call,
          toolName: action.toolName,
          result: { truncatedOutput: action.truncatedOutput, isError: action.isError, wasTruncated: action.wasTruncated },
        },
      };
      return { ...state, parts };
    }
    case 'finish':
      // Clear parts, not just running — liveTurnToMessage() renders whatever
      // is in `parts` regardless of `running`, and the refetch triggered by
      // finishedCount changing (see lib/runtime.ts) brings in the same
      // content as a persisted message right after this. Leaving parts
      // populated here duplicated every just-finished turn on screen until
      // the next conversation switch cleared it.
      return { running: false, parts: [], error: action.error, finishedCount: state.finishedCount + 1 };
  }
}

export type SideEvent = 'gazeta:new' | 'batch:resolved' | 'approval:resolved';

/**
 * Subscribes to a conversation's SSE stream. Reconnects automatically on
 * drop (mobile networks/backgrounded tabs cut EventSource connections
 * often) — a fresh GET /api/conversations/:id/messages after reconnecting
 * is still the source of truth for anything that happened while
 * disconnected; this hook only carries the LIVE view of a turn in progress.
 *
 * `onSideEvent` covers events that aren't part of the turn itself:
 * server.ts's SSEManager.emitAll() broadcasts `gazeta:new`/`batch:resolved`
 * to every currently-open conversation stream (not just the one that
 * triggered them), so whichever conversation happens to be open right now
 * still hears about it — that's what lets useGazeta react immediately
 * instead of relying only on its 30s poll fallback.
 */
export function useSSE(conversationId: string | null, onSideEvent?: (event: SideEvent, data: unknown) => void): LiveTurnState {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const onSideEventRef = useRef(onSideEvent);
  onSideEventRef.current = onSideEvent;

  useEffect(() => {
    if (!conversationId) return;
    dispatch({ type: 'clear' });
    // ^ reset live state immediately on conversation switch — stale parts
    // from the previous conversation must never bleed into this one, even
    // for the instant before the new EventSource's first message arrives.
    // We use 'clear' instead of 'start' so that 'running' defaults to false,
    // and is only set to true when the server actually emits 'turn:start'.

    const token = getToken();
    // EventSource can't set custom headers, so the token travels as a query
    // param instead of the Authorization header every other endpoint uses.
    // It's the same shared secret either way; this is the one place it has
    // to ride in the URL.
    const url = `/api/conversations/${conversationId}/stream?token=${encodeURIComponent(token ?? '')}`;
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (closed) return;
      source = new EventSource(url);

      source.addEventListener('turn:start', () => dispatch({ type: 'start' }));
      source.addEventListener('turn:text', e => {
        const data = JSON.parse((e as MessageEvent).data) as { text: string };
        dispatch({ type: 'text', text: data.text });
      });
      source.addEventListener('turn:tool_use', e => {
        const data = JSON.parse((e as MessageEvent).data) as { label: string };
        dispatch({ type: 'tool_use', label: data.label });
      });
      source.addEventListener('turn:tool_result', e => {
        const data = JSON.parse((e as MessageEvent).data) as {
          toolName: string;
          truncatedOutput: string;
          isError: boolean;
          wasTruncated: boolean;
        };
        dispatch({ type: 'tool_result', ...data });
      });
      source.addEventListener('turn:done', () => dispatch({ type: 'finish' }));
      source.addEventListener('turn:error', e => {
        const data = JSON.parse((e as MessageEvent).data) as { error: string };
        dispatch({ type: 'finish', error: data.error });
      });
      source.addEventListener('turn:aborted', e => {
        const data = JSON.parse((e as MessageEvent).data) as { error: string };
        dispatch({ type: 'finish', error: data.error });
      });

      for (const evt of ['gazeta:new', 'batch:resolved', 'approval:resolved'] as const) {
        source.addEventListener(evt, e => {
          const data = JSON.parse((e as MessageEvent).data ?? '{}');
          onSideEventRef.current?.(evt, data);
        });
      }

      source.onerror = () => {
        source?.close();
        if (closed) return;
        // Browsers already retry EventSource automatically, but on a fatal
        // server-side close (e.g. a deploy) that stops — a manual retry
        // loop is the difference between "reconnects in 2s" and "silently
        // dead until the page is reloaded."
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [conversationId]);

  return state;
}

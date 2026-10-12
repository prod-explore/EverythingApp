import { useEffect, useRef, useState, useCallback } from 'react';
import { Monitor, Hand, X, Loader, Globe } from 'lucide-react';

/**
 * §6b Chunk B: Live-view panel for an active browser session.
 *
 * Connects to the SAME ORIGIN as the app:  wss://<this-host>/api/liveview?conversationId=<id>  (auth: the session cookie rides on the handshake)
 * The server authenticates the token and relays the WebSocket to playwright-mcp with its own
 * server-side key (cli/src/liveview-proxy.ts). No build-time URL, no second port, no mixed
 * content behind HTTPS, and the CSP `connect-src 'self'` keeps working.
 *
 * Two modes:
 * 1. Watch-only (default): streams JPEG frames from the active session as <img> blobs.
 * 2. Takeover: sends mouse/keyboard events back to the session. Toggle with the
 *    "Take control" button. Visual indicator shows when takeover is active.
 *
 * With no session the panel offers "Open browser" (optionally with a start URL), so a human can
 * start one without asking the agent to call browser_open.
 *
 * Layout: the frame is scaled to fit (object-contain) whatever size the panel has. When the browser
 * is the only panel in the dock it fills the full height; otherwise it has a drag-resizable height.
 */

function liveViewUrl(conversationId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/liveview?conversationId=${encodeURIComponent(conversationId)}`;
}

interface Status {
  session: boolean;
  url?: string;
  takeover?: boolean;
}

const HEIGHT_KEY = 'browserPanelHeight';
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 360;

function maxHeight(): number {
  return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.9));
}

function clampHeight(h: number): number {
  return Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(h)));
}

function loadHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? clampHeight(v) : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

/** Maps a pointer position over an object-contain <img> to page pixels (letterboxing excluded). */
function pagePoint(img: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const nw = img.naturalWidth || 1280;
  const nh = img.naturalHeight || 720;
  const scale = Math.min(rect.width / nw, rect.height / nh);
  if (!(scale > 0)) return null;
  const left = rect.left + (rect.width - nw * scale) / 2;
  const top = rect.top + (rect.height - nh * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  if (x < 0 || y < 0 || x > nw || y > nh) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function BrowserPanel({
  conversationId,
  onClose,
  fill = false,
}: {
  conversationId: string;
  onClose: () => void;
  /** True when no other panel shares the dock: take the full height instead of the resizable one. */
  fill?: boolean;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<Status>({ session: false });
  const [takeover, setTakeover] = useState(false);
  const [connected, setConnected] = useState(false);
  // Closed without ever opening: the proxy answered 502/503 (playwright-mcp down or not configured).
  const [unavailable, setUnavailable] = useState(false);
  const [height, setHeight] = useState(loadHeight);
  const [startUrl, setStartUrl] = useState('');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const prevBlobUrl = useRef<string | null>(null);

  // Keyboard + mouse events when takeover is active
  const sendEvent = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    setUnavailable(false);
    setStatus({ session: false });
    const ws = new WebSocket(liveViewUrl(conversationId));
    ws.binaryType = 'blob';
    wsRef.current = ws;

    let opened = false;
    ws.onopen = () => { opened = true; setConnected(true); };
    ws.onclose = () => {
      setConnected(false);
      if (!opened) setUnavailable(true);
      if (wsRef.current === ws) wsRef.current = null;
    };

    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        try {
          const data = JSON.parse(evt.data) as Status & { type?: string; message?: string };
          if (data.type === 'error') {
            setOpening(false);
            setOpenError(data.message ?? 'Could not open the browser.');
            return;
          }
          setStatus(data);
          if (data.session) { setOpening(false); setOpenError(null); }
          if (typeof data.takeover === 'boolean') setTakeover(data.takeover);
        } catch { /* ignore */ }
      } else {
        // Binary JPEG frame
        const blob = evt.data as Blob;
        const blobUrl = URL.createObjectURL(blob);
        if (imgRef.current) {
          imgRef.current.src = blobUrl;
        }
        // Revoke the previous blob URL to avoid memory leaks
        if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
        prevBlobUrl.current = blobUrl;
      }
    };

    return () => {
      ws.close();
      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
    };
  }, [conversationId]);

  // Sync takeover state to server
  useEffect(() => {
    sendEvent({ type: 'takeover', active: takeover });
  }, [takeover, sendEvent]);

  function openBrowser() {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    sendEvent({ type: 'open', url: startUrl.trim() || undefined });
  }

  // Mouse event relay (only when takeover is on and we have a real session)
  const relayMouse = useCallback((action: 'move' | 'down' | 'up') => (e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeover || !status.session) return;
    const p = pagePoint(e.currentTarget, e.clientX, e.clientY);
    if (!p) return;
    if (action === 'move') {
      sendEvent({ type: 'mouse', action, x: p.x, y: p.y });
    } else {
      const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
      sendEvent({ type: 'mouse', action, x: p.x, y: p.y, button });
    }
  }, [takeover, status.session, sendEvent]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (!takeover || !status.session) return;
    e.preventDefault();
    sendEvent({ type: 'scroll', x: 0, y: 0, deltaX: e.deltaX, deltaY: e.deltaY });
  }, [takeover, status.session, sendEvent]);

  // Keyboard relay — only when panel is focused
  useEffect(() => {
    if (!takeover) return;
    function onKeyDown(e: KeyboardEvent) {
      // Don't eat browser shortcuts
      if (e.metaKey || (e.ctrlKey && ['c', 'v', 'x', 'a', 'z'].includes(e.key.toLowerCase()))) return;
      e.preventDefault();
      sendEvent({ type: 'keyboard', action: 'press', key: e.key });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [takeover, sendEvent]);

  // Keep a remembered height inside the window after it shrinks.
  useEffect(() => {
    const onResize = () => setHeight(h => clampHeight(h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persistHeight = useCallback((h: number) => {
    try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* not persisted */ }
  }, []);

  // Drag handle along the bottom edge (pointer capture keeps the drag alive outside the handle).
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStart.current = { y: e.clientY, h: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    setHeight(clampHeight(dragStart.current.h + (e.clientY - dragStart.current.y)));
  };
  const onHandleUp = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    setHeight(h => { persistHeight(h); return h; });
  };
  const onHandleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setHeight(h => {
      const next = clampHeight(h + (e.key === 'ArrowDown' ? 24 : -24));
      persistHeight(next);
      return next;
    });
  };

  return (
    <div
      className={`flex w-full flex-col overflow-hidden border-b border-border bg-bg ${fill ? 'min-h-0 flex-1' : 'shrink-0'}`}
      style={fill ? undefined : { height }}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary">
        <Monitor size={14} className="text-fg-secondary shrink-0" />
        <span className="text-xs font-medium text-fg flex-1 truncate">
          {status.url ? status.url : 'Browser'}
        </span>
        {!connected && !unavailable && <Loader size={12} className="animate-spin text-fg-tertiary" />}
        {connected && status.session && (
          <button
            onClick={() => setTakeover(t => !t)}
            title={takeover ? 'Release control' : 'Take control of browser'}
            className={`flex items-center gap-1 rounded-button px-2 py-0.5 text-xs font-medium transition-colors ${
              takeover
                ? 'bg-warning/20 text-warning border border-warning/40'
                : 'border border-border text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            <Hand size={11} />
            {takeover ? 'In control' : 'Take control'}
          </button>
        )}
        <button
          onClick={onClose}
          className="text-fg-tertiary hover:text-fg-secondary"
          aria-label="Close browser panel"
        >
          <X size={14} />
        </button>
      </div>

      {/* Live view */}
      <div className="relative min-h-0 flex-1 bg-black">
        {unavailable && (
          <div className="flex h-full min-h-24 items-center justify-center px-4 text-center text-xs text-fg-tertiary">
            Live view is unavailable — the browser service is not reachable or not configured.
          </div>
        )}
        {!unavailable && !connected && (
          <div className="flex h-full min-h-24 items-center justify-center gap-2 text-xs text-fg-tertiary">
            <Loader size={14} className="animate-spin" /> Connecting…
          </div>
        )}
        {connected && !status.session && (
          <form
            className="flex h-full min-h-24 flex-col items-center justify-center gap-3 px-4 text-center"
            onSubmit={e => { e.preventDefault(); openBrowser(); }}
          >
            <p className="text-xs text-fg-tertiary">No active browser session for this conversation.</p>
            <input
              value={startUrl}
              onChange={e => setStartUrl(e.target.value)}
              placeholder="Start page (optional), e.g. example.com"
              aria-label="Start page URL"
              disabled={opening}
              className="w-full max-w-xs rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-border-hover disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={opening}
              className="flex items-center gap-1.5 rounded-button bg-fg px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-60"
            >
              {opening ? <Loader size={12} className="animate-spin" /> : <Globe size={12} />}
              {opening ? 'Opening…' : 'Open browser'}
            </button>
            {openError && <p role="alert" className="max-w-xs text-xs text-danger">{openError}</p>}
          </form>
        )}
        {connected && status.session && (
          <>
            {takeover && (
              <div className="absolute top-2 left-2 z-10 rounded px-2 py-0.5 text-xs font-semibold bg-warning/80 text-black select-none pointer-events-none">
                You have control
              </div>
            )}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <img
              ref={imgRef}
              alt="Live browser view"
              className="block h-full w-full object-contain"
              style={{ cursor: takeover ? 'crosshair' : 'default', imageRendering: 'auto' }}
              onMouseMove={relayMouse('move')}
              onMouseDown={relayMouse('down')}
              onMouseUp={relayMouse('up')}
              onWheel={handleWheel}
              onContextMenu={e => { if (takeover) e.preventDefault(); }}
              draggable={false}
            />
          </>
        )}
      </div>

      {!fill && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize browser panel"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={maxHeight()}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={onHandleKey}
          className="h-1.5 shrink-0 cursor-row-resize touch-none bg-border/60 hover:bg-border-hover focus-visible:bg-border-hover"
        />
      )}
    </div>
  );
}

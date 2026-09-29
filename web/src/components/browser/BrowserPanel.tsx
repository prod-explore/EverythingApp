import { useEffect, useRef, useState, useCallback } from 'react';
import { Monitor, Hand, X, Loader } from 'lucide-react';
import { getToken } from '../../api';

/**
 * §6b Chunk B: Live-view panel for an active browser session.
 *
 * Connects to playwright-mcp's WebSocket at
 *   ws://<host>/mcp/liveview?conversationId=<id>&token=<token>
 * The WS URL is composed from the VITE_PLAYWRIGHT_WS_URL env var + query params.
 *
 * Two modes:
 * 1. Watch-only (default): streams JPEG frames from the active session as <img> blobs.
 * 2. Takeover: sends mouse/keyboard events back to the session. Toggle with the
 *    "Take control" button. Visual indicator shows when takeover is active.
 *
 * The PLAYWRIGHT_MCP_WS_URL env variable must be set in the browser environment
 * (Vite: VITE_PLAYWRIGHT_WS_URL, e.g. ws://192.168.1.50:3003). If absent the
 * panel shows a setup prompt.
 */

const WS_BASE = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_PLAYWRIGHT_WS_URL'] ?? '';

interface Status {
  session: boolean;
  url?: string;
  takeover?: boolean;
}

export function BrowserPanel({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<Status>({ session: false });
  const [takeover, setTakeover] = useState(false);
  const [connected, setConnected] = useState(false);
  const prevBlobUrl = useRef<string | null>(null);

  // Keyboard + mouse events when takeover is active
  const sendEvent = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    if (!WS_BASE) return;
    const token = getToken() ?? '';
    const url = `${WS_BASE}/mcp/liveview?conversationId=${encodeURIComponent(conversationId)}&token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);
    ws.binaryType = 'blob';
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => { setConnected(false); wsRef.current = null; };

    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        try {
          const data = JSON.parse(evt.data) as Status;
          setStatus(data);
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

  // Mouse event relay (only when takeover is on and we have a real session)
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeover || !status.session) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * (e.currentTarget.naturalWidth || 1280);
    const y = ((e.clientY - rect.top) / rect.height) * (e.currentTarget.naturalHeight || 720);
    sendEvent({ type: 'mouse', action: 'move', x: Math.round(x), y: Math.round(y) });
  }, [takeover, status.session, sendEvent]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeover || !status.session) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * (e.currentTarget.naturalWidth || 1280);
    const y = ((e.clientY - rect.top) / rect.height) * (e.currentTarget.naturalHeight || 720);
    const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendEvent({ type: 'mouse', action: 'down', x: Math.round(x), y: Math.round(y), button: btn });
  }, [takeover, status.session, sendEvent]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeover || !status.session) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * (e.currentTarget.naturalWidth || 1280);
    const y = ((e.clientY - rect.top) / rect.height) * (e.currentTarget.naturalHeight || 720);
    const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendEvent({ type: 'mouse', action: 'up', x: Math.round(x), y: Math.round(y), button: btn });
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

  return (
    <div className="flex flex-col bg-bg border border-border rounded-lg overflow-hidden shadow-xl" style={{ minWidth: 360, maxWidth: 700 }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary">
        <Monitor size={14} className="text-fg-secondary shrink-0" />
        <span className="text-xs font-medium text-fg flex-1 truncate">
          {status.url ? status.url : 'Browser'}
        </span>
        {!connected && <Loader size={12} className="animate-spin text-fg-tertiary" />}
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
      <div className="relative bg-black" style={{ minHeight: 200 }}>
        {!WS_BASE && (
          <div className="flex items-center justify-center h-40 text-xs text-fg-tertiary px-4 text-center">
            Set <code className="mx-1 text-fg-secondary">VITE_PLAYWRIGHT_WS_URL</code> to enable live browser view.
          </div>
        )}
        {WS_BASE && !connected && (
          <div className="flex items-center justify-center h-40 text-xs text-fg-tertiary gap-2">
            <Loader size={14} className="animate-spin" /> Connecting…
          </div>
        )}
        {WS_BASE && connected && !status.session && (
          <div className="flex items-center justify-center h-40 text-xs text-fg-tertiary">
            No active browser session for this conversation.
          </div>
        )}
        {WS_BASE && connected && status.session && (
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
              className="w-full h-auto block"
              style={{ cursor: takeover ? 'crosshair' : 'default', imageRendering: 'auto' }}
              onMouseMove={handleMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onWheel={handleWheel}
              onContextMenu={e => { if (takeover) e.preventDefault(); }}
              draggable={false}
            />
          </>
        )}
      </div>
    </div>
  );
}

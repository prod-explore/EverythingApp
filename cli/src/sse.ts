import type { Response } from 'express';

export type SSEEventName =
  | 'turn:start'
  | 'turn:text'
  | 'turn:text_delta'
  | 'turn:thinking_delta'
  | 'turn:tool_use'
  | 'turn:tool_result'
  | 'turn:done'
  | 'turn:error'
  | 'turn:aborted'
  | 'approval:pending'
  | 'approval:resolved'
  | 'conversation:titled'
  | 'conversation:state'
  | 'conversation:compacted'
  | 'turn:context'
  | 'gazeta:new'
  | 'gazeta:responded'
  | 'gazeta:dismissed'
  | 'agent:spawned'
  | 'agent:finished'
  | 'agent:budget_warning'
  | 'artifact:new'
  | 'provider:retry'
  | 'keepalive';

/** Bytes a single event-stream client may have waiting before it is dropped. */
const MAX_CLIENT_BACKLOG = 1024 * 1024;

export class SSEManager {
  private clients = new Map<string, Set<Response>>();

  addClient(conversationId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
    res.flushHeaders();
    res.write(': keepalive\n\n'); // initial comment to confirm connection

    if (!this.clients.has(conversationId)) {
      this.clients.set(conversationId, new Set());
    }
    this.clients.get(conversationId)!.add(res);

    res.on('close', () => this.removeClient(conversationId, res));
  }

  removeClient(conversationId: string, res: Response): void {
    this.clients.get(conversationId)?.delete(res);
    if (this.clients.get(conversationId)?.size === 0) {
      this.clients.delete(conversationId);
    }
  }

  /** Ends every open stream (shutdown): a server cannot finish closing while event streams are held open. */
  closeAll(): void {
    for (const bucket of this.clients.values()) {
      for (const res of bucket) {
        try { res.end(); } catch { /* already gone */ }
      }
    }
    this.clients.clear();
  }

  emit(conversationId: string, event: SSEEventName, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bucket = this.clients.get(conversationId);
    if (!bucket) return;
    for (const res of bucket) {
      try {
        res.write(payload);
        // A client on a dead connection never drains its buffer; cut it loose (it resyncs through /status on reconnect).
        if (res.writableLength > MAX_CLIENT_BACKLOG) {
          this.removeClient(conversationId, res);
          res.destroy();
        }
      } catch {
        this.removeClient(conversationId, res);
      }
    }
  }

  /** Broadcast to ALL connected clients (e.g. gazeta updates). */
  emitAll(event: SSEEventName, data: unknown): void {
    for (const conversationId of this.clients.keys()) {
      this.emit(conversationId, event, data);
    }
  }

  /** Send SSE keepalive pings to prevent proxy timeouts. */
  startKeepalive(intervalMs = 25_000): ReturnType<typeof setInterval> {
    return setInterval(() => {
      for (const conversationId of this.clients.keys()) {
        this.emit(conversationId, 'keepalive', { ts: Date.now() });
      }
    }, intervalMs);
  }
}

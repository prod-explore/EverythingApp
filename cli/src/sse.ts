import type { Response } from 'express';

export type SSEEventName =
  | 'turn:start'
  | 'turn:text'
  | 'turn:tool_use'
  | 'turn:tool_result'
  | 'turn:done'
  | 'turn:error'
  | 'turn:aborted'
  | 'approval:pending'
  | 'approval:resolved'
  | 'batch:resolved'
  | 'gazeta:new'
  | 'keepalive';

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

  emit(conversationId: string, event: SSEEventName, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bucket = this.clients.get(conversationId);
    if (!bucket) return;
    for (const res of bucket) {
      try {
        res.write(payload);
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

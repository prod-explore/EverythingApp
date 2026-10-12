import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpConnection } from '../mcp-client.js';

const KEY = 'secret-key-123';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '1' });
  server.tool('echo', 'Echo text', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text' as const, text: `echo:${text}` }] }));
  return server;
}

const body = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch { resolve(null); } });
  });

describe('McpConnection transports', () => {
  let srv: http.Server;
  let base: string;
  const sseSessions = new Map<string, SSEServerTransport>();
  const seen: string[] = [];

  before(async () => {
    srv = http.createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('unauthorized'); return; }
      const url = new URL(req.url ?? '/', 'http://x');
      // Legacy HTTP+SSE server, mounted under /mcp/sse like obsidian-livesync-mcp.
      if (req.method === 'GET' && url.pathname === '/mcp/sse') {
        seen.push('sse');
        const transport = new SSEServerTransport('/mcp/messages', res);
        sseSessions.set(transport.sessionId, transport);
        await makeServer().connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp/messages') {
        const t = sseSessions.get(url.searchParams.get('sessionId') ?? '');
        if (!t) { res.writeHead(404).end(); return; }
        await t.handlePostMessage(req, res, await body(req));
        return;
      }
      // Streamable HTTP server (stateless), at /mcp.
      if (url.pathname === '/mcp' || url.pathname === '/modern/mcp/sse') {
        seen.push('streamable');
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await makeServer().connect(transport);
        await transport.handleRequest(req, res, await body(req));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });

  after(async () => {
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  });

  it('falls back to the legacy HTTP+SSE transport (the Obsidian connector), with the bearer key on the stream and the POSTs', async () => {
    const conn = new McpConnection({ name: 'obsidian', url: `${base}/mcp/sse`, apiKey: KEY });
    await conn.connect();
    assert.deepEqual((await conn.listTools()).map(t => t.name), ['echo']);
    assert.deepEqual(await conn.callTool('echo', { text: 'hi' }), { text: 'echo:hi', isError: false });
    await conn.close();
  });

  it('connects to a Streamable HTTP server', async () => {
    seen.length = 0;
    const conn = new McpConnection({ name: 'sandbox', url: `${base}/mcp`, apiKey: KEY });
    await conn.connect();
    assert.deepEqual(await conn.callTool('echo', { text: 'x' }), { text: 'echo:x', isError: false });
    assert.equal(seen[0], 'streamable');
    await conn.close();
  });

  it('a Streamable server that happens to be mounted under …/sse is still reached over Streamable HTTP', async () => {
    seen.length = 0;
    const conn = new McpConnection({ name: 'sandbox', url: `${base}/modern/mcp/sse`, apiKey: KEY });
    await conn.connect();
    assert.deepEqual(await conn.callTool('echo', { text: 'y' }), { text: 'echo:y', isError: false });
    assert.ok(seen.length > 0 && seen.every(s => s === 'streamable'), 'no SSE attempt was needed');
    await conn.close();
  });

  it('reports the failure when neither transport works (wrong key)', async () => {
    const conn = new McpConnection({ name: 'bad', url: `${base}/mcp/sse`, apiKey: 'wrong' });
    await assert.rejects(conn.connect());
    await assert.rejects(conn.listTools(), /not connected/);
  });
});

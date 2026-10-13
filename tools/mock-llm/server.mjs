#!/usr/bin/env node
/**
 * Scriptable OpenAI-compatible mock LLM for local E2E tests and CI (no API keys, deterministic).
 *
 * Add it in EverythingApp like any provider (Settings → Models → + Other, or the MindGate preset with
 * MINDGATE_BASE_URL=http://127.0.0.1:4010/v1): base URL http://127.0.0.1:4010/v1, "No key needed";
 *   its model list (GET /models) offers "mock-1" and "mock-fast" (both reported as `locality: local`, so ghost chats can be tried).
 *
 * Behaviour is driven by the latest user message (case-insensitive):
 *   "ask: <q>"          → request_human_input (blocking form with fields)
 *   "ask later: <q>"    → request_human_input with wait=false
 *   "report"            → post_report (urgent)
 *   "bash: <cmd>"       → the first tool whose name ends with run_bash
 *   "browse: <url>"     → browser_open
 *   "fetch: <url>"      → web_fetch
 *   "search: <query>"   → web_search
 *   "spawn"             → spawn_agent (worker on the default agent model) then wait_agents
 *   "tool: <name> <json>" → call any tool by (suffix) name with JSON args
 *   "todo"              → todo_write with a three-item list
 *   "plan: <task>"      → propose_plan (the tool exists only while plan mode is on)
 *   "long"              → long markdown answer (streamed slowly)
 *   "error"             → HTTP 500
 * Worker agents (system prompt contains "worker agent") answer with a short report.
 * A compaction request (system prompt "…compress the earlier part…") is answered with a fixed summary.
 * After any tool result the model summarises it. Supports stream:true (SSE) and plain JSON.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4010);
const DELAY = Number(process.env.MOCK_LLM_DELAY_MS ?? 25);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p.text ?? '')).join(' ');
  return '';
}

function findTool(tools, suffix) {
  return (tools ?? []).map(t => t.function?.name).find(n => n === suffix || n?.endsWith(`__${suffix}`) || n?.endsWith(suffix));
}

let callSeq = 0;
const call = (name, args) => ({ id: `call_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** Decide the assistant turn: { text?, toolCalls? } */
function decide(body) {
  const msgs = body.messages ?? [];
  const system = msgs.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n');
  const last = msgs[msgs.length - 1] ?? {};
  const tools = body.tools ?? [];

  if (system.includes('worker agent')) {
    const goal = /goal:\s*\n\n([\s\S]*?)\n\n/.exec(system)?.[1] ?? 'the task';
    if (last.role === 'tool') return { text: `Worker report: finished "${goal.slice(0, 80)}". Tool output looked fine.` };
    return { text: `Worker report: analysed "${goal.slice(0, 80)}". Result: 42 items checked, no problems found.` };
  }

  if (/compress the earlier part/i.test(system)) return { text: 'Summary: the user chatted with the mock model about markdown, tools and agents.' };

  if (last.role === 'tool') {
    const out = textOf(last.content);
    const spawned = /Spawned (\w+)/.exec(out);
    if (spawned) {
      const wait = findTool(tools, 'wait_agents');
      if (wait) return { text: 'Waiting for the worker…', toolCalls: [call(wait, { run_ids: [spawned[1]] })] };
    }
    return { text: `Done. The tool returned:\n\n\`\`\`\n${out.slice(0, 600)}\n\`\`\`` };
  }

  const user = textOf(last.content).trim();
  const lower = user.toLowerCase();

  if (lower.startsWith('ask later:')) {
    const t = findTool(tools, 'request_human_input');
    if (t) return { text: 'I queued a question; continuing meanwhile.', toolCalls: [call(t, { title: user.slice(10).trim() || 'Question', description: 'Answer whenever you like.', wait: false })] };
  }
  if (lower.startsWith('ask:')) {
    const t = findTool(tools, 'request_human_input');
    if (t) return {
      toolCalls: [call(t, {
        title: user.slice(4).trim() || 'Need your input',
        description: 'I need two details before continuing:\n\n- **environment** to deploy to\n- a short **reason**',
        fields: [
          { name: 'env', label: 'Environment', type: 'select', options: ['staging', 'production'] },
          { name: 'reason', label: 'Reason', type: 'text' },
        ],
      })],
    };
  }
  if (lower.startsWith('report')) {
    const t = findTool(tools, 'post_report');
    if (t) return { toolCalls: [call(t, { title: 'Nightly check finished', body: '## Summary\n\n- 3 services healthy\n- 1 warning: disk 81%\n\nNo action needed today.', urgent: true })] };
  }
  if (lower === 'todo') {
    const t = findTool(tools, 'todo_write');
    if (t) return { text: 'Planning the work.', toolCalls: [call(t, { todos: [{ content: 'Read the code', status: 'completed' }, { content: 'Write the change', status: 'in_progress' }, { content: 'Run the tests', status: 'pending' }] })] };
  }
  if (lower.startsWith('plan:')) {
    const t = findTool(tools, 'propose_plan');
    if (t) return { toolCalls: [call(t, { plan: `## Plan for ${user.slice(5).trim() || 'the task'}\n\n1. Read the relevant files\n2. Make the change\n3. Run the tests\n\n**Open question:** which branch?` })] };
    return { text: 'Plan mode is off, so there is nothing to propose.' };
  }
  if (lower.startsWith('bash:')) {
    const t = findTool(tools, 'run_bash');
    if (t) return { toolCalls: [call(t, { command: user.slice(5).trim() })] };
    return { text: 'No shell tool is connected (the sandbox connector is not available).' };
  }
  if (lower.startsWith('browse:')) {
    const url = user.slice(7).trim();
    const t = findTool(tools, 'browser_open');
    if (t) return { toolCalls: [call(t, { url })] };
    return { text: 'No browser tool is connected.' };
  }
  if (lower.startsWith('fetch:')) {
    const t = findTool(tools, 'web_fetch');
    if (t) return { toolCalls: [call(t, { url: user.slice(6).trim() })] };
    return { text: 'web_fetch is not available.' };
  }
  if (lower.startsWith('search:')) {
    const t = findTool(tools, 'web_search');
    if (t) return { toolCalls: [call(t, { query: user.slice(7).trim() })] };
    return { text: 'web_search is not configured (Settings → Web).' };
  }
  if (lower.startsWith('spawn')) {
    const t = findTool(tools, 'spawn_agent');
    if (t) return { text: 'Delegating to a worker.', toolCalls: [call(t, { goal: 'Count the open TODOs in the project and report them.', label: 'counter' })] };
  }
  if (lower.startsWith('tool:')) {
    const m = /^tool:\s*(\S+)\s*(\{[\s\S]*\})?$/i.exec(user);
    const t = m && findTool(tools, m[1]);
    if (t) return { toolCalls: [call(t, m[2] ? JSON.parse(m[2]) : {})] };
    return { text: `No tool matching "${m?.[1] ?? ''}". Available: ${tools.map(x => x.function?.name).join(', ') || 'none'}` };
  }
  if (lower === 'long') {
    return {
      text: '# A longer answer\n\nHere is some **markdown** with a list:\n\n1. First point\n2. Second point with `inline code`\n3. Third\n\n```ts\nfunction greet(name: string) {\n  return `Hello, ${name}!`;\n}\n```\n\n| Column | Value |\n|---|---|\n| a | 1 |\n| b | 2 |\n\n> A quote to finish.',
    };
  }
  return { text: `You said: **${user.slice(0, 200) || '(nothing)'}**\n\nI'm the mock model — try \`ask: …\`, \`report\`, \`bash: ls\`, \`spawn\` or \`long\`.` };
}

function usage(body, text) {
  return { prompt_tokens: JSON.stringify(body.messages ?? []).length >> 2, completion_tokens: (text?.length ?? 0) >> 2 };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-1', name: 'Mock 1', context_length: 20000, supports: ['tools', 'reasoning_effort'], locality: 'local' }, { id: 'mock-fast', name: 'Mock Fast', locality: 'local' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
  if (textOf(lastUser?.content).trim().toLowerCase() === 'error' && body.messages?.at(-1)?.role === 'user') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock upstream failure' } }));
    return;
  }
  const { text, toolCalls } = decide(body);
  const finish = toolCalls?.length ? 'tool_calls' : 'stop';

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `mock-${Date.now()}`, model: body.model,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: text ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      usage: usage(body, text),
    }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const id = `mock-${Date.now()}`;
  if (text) {
    const pieces = text.match(/.{1,12}/gs) ?? [];
    const delay = body.messages?.at(-1) && textOf(body.messages.at(-1).content).trim().toLowerCase() === 'long' ? DELAY * 3 : DELAY;
    for (const p of pieces) {
      send({ id, model: body.model, choices: [{ index: 0, delta: { content: p } }] });
      await sleep(delay);
    }
  }
  (toolCalls ?? []).forEach((tc, index) => {
    const args = tc.function.arguments;
    send({ id, choices: [{ index: 0, delta: { tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args.slice(0, 10) } }] } }] });
    send({ id, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(10) } }] } }] });
  });
  send({ id, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  send({ id, choices: [], usage: usage(body, text) });
  res.end('data: [DONE]\n\n');
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1`));

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { connectorsApi, getConnectors } from '../../../api';
import type { ConnectorInfo, ConnectorTestResult } from '../../../types';
import { Badge } from '../../shared/Badge';
import { Button } from '../../shared/Button';

const field = 'w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover';

/**
 * Connectors tab: MCP servers, added by URL like in Claude. The list shows everything that is connected — built-in
 * connectors (configured by the operator, read-only) and the ones added here (test, edit, reconnect, disable, remove).
 */
export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setConnectors((await getConnectors()).connectors); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Runs an action, then refreshes the list. */
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    await load();
  }, [load]);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-2 text-sm font-medium text-fg">Connectors</h3>
        {connectors === null ? (
          <p className="text-sm text-fg-tertiary">Loading connectors…</p>
        ) : connectors.length === 0 ? (
          <p className="text-sm text-fg-tertiary">No connectors yet. Add an MCP server below.</p>
        ) : (
          <ul className="space-y-2">
            {connectors.map(c => <ConnectorRow key={c.name} c={c} act={act} />)}
          </ul>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        {notice && <p className="mt-2 text-xs text-fg-secondary">{notice}</p>}
      </section>

      <AddConnector onAdded={msg => { setNotice(msg); void load(); }} />

      <p className="text-xs text-fg-tertiary">
        Tools of connectors you add here ask for approval before they run. Pick <strong>Always approve</strong> in the approval dialog to stop asking for a tool.
      </p>
    </div>
  );
}

function ConnectorRow({ c, act }: { c: ConnectorInfo; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(c.url);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const custom = c.source === 'custom';

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await act(fn); } finally { setBusy(false); } };

  return (
    <li className="rounded-button border border-border">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open}>
        {open ? <ChevronDown size={14} className="shrink-0 text-fg-tertiary" /> : <ChevronRight size={14} className="shrink-0 text-fg-tertiary" />}
        <span className="font-mono text-sm text-fg">{c.name}</span>
        {!custom && <Badge>built-in</Badge>}
        <span className="min-w-0 flex-1 truncate text-xs text-fg-tertiary" title={c.url}>{c.url}</span>
        {!c.enabled ? <Badge>disabled</Badge> : c.connected ? <Badge tone="success">{c.toolCount} tools</Badge> : <Badge tone="danger">disconnected</Badge>}
      </button>

      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {c.error && <p className="break-words text-xs text-danger">{c.error}</p>}

          {editing ? (
            <div className="space-y-2">
              <input className={field} value={url} onChange={e => setUrl(e.target.value)} aria-label="Connector URL" />
              <input
                className={field}
                type="password"
                value={token}
                disabled={clearToken}
                onChange={e => setToken(e.target.value)}
                placeholder={c.hasToken ? 'New token (leave empty to keep the current one)' : 'Bearer token (optional)'}
                aria-label="Token"
              />
              {c.hasToken && (
                <label className="flex items-center gap-2 text-xs text-fg-secondary">
                  <input type="checkbox" checked={clearToken} onChange={e => setClearToken(e.target.checked)} /> Remove the saved token
                </label>
              )}
              <div className="flex gap-2">
                <Button disabled={busy || !url.trim()} onClick={() => void run(async () => {
                  await connectorsApi.update(c.name, { url: url.trim(), ...(clearToken ? { token: null } : token.trim() ? { token: token.trim() } : {}) });
                  setEditing(false); setToken(''); setClearToken(false);
                })}>Save and reconnect</Button>
                <Button variant="ghost" onClick={() => { setEditing(false); setUrl(c.url); setToken(''); setClearToken(false); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <button disabled={busy} onClick={() => void run(() => connectorsApi.reconnect(c.name))} className="flex items-center gap-1 text-fg-secondary hover:text-fg disabled:opacity-40">
                <RefreshCw size={12} /> Reconnect
              </button>
              {custom && (
                <button onClick={() => { setUrl(c.url); setEditing(true); }} className="flex items-center gap-1 text-fg-secondary hover:text-fg">
                  <Pencil size={12} /> Edit
                </button>
              )}
              {custom && c.enabled && (
                <button disabled={busy} onClick={() => void run(() => connectorsApi.disable(c.name))} className="text-fg-secondary underline hover:text-fg disabled:opacity-40">Disable</button>
              )}
              {custom && (
                <button
                  disabled={busy}
                  onClick={() => { if (confirm(`Remove connector ${c.name}?`)) void run(() => connectorsApi.remove(c.name)); }}
                  className="ml-auto flex items-center gap-1 text-fg-tertiary hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={12} /> Remove
                </button>
              )}
              {custom && !c.enabled && <span className="text-fg-tertiary">Disabled — Reconnect turns it back on.</span>}
            </div>
          )}

          {c.tools.length > 0 ? (
            <ul className="max-h-60 divide-y divide-border overflow-auto rounded-button border border-border">
              {c.tools.map(t => (
                <li key={t.name} className="px-2 py-1.5">
                  <div className="font-mono text-xs text-fg">{t.name}</div>
                  {t.description && <div className="mt-0.5 line-clamp-2 text-xs text-fg-tertiary">{t.description}</div>}
                </li>
              ))}
            </ul>
          ) : (
            c.connected && <p className="text-xs text-fg-tertiary">This server exposes no tools.</p>
          )}
        </div>
      )}
    </li>
  );
}

function AddConnector({ onAdded }: { onAdded: (message: string) => void }) {
  const [form, setForm] = useState({ url: '', token: '', name: '' });
  const [test, setTest] = useState<ConnectorTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'test' | 'add' | null>(null);
  const set = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); setTest(null); };

  async function runTest() {
    setBusy('test'); setError(null); setTest(null);
    try { setTest(await connectorsApi.test(form.url.trim(), form.token.trim() || undefined)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function add() {
    setBusy('add'); setError(null);
    try {
      const r = await connectorsApi.add({ url: form.url.trim(), token: form.token.trim() || undefined, name: form.name.trim() || undefined });
      setForm({ url: '', token: '', name: '' }); setTest(null);
      onAdded(r.error ? `Added “${r.name}”, but it could not connect: ${r.error}` : `Added “${r.name}” — ${r.connector.toolCount} tools.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium text-fg">Add a connector</h3>
      <p className="mb-2 text-xs text-fg-tertiary">Any remote MCP server — paste its URL (Streamable HTTP or SSE). Plain http:// works only for local addresses.</p>
      <div className="space-y-2">
        <input className={field} placeholder="https://example.com/mcp" value={form.url} onChange={e => set({ url: e.target.value })} aria-label="Connector URL" />
        <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
          <input className={field} type="password" placeholder="Bearer token (optional)" value={form.token} onChange={e => set({ token: e.target.value })} aria-label="Token" autoComplete="off" />
          <input className={field} placeholder="name (optional)" value={form.name} onChange={e => set({ name: e.target.value.toLowerCase() })} aria-label="Connector name" />
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy !== null || !form.url.trim()} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
          <Button disabled={busy !== null || !form.url.trim()} onClick={() => void add()}>{busy === 'add' ? 'Adding…' : 'Add'}</Button>
        </div>
      </div>
      {test && (
        test.ok
          ? <p role="status" className="mt-2 text-xs text-success">Connected{test.serverName ? ` to ${test.serverName}` : ''} — {test.tools?.length ?? 0} tools{test.tools?.length ? `: ${test.tools.slice(0, 6).map(t => t.name).join(', ')}${test.tools.length > 6 ? ', …' : ''}` : ''}.</p>
          : <p role="alert" className="mt-2 break-words text-xs text-danger">Could not connect: {test.error}</p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

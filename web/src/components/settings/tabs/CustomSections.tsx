import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, notifyUnauthorized } from '../../../api';
import { Button } from '../../shared/Button';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  if (res.status === 401) notifyUnauthorized();
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `request failed (${res.status})`, res.status);
  return body;
}

const field = 'w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover';

interface CustomConnector { name: string; url: string; enabled: boolean; connected: boolean; error: string | null; hasToken: boolean; toolCount: number }

/** N5: remote MCP servers (Streamable HTTP) added from the UI; tokens are stored encrypted. */
export function CustomConnectorsSection({ onChanged }: { onChanged: () => void }) {
  const [connectors, setConnectors] = useState<CustomConnector[]>([]);
  const [form, setForm] = useState({ name: '', url: '', token: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setConnectors((await req<{ connectors: CustomConnector[] }>('/api/custom-connectors')).connectors); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="mt-6">
      <h3 className="mb-1 text-sm font-medium text-fg">Add a connector</h3>
      <p className="mb-2 text-xs text-fg-tertiary">Remote MCP servers over HTTP(S). Their tools need approval like any other until you grant them.</p>
      <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
        <input className={field} placeholder="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value.toLowerCase() })} aria-label="Connector name" />
        <input className={field} placeholder="https://host/mcp" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} aria-label="Connector URL" />
      </div>
      <div className="mt-2 flex gap-2">
        <input className={field} type="password" placeholder="Bearer token (optional)" value={form.token} onChange={e => setForm({ ...form, token: e.target.value })} aria-label="Token" />
        <Button disabled={busy || !form.name || !form.url} onClick={() => void run(async () => {
          const r = await req<{ error: string | null }>('/api/custom-connectors', { method: 'POST', body: JSON.stringify(form) });
          setForm({ name: '', url: '', token: '' });
          if (r.error) throw new Error(`Saved, but could not connect: ${r.error}`);
        })}>Add</Button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {connectors.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-button border border-border">
          {connectors.map(c => (
            <li key={c.name} className="flex items-center gap-2 px-3 py-2 text-xs">
              <Plug size={13} className={c.connected ? 'text-success' : 'text-fg-tertiary'} />
              <span className="font-medium text-fg">{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-fg-tertiary" title={c.error ?? c.url}>{c.error ? `error: ${c.error}` : `${c.url} · ${c.toolCount} tools`}</span>
              {c.enabled
                ? <button onClick={() => void run(() => req(`/api/custom-connectors/${c.name}/disable`, { method: 'POST' }))} className="text-fg-tertiary underline hover:text-fg">Disable</button>
                : null}
              <button onClick={() => void run(() => req(`/api/custom-connectors/${c.name}/reconnect`, { method: 'POST' }))} className="rounded p-1 text-fg-tertiary hover:text-fg" aria-label={`Reconnect ${c.name}`}><RefreshCw size={13} /></button>
              <button onClick={() => { if (confirm(`Remove connector ${c.name}?`)) void run(() => req(`/api/custom-connectors/${c.name}`, { method: 'DELETE' })); }} className="rounded p-1 text-fg-tertiary hover:text-danger" aria-label={`Remove ${c.name}`}><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

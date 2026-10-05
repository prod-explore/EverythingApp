import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, getToken } from '../../../api';
import { Button } from '../../shared/Button';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `request failed (${res.status})`, res.status);
  return body;
}

interface CustomModel { id: string; label?: string; supportsImages?: boolean; toolSchemaMode?: 'full' | 'flat' | 'none'; pricing?: { input: number; output: number } | null }
interface CustomProvider { slug: string; label: string; baseUrl: string; keyOptional: boolean; models: CustomModel[]; hasKey: boolean; last4: string | null }

const field = 'w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover';

/** N5: OpenAI-compatible endpoints added by the user (OpenRouter, LM Studio, vLLM, Together…). Models appear as `@slug/model`. */
export function CustomProvidersSection({ onChanged }: { onChanged: () => void }) {
  const [providers, setProviders] = useState<CustomProvider[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ slug: '', label: '', baseUrl: '', apiKey: '', keyOptional: false });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setProviders((await req<{ providers: CustomProvider[] }>('/api/custom-providers')).providers); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setError(null);
    try {
      await req('/api/custom-providers', { method: 'POST', body: JSON.stringify({ ...form, models: [] }) });
      setForm({ slug: '', label: '', baseUrl: '', apiKey: '', keyOptional: false });
      setAdding(false);
      await load();
      onChanged();
    } catch (e) { setError((e as Error).message); }
  }

  async function saveModels(p: CustomProvider, models: CustomModel[]) {
    await req(`/api/custom-providers/${p.slug}`, { method: 'PATCH', body: JSON.stringify({ models }) });
    await load();
    onChanged();
  }

  async function discover(p: CustomProvider) {
    setStatus(s => ({ ...s, [p.slug]: 'Fetching model list…' }));
    try {
      const { models } = await req<{ models: Array<{ id: string; label?: string }> }>(`/api/custom-providers/${p.slug}/discover`, { method: 'POST' });
      const merged = [...p.models, ...models.filter(m => !p.models.some(x => x.id === m.id))];
      await saveModels(p, merged);
      setStatus(s => ({ ...s, [p.slug]: `${models.length} models found.` }));
    } catch (e) { setStatus(s => ({ ...s, [p.slug]: (e as Error).message })); }
  }

  async function test(p: CustomProvider) {
    const r = await req<{ ok: boolean; error?: string }>(`/api/custom-providers/${p.slug}/test`, { method: 'POST' });
    setStatus(s => ({ ...s, [p.slug]: r.ok ? 'Connection OK.' : r.error ?? 'Failed.' }));
  }

  async function setKey(p: CustomProvider) {
    const apiKey = prompt(`API key for ${p.label}`);
    if (!apiKey) return;
    try { await req(`/api/custom-providers/${p.slug}/key`, { method: 'PUT', body: JSON.stringify({ apiKey }) }); await load(); onChanged(); }
    catch (e) { setStatus(s => ({ ...s, [p.slug]: (e as Error).message })); }
  }

  async function remove(p: CustomProvider) {
    if (!confirm(`Remove ${p.label} and its key?`)) return;
    await req(`/api/custom-providers/${p.slug}`, { method: 'DELETE' });
    await load();
    onChanged();
  }

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-fg">Custom providers</h3>
        {!adding && <Button variant="ghost" onClick={() => setAdding(true)}>Add provider</Button>}
      </div>
      <p className="mb-2 text-xs text-fg-tertiary">Any OpenAI-compatible API (chat/completions). Models show up in the picker as <code>@slug/model</code>.</p>
      {adding && (
        <div className="mb-3 space-y-2 rounded-button border border-border p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={field} placeholder="slug (e.g. openrouter)" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })} aria-label="Slug" />
            <input className={field} placeholder="Label" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} aria-label="Label" />
          </div>
          <input className={field} placeholder="Base URL, e.g. https://openrouter.ai/api/v1" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} aria-label="Base URL" />
          <input className={field} type="password" placeholder="API key (stored encrypted)" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} aria-label="API key" />
          <label className="flex items-center gap-2 text-xs text-fg-secondary">
            <input type="checkbox" checked={form.keyOptional} onChange={e => setForm({ ...form, keyOptional: e.target.checked })} /> No key needed (local server)
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button onClick={() => void create()} disabled={!form.slug || !form.baseUrl}>Add</Button>
          </div>
        </div>
      )}
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      <div className="space-y-2">
        {providers.map(p => (
          <CustomProviderCard
            key={p.slug}
            p={p}
            status={status[p.slug]}
            onDiscover={() => void discover(p)}
            onTest={() => void test(p)}
            onSetKey={() => void setKey(p)}
            onRemove={() => void remove(p)}
            onSaveModels={models => void saveModels(p, models)}
          />
        ))}
      </div>
    </section>
  );
}

function CustomProviderCard({ p, status, onDiscover, onTest, onSetKey, onRemove, onSaveModels }: {
  p: CustomProvider; status?: string;
  onDiscover: () => void; onTest: () => void; onSetKey: () => void; onRemove: () => void; onSaveModels: (m: CustomModel[]) => void;
}) {
  const [newModel, setNewModel] = useState('');
  return (
    <div className="rounded-button border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg">{p.label}</span>
        <code className="text-xs text-fg-tertiary">@{p.slug}</code>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-tertiary">{p.baseUrl}</span>
        <button onClick={onRemove} className="rounded p-1 text-fg-tertiary hover:text-danger" aria-label={`Remove ${p.label}`}><Trash2 size={13} /></button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-fg-tertiary">
        <span>{p.keyOptional ? 'no key needed' : p.hasKey ? `key …${p.last4}` : 'no key'}</span>
        <button onClick={onSetKey} className="underline hover:text-fg">{p.hasKey ? 'Replace key' : 'Set key'}</button>
        <button onClick={onTest} className="underline hover:text-fg">Test</button>
        <button onClick={onDiscover} className="underline hover:text-fg">Fetch models</button>
        {status && <span className="text-fg-secondary">{status}</span>}
      </div>
      <ul className="mt-2 flex flex-wrap gap-1">
        {p.models.map(m => (
          <li key={m.id} className="flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-fg-secondary">
            {m.id}
            <button onClick={() => onSaveModels(p.models.filter(x => x.id !== m.id))} aria-label={`Remove model ${m.id}`} className="text-fg-tertiary hover:text-danger">×</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input className={field} placeholder="Add model id" value={newModel} onChange={e => setNewModel(e.target.value)} aria-label="Model id"
          onKeyDown={e => { if (e.key === 'Enter' && newModel.trim()) { onSaveModels([...p.models, { id: newModel.trim() }]); setNewModel(''); } }} />
      </div>
    </div>
  );
}

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

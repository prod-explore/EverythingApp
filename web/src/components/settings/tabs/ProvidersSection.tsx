import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import {
  addProvider,
  addProviderModel,
  deleteProviderKey,
  getProviders,
  listProviderModels,
  patchModel,
  refreshProviderModels,
  removeModel,
  removeProvider,
  saveProviderKey,
  testProvider,
  updateProvider,
} from '../../../api';
import { MODEL_KINDS } from '../../../types';
import type { CatalogModelRow, ModelKind, ModelLocality, ProviderInfo, ProvidersResponse } from '../../../types';
import { Button } from '../../shared/Button';

const inputCls =
  'w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary';
const smallInput = 'rounded-button border border-border bg-bg px-2 py-1 text-xs text-fg outline-none placeholder:text-fg-tertiary';

type Note = { ok: boolean; text: string } | null;

// ─── model editor ───────────────────────────────────────────────────────────

function ModelRow({ m, onChanged }: { m: CatalogModelRow; onChanged: () => void }) {
  const [tags, setTags] = useState(m.tags.join(', '));
  const [ctx, setCtx] = useState(m.contextLength?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);

  async function patch(p: Parameters<typeof patchModel>[1]) {
    setError(null);
    try { await patchModel(m.id, p); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  const commitTags = () => {
    const next = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (next.join(',') !== m.tags.join(',')) void patch({ tags: next });
  };

  const commitCtx = () => {
    const n = ctx.trim() === '' ? null : Number(ctx.replace(/[\s_,]/g, '').replace(/k$/i, '000'));
    if (n !== null && !(Number.isInteger(n) && n >= 1000)) { setError('Context window: a whole number of tokens (e.g. 128000 or 128k), or empty'); return; }
    if (n !== (m.contextLength ?? null)) void patch({ contextLength: n });
  };

  return (
    <li className="rounded-button border border-border px-2 py-1.5">
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={m.enabled} onChange={e => void patch({ enabled: e.target.checked })} aria-label={`Enable ${m.id}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-fg" title={m.description || m.label}>{m.label}</span>
            {m.toolSchemaMode === 'none' && <span className="rounded bg-bg-tertiary px-1 text-[10px] text-danger" title="No tool calls — this model is not offered for chat">no tools</span>}
          </div>
          <code className="block truncate text-[11px] text-fg-tertiary" title="The id the provider knows this model by">{m.id === m.upstream ? m.id : `${m.id} → ${m.upstream}`}</code>
        </div>
        {m.source === 'manual' && (
          <button
            onClick={() => void removeModel(m.id).then(onChanged).catch(e => setError((e as Error).message))}
            className="rounded p-1 text-fg-tertiary hover:text-danger"
            aria-label={`Remove ${m.id}`}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-6">
        <select
          value={m.kind}
          onChange={e => void patch({ kind: e.target.value as ModelKind })}
          className={smallInput}
          aria-label={`Kind of ${m.id}`}
        >
          {MODEL_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={tags}
          onChange={e => setTags(e.target.value)}
          onBlur={commitTags}
          onKeyDown={e => e.key === 'Enter' && (e.currentTarget.blur())}
          placeholder="tags: free, coder…"
          className={`${smallInput} w-40`}
          aria-label={`Tags of ${m.id}`}
        />
        <input
          value={ctx}
          onChange={e => setCtx(e.target.value)}
          onBlur={commitCtx}
          onKeyDown={e => e.key === 'Enter' && (e.currentTarget.blur())}
          placeholder="ctx"
          title="Context window in tokens (e.g. 128k). The app compacts long chats before they overflow; empty = unknown, it then reacts only when the provider refuses."
          className={`${smallInput} w-16`}
          aria-label={`Context window of ${m.id}`}
        />
        <select
          value={m.locality ?? ''}
          onChange={e => void patch({ locality: e.target.value === '' ? null : (e.target.value as ModelLocality) })}
          className={smallInput}
          title="Where this model runs. Ghost chats only use models marked local. Empty = unknown (treated as not local); a hub like MindGate reports it by itself."
          aria-label={`Where ${m.id} runs`}
        >
          <option value="">where? (unknown)</option>
          <option value="local">local</option>
          <option value="cloud">cloud</option>
        </select>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-fg-tertiary" title="The model accepts a reasoning effort (low / medium / high). Shows an Effort control in chats that use it.">
          <input type="checkbox" checked={m.supportsEffort === true} onChange={e => void patch({ supportsEffort: e.target.checked })} aria-label={`Reasoning effort for ${m.id}`} />
          effort
        </label>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}

function ModelsEditor({ p, onChanged }: { p: ProviderInfo; onChanged: () => void }) {
  const [models, setModels] = useState<CatalogModelRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [newId, setNewId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => { listProviderModels(p.id).then(r => setModels(r.models)).catch(e => setError((e as Error).message)); }, [p.id]);
  useEffect(load, [load, p.modelCount]);
  const changed = () => { load(); onChanged(); };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (models ?? []).filter(m => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q) || m.tags.some(t => t.includes(q)));
  }, [models, filter]);

  async function add() {
    setError(null);
    try { await addProviderModel(p.id, newId.trim()); setNewId(''); changed(); } catch (e) { setError((e as Error).message); }
  }

  if (!models) return <p className="mt-2 text-xs text-fg-tertiary">Loading models…</p>;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={`Filter ${models.length} models…`} className={inputCls} aria-label="Filter models" />
      </div>
      {models.length === 0 && <p className="text-xs text-fg-tertiary">No models yet — use “Refresh models”, or add an id by hand below.</p>}
      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {shown.slice(0, 200).map(m => <ModelRow key={`${m.id}:${m.tags.join()}:${m.kind}:${m.enabled}:${m.toolSchemaMode ?? ''}`} m={m} onChanged={changed} />)}
      </ul>
      {shown.length > 200 && <p className="text-xs text-fg-tertiary">Showing 200 of {shown.length} — narrow the filter.</p>}
      <div className="flex gap-2">
        <input
          value={newId}
          onChange={e => setNewId(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && newId.trim() && void add()}
          placeholder="Add a model id by hand (as the provider names it)"
          className={inputCls}
          aria-label="Model id"
        />
        <Button variant="ghost" onClick={() => void add()} disabled={!newId.trim()}>Add</Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <p className="text-xs text-fg-tertiary">
        Tags are free-form. <code>free</code> marks a model as costing nothing (the cost guard for agents); others like <code>coder</code>,
        <code> reasoning</code> or <code>vision</code> help the assistant pick a model for a job. Only <code>chat</code> models that can call tools show in the pickers.
      </p>
    </div>
  );
}

// ─── provider card ──────────────────────────────────────────────────────────

function ProviderCard({ p, vaultEnabled, onChanged }: { p: ProviderInfo; vaultEnabled: boolean; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [retry, setRetry] = useState(p.retryMin?.toString() ?? '');
  const [conc, setConc] = useState(p.concurrency?.toString() ?? '');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try { await fn(); } catch (e) { setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  const saveNumber = (field: 'retryMin' | 'concurrency', raw: string, lo: number, hi: number) =>
    run(async () => {
      const n = raw.trim() === '' ? null : Number(raw);
      if (n !== null && !(Number.isInteger(n) && n >= lo && n <= hi)) throw new Error(`Enter a whole number from ${lo} to ${hi}, or leave empty for the default`);
      if (n === p[field]) return;
      await updateProvider(p.id, { [field]: n });
      onChanged();
    });

  const refreshModels = () =>
    run(async () => {
      const r = await refreshProviderModels(p.id);
      setNote(r.ok
        ? { ok: true, text: `${r.count} models found${r.added ? `, ${r.added} new` : ''}${r.removed ? `, ${r.removed} gone` : ''}.` }
        : { ok: false, text: r.error });
      onChanged();
    });

  const saveKey = () =>
    run(async () => {
      const r = await saveProviderKey(p.id, key.trim());
      setKey('');
      setNote(r.verified === false
        ? { ok: false, text: `Saved, but the provider rejected it: ${r.verifyError ?? 'unknown error'}` }
        : { ok: true, text: r.verified ? 'Saved and verified.' : 'Saved.' });
      onChanged();
    });

  const status = p.configured
    ? p.source === 'vault' ? `Key stored encrypted · ends in ${p.last4 ?? '????'}` : 'No key needed'
    : p.needsReentry
      ? 'Stored key can’t be decrypted with the current KEY_VAULT_SECRET — enter it again'
      : 'No key';

  return (
    <div className={`rounded-button border border-border px-4 py-3 ${p.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(o => !o)} className="text-fg-tertiary hover:text-fg" aria-label={open ? 'Hide models' : 'Show models'}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-sm font-medium text-fg">{p.label}</span>
        <code className="text-xs text-fg-tertiary">@{p.id}</code>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-tertiary" title={p.baseUrl}>{p.baseUrl}</span>
        <label className="flex items-center gap-1 text-xs text-fg-secondary">
          <input type="checkbox" checked={p.enabled} onChange={e => void run(async () => { await updateProvider(p.id, { enabled: e.target.checked }); onChanged(); })} />
          On
        </label>
        <button
          onClick={() => window.confirm(`Remove ${p.label}, its models and its stored key?`) && void run(async () => { await removeProvider(p.id); onChanged(); })}
          className="rounded p-1 text-fg-tertiary hover:text-danger"
          aria-label={`Remove ${p.label}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <p className="mb-3 mt-1 text-xs text-fg-tertiary">
        {status} · {p.enabledModelCount}/{p.modelCount} models on
      </p>

      {!p.keyOptional && (
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={e => setKey(e.target.value)}
            disabled={!vaultEnabled || busy}
            placeholder={p.source === 'vault' ? 'Paste a new key to replace it' : 'API key'}
            className={inputCls}
          />
          <button
            onClick={() => void saveKey()}
            disabled={!vaultEnabled || busy || key.trim().length < 8}
            className="shrink-0 rounded-button border border-border px-3 py-2 text-sm text-fg hover:border-border-hover disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-secondary">
        <label
          className="flex items-center gap-2"
          title="Tick this only for a server that runs on your own hardware (Ollama or vLLM on your LAN). Ghost chats may then use all of its models, except those it reports as cloud. Changing the URL clears it."
        >
          <input type="checkbox" checked={p.local} onChange={e => void run(async () => { await updateProvider(p.id, { local: e.target.checked }); onChanged(); })} aria-label={`${p.label} runs on my own hardware`} />
          Runs on my own hardware
        </label>
        <label className="flex items-center gap-2" title="Keep retrying overloaded / rate-limited answers for this long (peak hours). Empty = two quick retries.">
          Retry busy errors for
          <input inputMode="numeric" value={retry} onChange={e => setRetry(e.target.value)} onBlur={() => void saveNumber('retryMin', retry, 1, 1440)} placeholder="off" className="w-16 rounded-button border border-border bg-bg-secondary px-2 py-1 text-xs text-fg outline-none" aria-label={`Minutes to retry busy errors from ${p.label}`} />
          min
        </label>
        <label className="flex items-center gap-2" title="How many requests agent workers may send to this provider at once. Empty = 3. Use 1 for a server that handles one request at a time.">
          Parallel requests
          <input inputMode="numeric" value={conc} onChange={e => setConc(e.target.value)} onBlur={() => void saveNumber('concurrency', conc, 1, 32)} placeholder="3" className="w-16 rounded-button border border-border bg-bg-secondary px-2 py-1 text-xs text-fg outline-none" aria-label={`Parallel requests to ${p.label}`} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <button
          onClick={() => void run(async () => { const r = await testProvider(p.id); setNote({ ok: r.ok, text: r.ok ? 'Connection works.' : (r.error ?? 'Test failed') }); })}
          disabled={busy}
          className="text-fg-secondary underline hover:text-fg disabled:opacity-40"
        >
          Test
        </button>
        <button onClick={() => void refreshModels()} disabled={busy} className="text-fg-secondary underline hover:text-fg disabled:opacity-40">
          Refresh models
        </button>
        {p.source === 'vault' && (
          <button
            onClick={() => window.confirm(`Remove the stored ${p.label} key?`) && void run(async () => { await deleteProviderKey(p.id); onChanged(); })}
            disabled={busy}
            className="text-danger underline disabled:opacity-40"
          >
            Remove key
          </button>
        )}
      </div>
      {note && <p className={`mt-2 text-xs ${note.ok ? 'text-success' : 'text-danger'}`}>{note.text}</p>}
      {open && <ModelsEditor p={p} onChanged={onChanged} />}
    </div>
  );
}

// ─── add provider ───────────────────────────────────────────────────────────

interface Form { slug: string; label: string; baseUrl: string; apiKey: string; keyOptional: boolean; local: boolean }
const EMPTY: Form = { slug: '', label: '', baseUrl: '', apiKey: '', keyOptional: false, local: false };

function AddProvider({ vaultEnabled, onAdded }: { vaultEnabled: boolean; onAdded: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await addProvider({
        slug: form.slug.trim(),
        label: form.label.trim() || undefined,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        keyOptional: form.keyOptional,
        local: form.local || undefined,
      });
      setOpen(false);
      setForm(EMPTY);
      onAdded(r.refresh ? (r.refresh.ok ? `Added — ${r.refresh.count} models found.` : `Added, but the model list could not be loaded: ${r.refresh.error}`) : 'Added — set its key to load the models.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => setOpen(true)}>+ Add provider</Button>
      </div>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="space-y-2 rounded-button border border-border p-3">
      <p className="text-xs text-fg-tertiary">
        Every provider is the same thing: an OpenAI-compatible base URL and a key. Retry and concurrency are tuned per provider after it is added.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={inputCls} placeholder="slug (e.g. my-hub)" value={form.slug} onChange={e => set('slug', e.target.value.toLowerCase())} aria-label="Slug" />
        <input className={inputCls} placeholder="Label" value={form.label} onChange={e => set('label', e.target.value)} aria-label="Label" />
      </div>
      <input className={inputCls} placeholder="Base URL, e.g. https://host.example/v1" value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} aria-label="Base URL" />
      <input
        className={inputCls}
        type="password"
        autoComplete="off"
        placeholder="API key (stored encrypted)"
        value={form.apiKey}
        disabled={!vaultEnabled}
        onChange={e => set('apiKey', e.target.value)}
        aria-label="API key"
      />
      <label className="flex items-center gap-2 text-xs text-fg-secondary">
        <input type="checkbox" checked={form.keyOptional} onChange={e => set('keyOptional', e.target.checked)} /> No key needed (local server)
      </label>
      <label className="flex items-center gap-2 text-xs text-fg-secondary" title="Only for a server on your own hardware. A hub with mixed models (MindGate) reports it per model instead.">
        <input type="checkbox" checked={form.local} onChange={e => set('local', e.target.checked)} /> Runs on my own hardware (ghost chats may use its models)
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button onClick={() => void submit()} disabled={busy || !form.slug || !form.baseUrl}>{busy ? 'Adding…' : 'Add & load models'}</Button>
      </div>
    </div>
  );
}

// ─── section ────────────────────────────────────────────────────────────────

export function ProvidersSection({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reload = useCallback(() => { getProviders().then(setData).catch(() => {}); }, []);
  useEffect(reload, [reload]);
  const changed = useCallback(() => { reload(); onChanged(); }, [reload, onChanged]);

  if (!data) return <p className="text-xs text-fg-tertiary">Loading providers…</p>;
  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-fg-secondary">Providers</label>
      {!data.vaultEnabled && (
        <p className="rounded-button border border-danger/40 px-3 py-2 text-xs text-danger">
          Saving keys is disabled: {data.vaultDisabledReason}
        </p>
      )}
      {data.providers.length === 0 && (
        <p className="text-xs text-fg-tertiary">Nothing set up yet. Add a provider: an OpenAI-compatible base URL and a key.</p>
      )}
      {data.providers.map(p => (
        <ProviderCard key={`${p.id}:${p.enabled}:${p.last4}:${p.modelCount}`} p={p} vaultEnabled={data.vaultEnabled} onChanged={changed} />
      ))}
      <AddProvider vaultEnabled={data.vaultEnabled} onAdded={m => { setMessage(m); changed(); }} />
      {message && <p className="text-xs text-fg-secondary">{message}</p>}
      <p className="text-xs text-fg-tertiary">Keys are encrypted at rest and never sent back to the browser.</p>
    </div>
  );
}

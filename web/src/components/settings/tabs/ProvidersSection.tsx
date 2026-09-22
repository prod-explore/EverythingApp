import { useCallback, useEffect, useState } from 'react';
import { deleteProviderKey, getProviders, saveProviderKey, setProviderLimit, testProviderKey } from '../../../api';
import type { ProviderInfo, ProvidersResponse } from '../../../types';

const inputCls =
  'w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary';

function ProviderRow({ p, vaultEnabled, onChanged }: { p: ProviderInfo; vaultEnabled: boolean; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [limit, setLimit] = useState(p.warnUsdMonthly?.toString() ?? '');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const r = await saveProviderKey(p.id, key.trim());
      setKey('');
      setNote(
        r.verified === false
          ? { ok: false, text: `Saved, but the provider rejected it: ${r.verifyError ?? 'unknown error'}` }
          : { ok: true, text: r.verified ? 'Saved and verified.' : 'Saved.' },
      );
      onChanged();
    });

  const status = p.configured
    ? p.source === 'env'
      ? 'Using ANTHROPIC_API_KEY from the server environment'
      : `Stored encrypted · ends in ${p.last4 ?? '????'}`
    : p.needsReentry
      ? 'Stored key can’t be decrypted with the current KEY_VAULT_SECRET — enter it again'
      : 'No key';

  return (
    <div className="rounded-button border border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{p.label}</span>
        <span className={`text-xs ${p.configured ? 'text-success' : 'text-fg-tertiary'}`}>{p.configured ? 'Active' : 'Inactive'}</span>
      </div>
      <p className="mb-3 text-xs text-fg-tertiary">{status}</p>

      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={e => setKey(e.target.value)}
          disabled={!vaultEnabled || busy}
          placeholder={p.source === 'vault' ? 'Paste a new key to replace it' : p.keyHint}
          className={inputCls}
        />
        <button
          onClick={save}
          disabled={!vaultEnabled || busy || key.trim().length < 8}
          className="shrink-0 rounded-button border border-border px-3 py-2 text-sm text-fg hover:border-border-hover disabled:opacity-40"
        >
          Save
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-fg-secondary">
          Warn at $
          <input
            inputMode="decimal"
            value={limit}
            onChange={e => setLimit(e.target.value)}
            onBlur={() =>
              run(async () => {
                const n = limit.trim() === '' ? null : Number(limit);
                if (n !== null && !(n > 0)) throw new Error('Enter a positive number, or leave empty for no warning');
                await setProviderLimit(p.id, n);
                onChanged();
              })
            }
            placeholder="off"
            className="w-20 rounded-button border border-border bg-bg-secondary px-2 py-1 text-xs text-fg outline-none"
          />
          / month
        </label>
        {p.configured && (
          <button
            onClick={() =>
              run(async () => {
                const r = await testProviderKey(p.id);
                setNote({ ok: r.ok, text: r.ok ? 'Key works.' : (r.error ?? 'Test failed') });
              })
            }
            disabled={busy}
            className="text-xs text-fg-secondary underline hover:text-fg disabled:opacity-40"
          >
            Test
          </button>
        )}
        {p.source === 'vault' && (
          <button
            onClick={() => window.confirm(`Remove the stored ${p.label} key?`) && run(async () => { await deleteProviderKey(p.id); onChanged(); })}
            disabled={busy}
            className="text-xs text-danger underline disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </div>
      {note && <p className={`mt-2 text-xs ${note.ok ? 'text-success' : 'text-danger'}`}>{note.text}</p>}
    </div>
  );
}

export function ProvidersSection({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const refresh = useCallback(() => {
    getProviders().then(setData).catch(() => {});
    onChanged();
  }, [onChanged]);
  useEffect(() => {
    getProviders().then(setData).catch(() => {});
  }, []);

  if (!data) return <p className="text-xs text-fg-tertiary">Loading providers…</p>;
  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-fg-secondary">API keys</label>
      {!data.vaultEnabled && (
        <p className="rounded-button border border-danger/40 px-3 py-2 text-xs text-danger">
          Saving keys is disabled: {data.vaultDisabledReason}
        </p>
      )}
      {data.providers.map(p => (
        <ProviderRow key={`${p.id}:${p.warnUsdMonthly}:${p.last4}`} p={p} vaultEnabled={data.vaultEnabled} onChanged={refresh} />
      ))}
      <p className="text-xs text-fg-tertiary">Keys are encrypted at rest and never sent back to the browser. Web search is Anthropic-only; batch mode too.</p>
    </div>
  );
}

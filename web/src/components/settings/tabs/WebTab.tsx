import { useCallback, useEffect, useState } from 'react';
import { Globe, Trash2 } from 'lucide-react';
import { listApprovalGrants, revokeApprovalGrant, webSearchApi } from '../../../api';
import type { ApprovalGrantRow, WebSearchSettings, WebSearchTestResult } from '../../../types';
import { Badge } from '../../shared/Badge';
import { Button } from '../../shared/Button';

const field = 'w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover';

/**
 * Web tab: which engine answers `web_search`, and the sites the assistant may open (granted from the approval card).
 * Search needs no approval; reading a page or opening it in the browser asks once per domain.
 */
export function WebTab() {
  return (
    <div className="space-y-6">
      <SearchSection />
      <DomainsSection />
    </div>
  );
}

function SearchSection() {
  const [saved, setSaved] = useState<WebSearchSettings | null>(null);
  const [backend, setBackend] = useState<WebSearchSettings['backend']>('none');
  const [searxngUrl, setSearxngUrl] = useState('');
  const [braveKey, setBraveKey] = useState('');
  const [test, setTest] = useState<WebSearchTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  const apply = (s: WebSearchSettings) => { setSaved(s); setBackend(s.backend); setSearxngUrl(s.searxngUrl); setBraveKey(''); };
  useEffect(() => { webSearchApi.get().then(apply).catch(e => setError((e as Error).message)); }, []);

  const touch = () => { setTest(null); setNotice(null); };

  async function save(removeKey = false) {
    setBusy('save'); setError(null); setNotice(null);
    try {
      apply(await webSearchApi.save({
        backend,
        searxngUrl,
        ...(removeKey ? { braveKey: null } : braveKey.trim() ? { braveKey: braveKey.trim() } : {}),
      }));
      setNotice(removeKey ? 'Key removed.' : 'Saved.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function runTest() {
    setBusy('test'); setError(null); setTest(null);
    try { setTest(await webSearchApi.test({ backend, searxngUrl, braveKey: braveKey.trim() || undefined })); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  if (!saved) return <p className="text-sm text-fg-tertiary">{error ?? 'Loading…'}</p>;
  const needsUrl = backend === 'searxng';
  const needsKey = backend === 'brave';
  const dirty = backend !== saved.backend || searxngUrl !== saved.searxngUrl || braveKey.trim() !== '';

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-medium text-fg">Web search</h3>
        {saved.active ? <Badge tone="success">on</Badge> : <Badge>off</Badge>}
      </div>
      <p className="mb-3 text-xs text-fg-tertiary">
        The assistant gets a <code className="font-mono">web_search</code> function that uses the engine below. It needs no approval — only the query leaves your server.
      </p>
      <div className="space-y-2">
        <select
          className={field}
          value={backend}
          onChange={e => { setBackend(e.target.value as WebSearchSettings['backend']); touch(); }}
          aria-label="Search engine"
        >
          <option value="none">Off</option>
          <option value="searxng">SearXNG (self-hosted)</option>
          <option value="brave">Brave Search API</option>
        </select>

        {needsUrl && (
          <>
            <input className={field} placeholder="http://searxng:8080" value={searxngUrl} onChange={e => { setSearxngUrl(e.target.value); touch(); }} aria-label="SearXNG URL" />
            <p className="text-xs text-fg-tertiary">
              The JSON format must be enabled in SearXNG: <code className="font-mono">search.formats: [html, json]</code> in <code className="font-mono">settings.yml</code>.
            </p>
          </>
        )}

        {needsKey && (
          <>
            <input
              className={field}
              type="password"
              autoComplete="off"
              value={braveKey}
              onChange={e => { setBraveKey(e.target.value); touch(); }}
              placeholder={saved.braveKey.present ? `Saved key ••••${saved.braveKey.last4 ?? ''} — type to replace` : saved.braveKey.fromEnv ? 'Using BRAVE_API_KEY from the environment' : 'Brave Search API key'}
              aria-label="Brave Search API key"
              disabled={!saved.vaultEnabled}
            />
            {!saved.vaultEnabled && <p className="text-xs text-danger">{saved.vaultDisabledReason}</p>}
            {saved.braveKey.present && (
              <button onClick={() => void save(true)} className="text-xs text-fg-tertiary underline hover:text-danger">Remove the saved key</button>
            )}
          </>
        )}

        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy !== null || backend === 'none'} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
          <Button disabled={busy !== null || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
      {test && (
        test.ok
          ? <p role="status" className="mt-2 text-xs text-success">Works — {test.results} result{test.results === 1 ? '' : 's'} for a test query.</p>
          : <p role="alert" className="mt-2 break-words text-xs text-danger">{test.error}</p>
      )}
      {notice && <p role="status" className="mt-2 text-xs text-fg-secondary">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

function scopeLabel(g: ApprovalGrantRow): string {
  if (g.scope === 'always') return 'always';
  if (g.scope === 'project') return 'a project';
  return 'one chat';
}

function DomainsSection() {
  const [grants, setGrants] = useState<ApprovalGrantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setGrants((await listApprovalGrants()).grants.filter(g => g.toolLabel.startsWith('web:'))); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    setError(null);
    try { await revokeApprovalGrant(id); } catch (e) { setError((e as Error).message); }
    await load();
  }

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium text-fg">Allowed sites</h3>
      <p className="mb-2 text-xs text-fg-tertiary">
        Pages from your message or from search results are read freely. For any other address, and for the browser, you are asked once per site: <strong>Allow once</strong>, <strong>for this chat</strong> or <strong>always</strong>. Sites you chose to remember are listed here. Private and local addresses are never reachable.
      </p>
      {grants === null ? (
        <p className="text-sm text-fg-tertiary">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="text-sm text-fg-tertiary">No remembered sites yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-button border border-border">
          {grants.map(g => (
            <li key={g.id} className="flex items-center gap-2 px-3 py-2">
              <Globe size={14} className="shrink-0 text-fg-tertiary" />
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{g.toolLabel.slice(4)}</span>
              <Badge>{scopeLabel(g)}</Badge>
              <button onClick={() => void revoke(g.id)} className="text-fg-tertiary hover:text-danger" aria-label={`Revoke ${g.toolLabel.slice(4)}`}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

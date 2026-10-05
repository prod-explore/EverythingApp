import { useCallback, useEffect, useRef, useState } from 'react';
import { githubConnect } from '../../../api-workspace';
import type { GithubStatus } from '../../../types-workspace';
import { Button } from '../../shared/Button';

/**
 * Connect GitHub like an IDE (Plan v3 §7): GitHub App device flow (enter a code on github.com) or a
 * fine-grained token. The credential stays on the server — sandboxes only get short-lived proxy tokens.
 */
export function GitHubTab() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [pat, setPat] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await githubConnect.status()); } catch (e) { setMessage({ tone: 'error', text: (e as Error).message }); }
  }, []);
  useEffect(() => { void load(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [load]);

  async function startDevice() {
    setMessage(null);
    try {
      const d = await githubConnect.startDevice();
      setDevice({ userCode: d.userCode, verificationUri: d.verificationUri });
      const poll = async (interval: number) => {
        const r = await githubConnect.pollDevice().catch(e => ({ status: 'error' as const, error: (e as Error).message }));
        if (r.status === 'pending') { timer.current = setTimeout(() => void poll(r.interval ?? interval), (r.interval ?? interval) * 1000); return; }
        setDevice(null);
        if (r.status === 'authorized') { setMessage({ tone: 'ok', text: `Connected as ${r.login ?? 'GitHub user'}.` }); void load(); }
        else setMessage({ tone: 'error', text: r.error ?? 'Authorization failed.' });
      };
      timer.current = setTimeout(() => void poll(d.interval), d.interval * 1000);
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    }
  }

  async function savePat() {
    setMessage(null);
    try {
      const r = await githubConnect.setPat(pat);
      setPat('');
      setMessage({ tone: 'ok', text: `Token saved${r.login ? ` (${r.login})` : ''}.` });
      void load();
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    }
  }

  async function disconnect() {
    await githubConnect.disconnect();
    setMessage({ tone: 'ok', text: 'Disconnected.' });
    void load();
  }

  return (
    <div className="space-y-5 text-sm">
      <section className="rounded-button border border-border px-4 py-3">
        <p className="mb-1 text-xs text-fg-tertiary">Status</p>
        {status === null ? (
          <p className="text-fg-tertiary">Loading…</p>
        ) : status.connected ? (
          <div className="flex items-center gap-2">
            <p className="flex-1 text-fg">
              Connected{status.login ? ` as ${status.login}` : ''} via {status.method === 'app' ? 'GitHub App' : status.method === 'pat' ? 'fine-grained token' : 'GITHUB_PAT (server env)'}
            </p>
            {status.method !== 'env' && <Button variant="ghost" onClick={() => void disconnect()}>Disconnect</Button>}
          </div>
        ) : (
          <p className="text-fg-secondary">Not connected.{status.error ? ` ${status.error}` : ''}</p>
        )}
        {status && !status.vaultEnabled && <p className="mt-1 text-xs text-danger">KEY_VAULT_SECRET is not set on the server — credentials can't be stored.</p>}
      </section>

      <section>
        <h3 className="mb-1 font-medium text-fg">Connect with GitHub</h3>
        {status?.appConfigured ? (
          device ? (
            <div className="rounded-button border border-accent px-4 py-3">
              <p className="text-fg-secondary">Open <a href={device.verificationUri} target="_blank" rel="noreferrer noopener" className="underline">{device.verificationUri}</a> and enter:</p>
              <p className="my-2 select-all text-center font-mono text-2xl tracking-widest text-fg">{device.userCode}</p>
              <p className="text-xs text-fg-tertiary">Waiting for authorization…</p>
            </div>
          ) : (
            <Button onClick={() => void startDevice()}>Connect GitHub</Button>
          )
        ) : (
          <p className="text-xs text-fg-tertiary">Set GITHUB_APP_CLIENT_ID on the server (a GitHub App with Device Flow enabled) to connect this way.</p>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-medium text-fg">Or use a fine-grained token</h3>
        <p className="mb-2 text-xs text-fg-tertiary">Create one limited to the repositories you need (Contents, Pull requests, Issues, Actions, Checks). Classic tokens are refused.</p>
        <div className="flex gap-2">
          <input type="password" value={pat} onChange={e => setPat(e.target.value)} placeholder="github_pat_…" aria-label="Fine-grained token" className="min-w-0 flex-1 rounded-button border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-border-hover" />
          <Button onClick={() => void savePat()} disabled={!pat.trim()}>Save</Button>
        </div>
      </section>

      {message && <p className={`text-xs ${message.tone === 'error' ? 'text-danger' : 'text-success'}`}>{message.text}</p>}
    </div>
  );
}

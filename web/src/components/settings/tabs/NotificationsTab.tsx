import { useEffect, useState } from 'react';

type State = 'loading' | 'unsupported' | 'unavailable' | 'off' | 'on' | 'denied';

const b64ToBytes = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

async function post(path: string, body?: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** Browser notifications for urgent Gazeta items (Web Push). Needs the installed service worker, i.e. a production build. */
export function NotificationsTab() {
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
      if (Notification.permission === 'denied') return setState('denied');
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        setState((await reg?.pushManager.getSubscription()) ? 'on' : 'off');
      } catch { setState('unavailable'); }
    })();
  }, []);

  async function enable() {
    setBusy(true); setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      if ((await Notification.requestPermission()) !== 'granted') { setState('denied'); return; }
      const res = await fetch('/api/push/key');
      const key = (await res.json()) as { publicKey?: string; error?: string };
      if (!key.publicKey) throw new Error(key.error ?? 'Push is not available on this server.');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key.publicKey) });
      await post('/api/push/subscribe', { subscription: sub.toJSON() });
      setState('on');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setState('off');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const btn = 'rounded-button border border-border px-3 py-1.5 text-sm text-fg hover:border-border-hover disabled:opacity-40';
  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-1 text-sm font-medium text-fg">Urgent alerts</h3>
        <p className="mb-3 text-xs text-fg-tertiary">
          When an agent marks a question or report urgent, this browser gets a system notification — even with the tab closed.
        </p>
        {state === 'loading' && <p className="text-sm text-fg-tertiary">Checking…</p>}
        {state === 'unsupported' && <p className="text-sm text-fg-secondary">This browser doesn’t support push notifications.</p>}
        {state === 'unavailable' && <p className="text-sm text-fg-secondary">Push needs the installed app shell (production build served over HTTPS or localhost).</p>}
        {state === 'denied' && <p className="text-sm text-fg-secondary">Notifications are blocked for this site — allow them in the browser’s site settings.</p>}
        {state === 'off' && <button className={btn} disabled={busy} onClick={() => void enable()}>Enable notifications</button>}
        {state === 'on' && (
          <div className="flex gap-2">
            <button className={btn} disabled={busy} onClick={() => void post('/api/push/test').catch(e => setError((e as Error).message))}>Send test</button>
            <button className={btn} disabled={busy} onClick={() => void disable()}>Disable</button>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </section>
    </div>
  );
}

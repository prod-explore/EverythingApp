import { useEffect, useState } from 'react';
import { notificationsApi } from '../../../api';
import type { NotificationSettings } from '../../../types';
import { Badge } from '../../shared/Badge';
import { Button } from '../../shared/Button';

const field = 'w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover';

const FORMATS: Array<{ id: NotificationSettings['format']; label: string }> = [
  { id: 'auto', label: 'Detect from the address' },
  { id: 'text', label: 'ntfy / plain text' },
  { id: 'discord', label: 'Discord' },
  { id: 'slack', label: 'Slack' },
  { id: 'json', label: 'JSON' },
];

/**
 * Notifications tab: a webhook that is called when something waits for you — an approval, a question, an urgent
 * item — so you find out on your phone. A plain HTTP POST from the server; the assistant is not involved.
 */
export function NotificationsTab() {
  const [saved, setSaved] = useState<NotificationSettings | null>(null);
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<NotificationSettings['format']>('auto');
  const [appUrl, setAppUrl] = useState('');
  const [events, setEvents] = useState({ approval: true, question: true, urgent: true });
  const [details, setDetails] = useState(false);
  const [delay, setDelay] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  const apply = (s: NotificationSettings) => {
    setSaved(s); setUrl(''); setFormat(s.format); setAppUrl(s.appUrl); setEvents(s.events); setDetails(s.details); setDelay(s.delaySeconds);
  };
  useEffect(() => { notificationsApi.get().then(apply).catch(e => setError((e as Error).message)); }, []);

  const touch = () => setNotice(null);

  async function save(removeUrl = false) {
    setBusy('save'); setError(null); setNotice(null);
    try {
      apply(await notificationsApi.save({
        format, appUrl, events, details, delaySeconds: delay,
        ...(removeUrl ? { webhookUrl: null } : url.trim() ? { webhookUrl: url.trim() } : {}),
      }));
      setNotice(removeUrl ? 'Webhook removed.' : 'Saved.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function test() {
    setBusy('test'); setError(null); setNotice(null);
    try {
      await notificationsApi.test({ ...(url.trim() ? { webhookUrl: url.trim() } : {}), format });
      setNotice('Sent. Check your phone or channel.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  if (!saved) return <p className="text-sm text-fg-tertiary">{error ?? 'Loading…'}</p>;
  const hasUrl = saved.webhook.present || url.trim() !== '';
  const dirty =
    url.trim() !== '' || format !== saved.format || appUrl !== saved.appUrl || details !== saved.details || delay !== saved.delaySeconds ||
    (['approval', 'question', 'urgent'] as const).some(k => events[k] !== saved.events[k]);

  return (
    <section className="space-y-3">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-sm font-medium text-fg">Push to your phone</h3>
          {saved.webhook.present ? <Badge tone="success">on</Badge> : <Badge>off</Badge>}
        </div>
        <p className="text-xs text-fg-tertiary">
          When something is waiting for you, the server calls a webhook. Works with <strong>ntfy</strong> (the app pushes to your phone), Discord, Slack, Home Assistant or anything that accepts a POST.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-fg-secondary" htmlFor="notify-url">Webhook address</label>
        <input
          id="notify-url"
          className={field}
          type="password"
          autoComplete="off"
          value={url}
          onChange={e => { setUrl(e.target.value); touch(); }}
          placeholder={
            saved.webhook.present
              ? `Saved — ${saved.webhook.host ?? 'set'}${saved.webhook.fromEnv ? ' (from NOTIFY_WEBHOOK_URL)' : ''}. Type to replace`
              : 'https://ntfy.sh/your-private-topic'
          }
          disabled={!saved.vaultEnabled}
        />
        {!saved.vaultEnabled
          ? <p className="text-xs text-danger">{saved.vaultDisabledReason}</p>
          : <p className="text-xs text-fg-tertiary">The address usually contains a secret (a topic or token), so it is stored encrypted and never shown again.</p>}
        {saved.webhook.present && !saved.webhook.fromEnv && (
          <button onClick={() => void save(true)} className="text-xs text-fg-tertiary underline hover:text-danger">Remove the saved address</button>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-fg-secondary" htmlFor="notify-format">Format</label>
        <select id="notify-format" className={field} value={format} onChange={e => { setFormat(e.target.value as NotificationSettings['format']); touch(); }}>
          {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs text-fg-secondary">Notify me when</legend>
        {([
          ['approval', 'An action is waiting for my approval'],
          ['question', 'The assistant asks me a question'],
          ['urgent', 'Something is marked urgent'],
        ] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={events[k]} onChange={e => { setEvents({ ...events, [k]: e.target.checked }); touch(); }} />
            {label}
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-2">
        <label className="text-sm text-fg" htmlFor="notify-delay">Wait</label>
        <input
          id="notify-delay"
          className="w-20 rounded-button border border-border bg-bg px-2 py-1 text-sm text-fg outline-none focus:border-border-hover"
          type="number" min={0} max={3600} value={delay}
          onChange={e => { setDelay(Math.max(0, Math.min(3600, Number(e.target.value) || 0))); touch(); }}
        />
        <span className="text-sm text-fg">seconds before telling me about approvals and questions</span>
      </div>
      <p className="-mt-2 text-xs text-fg-tertiary">If you answer in the meantime, nothing is sent. Urgent items go out at once.</p>

      <label className="flex items-start gap-2 text-sm text-fg">
        <input className="mt-1" type="checkbox" checked={details} onChange={e => { setDetails(e.target.checked); touch(); }} />
        <span>
          Include the chat title and what is waiting
          <span className="block text-xs text-fg-tertiary">Off by default: the message only says that something is waiting. Private chats never include details.</span>
        </span>
      </label>

      <div className="space-y-1">
        <label className="text-xs text-fg-secondary" htmlFor="notify-app">Link to the app (optional)</label>
        <input id="notify-app" className={field} value={appUrl} onChange={e => { setAppUrl(e.target.value); touch(); }} placeholder="https://everythingapp.your-tailnet.ts.net" />
        <p className="text-xs text-fg-tertiary">Tapping the notification opens this address.</p>
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" disabled={busy !== null || !hasUrl} onClick={() => void test()}>{busy === 'test' ? 'Sending…' : 'Send a test'}</Button>
        <Button disabled={busy !== null || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
      </div>

      {saved.lastError && <p role="alert" className="break-words text-xs text-danger">{saved.lastError}</p>}
      {notice && <p role="status" className="text-xs text-fg-secondary">{notice}</p>}
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    </section>
  );
}

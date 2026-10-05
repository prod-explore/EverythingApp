import { useId, useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, FileText, Link as LinkIcon, Pin } from 'lucide-react';
import { artifactFileUrl } from '../../api';
import { useGazeta } from '../../hooks/useGazeta';
import type { GazetaField, GazetaInputSchema, GazetaItem } from '../../types';
import { MarkdownBody } from '../chat/MarkdownText';
import { Badge } from '../shared/Badge';
import { Button } from '../shared/Button';

export const TYPE_LABEL: Record<string, string> = {
  approval: 'Approval',
  batch_result: 'Batch result',
  agent_question: 'Question',
  report: 'Report',
  daily_summary: 'Daily summary',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Open',
  responded: 'Answered',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

const INPUT_CLASS =
  'w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover';

/** The asking agent: "assistant" is the chat agent itself, anything else is a worker label. */
export function AgentBadge({ agent }: { agent: string | null }) {
  if (!agent) return null;
  const worker = agent !== 'assistant';
  return (
    <span
      className={`inline-flex max-w-[12rem] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs ${
        worker ? 'border-fg/30 text-fg' : 'border-border text-fg-secondary'
      }`}
      title={worker ? `Worker agent "${agent}"` : 'The chat assistant'}
    >
      <Bot size={11} className="shrink-0" />
      <span className="truncate">{agent}</span>
    </span>
  );
}

function FieldsForm({
  fields,
  disabled,
  onSubmit,
}: {
  fields: GazetaField[];
  disabled: boolean;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const baseId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const allFilled = fields.every(f => (values[f.name] ?? '').trim().length > 0);

  function set(name: string, value: string) {
    setValues(prev => ({ ...prev, [name]: value }));
  }

  function submit() {
    if (allFilled && !disabled) onSubmit(values);
  }

  return (
    <form
      className="space-y-2"
      onSubmit={e => {
        e.preventDefault();
        submit();
      }}
    >
      {fields.map(field => {
        const id = `${baseId}-${field.name}`;
        return (
          <div key={field.name}>
            <label htmlFor={id} className="mb-1 block text-xs text-fg-tertiary">
              {field.label}
            </label>
            {field.type === 'select' ? (
              <select id={id} value={values[field.name] ?? ''} onChange={e => set(field.name, e.target.value)} className={INPUT_CLASS}>
                <option value="" disabled>
                  Select…
                </option>
                {(field.options ?? []).map(opt => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={field.type === 'number' ? 'number' : 'text'}
                value={values[field.name] ?? ''}
                onChange={e => set(field.name, e.target.value)}
                placeholder={field.label}
                className={INPUT_CLASS}
              />
            )}
          </div>
        );
      })}
      <Button type="submit" disabled={!allFilled || disabled}>
        Submit
      </Button>
    </form>
  );
}

/** Human-readable version of whatever shape the form sent back. */
export function summarizeResponse(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.choice === 'string') return r.choice;
    if (typeof r.text === 'string') return r.text;
    if (r.acknowledged === true) return 'Marked handled';
    if (r.fields && typeof r.fields === 'object') {
      return Object.entries(r.fields as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');
    }
  }
  return JSON.stringify(response);
}

function DeliveryNote({ id }: { id: string }) {
  const { delivered } = useGazeta();
  const how = delivered[id];
  if (!how) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-success" role="status">
      <CheckCircle2 size={12} />
      {how === 'tool_result' ? 'Answer delivered to the agent.' : 'The agent will receive this as a message.'}
    </p>
  );
}

/**
 * The answer area of a Gazeta item — the form while it's open, its outcome
 * afterwards. Shared by the inbox card and the in-chat question card so
 * both behave identically, and both read the same store, so answering in
 * one view flips the other immediately.
 */
export function GazetaAnswer({ item }: { item: GazetaItem }) {
  const { respond } = useGazeta();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = item.inputSchema as GazetaInputSchema;

  async function submit(response: unknown) {
    setBusy(true);
    setError(null);
    try {
      await respond(item.id, response);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (item.status !== 'pending') {
    const answer = item.status === 'responded' ? summarizeResponse(item.response) : '';
    return (
      <div className="text-xs text-fg-secondary">
        {item.status === 'responded' && (
          <p>
            <span className="text-fg-tertiary">Answered{item.respondedAt ? ` ${new Date(item.respondedAt).toLocaleString()}` : ''}: </span>
            <span className="whitespace-pre-wrap text-fg">{answer || '—'}</span>
          </p>
        )}
        {item.status === 'dismissed' && <p className="text-fg-tertiary">Dismissed.</p>}
        {item.status === 'expired' && <p className="text-fg-tertiary">Expired — the agent stopped waiting for an answer.</p>}
        {item.type === 'agent_question' && <DeliveryNote id={item.id} />}
      </div>
    );
  }

  return (
    <div>
      {schema?.type === 'fields' && <FieldsForm fields={schema.fields} disabled={busy} onSubmit={values => void submit({ fields: values })} />}

      {schema?.type === 'choice' && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choose an answer">
          {schema.choices.map(choice => (
            <Button key={choice} variant="ghost" disabled={busy} onClick={() => void submit({ choice })}>
              {choice}
            </Button>
          ))}
        </div>
      )}

      {schema?.type === 'text' && (
        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (text.trim() && !busy) void submit({ text });
          }}
        >
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Your answer…"
            aria-label={`Answer: ${item.title}`}
            className={`flex-1 ${INPUT_CLASS}`}
          />
          <Button type="submit" disabled={!text.trim() || busy}>
            Reply
          </Button>
        </form>
      )}

      {!schema && (
        <Button variant="ghost" disabled={busy} onClick={() => void submit({ acknowledged: true })}>
          Mark handled
        </Button>
      )}

      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Report pins: the snapshot (artifact) as it was when reported, plus a jump to the live file. */
export function GazetaAttachments({ item }: { item: GazetaItem }) {
  const attachments = item.attachments ?? [];
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Pinned files">
      {attachments.map((a, i) => (
        <li
          key={`${a.path}-${i}`}
          className={`flex max-w-full items-center gap-2 rounded-button border px-2 py-1 text-xs ${a.error ? 'border-danger/40' : 'border-border'} bg-bg`}
        >
          <Pin size={11} className="shrink-0 text-fg-tertiary" />
          <span className="min-w-0 truncate font-mono text-fg" title={a.path}>
            {a.path.replace(/^\/workspace\//, '')}
          </span>
          {a.error ? (
            <span className="truncate text-danger" title={a.error}>
              not pinned
            </span>
          ) : (
            <>
              {a.artifactId && (
                <a
                  href={artifactFileUrl(a.artifactId)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 text-fg-secondary underline decoration-fg-tertiary hover:text-fg"
                  title={a.sha256 ? `Snapshot at report time — sha256 ${a.sha256}` : 'Snapshot at report time'}
                >
                  <FileText size={11} /> snapshot
                </a>
              )}
              {a.sha256 && (
                <code className="shrink-0 text-fg-tertiary" title={`sha256 ${a.sha256}`}>
                  {a.sha256.slice(0, 8)}
                </code>
              )}
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('ea:open-file', { detail: { path: a.path, projectId: item.projectId } }))}
                className="flex shrink-0 items-center gap-1 text-fg-secondary hover:text-fg"
                title={`Open the current version of ${a.path}`}
              >
                <ExternalLink size={11} /> current
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function GazetaCard({
  item,
  projectName,
  selected,
  onToggleSelect,
  onOpenConversation,
}: {
  item: GazetaItem;
  projectName?: string;
  /** Bulk selection — only offered for open items. */
  selected?: boolean;
  onToggleSelect?: () => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { dismiss } = useGazeta();
  const [error, setError] = useState<string | null>(null);
  const open = item.status === 'pending';
  const urgent = item.urgent && open;

  async function handleDismiss() {
    setError(null);
    try {
      await dismiss(item.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <article
      className={`rounded-container border p-4 ${urgent ? 'border-accent' : 'border-border'} ${open ? '' : 'opacity-70'}`}
      aria-label={`${TYPE_LABEL[item.type] ?? item.type}: ${item.title}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {onToggleSelect && open && (
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            aria-label={`Select "${item.title}"`}
            className="h-4 w-4 accent-[var(--color-fg)]"
          />
        )}
        {urgent && <Badge tone="danger">Urgent</Badge>}
        <Badge>{TYPE_LABEL[item.type] ?? item.type}</Badge>
        <AgentBadge agent={item.agent} />
        {!open && <Badge tone={item.status === 'responded' ? 'success' : 'neutral'}>{STATUS_LABEL[item.status] ?? item.status}</Badge>}
        {projectName && <span className="truncate text-xs text-fg-tertiary">{projectName}</span>}
        <span className="ml-auto text-xs text-fg-tertiary">{new Date(item.createdAt).toLocaleString()}</span>
      </div>

      <h3 className="mb-1 text-sm font-medium text-fg">{item.title}</h3>
      {item.description && (
        <div className="prose prose-invert prose-sm mb-3 max-w-none text-fg-secondary [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-bg [&_pre]:p-3">
          <MarkdownBody text={item.description} />
        </div>
      )}

      {item.attachments && item.attachments.length > 0 && (
        <div className="mb-3">
          <GazetaAttachments item={item} />
        </div>
      )}

      <div className="mb-3">
        <GazetaAnswer item={item} />
      </div>

      <div className="flex items-center gap-2">
        {open && (
          <Button variant="ghost" onClick={() => void handleDismiss()}>
            Dismiss
          </Button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
        {item.conversationId && onOpenConversation && (
          <button
            type="button"
            onClick={() => onOpenConversation(item.conversationId!)}
            className="ml-auto flex items-center gap-1 text-xs text-fg-tertiary hover:text-fg"
          >
            <LinkIcon size={12} /> Open originating chat
          </button>
        )}
      </div>
    </article>
  );
}

import { useState } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { GazetaField, GazetaInputSchema, GazetaItem } from '../../types';
import { Badge } from '../shared/Badge';
import { Button } from '../shared/Button';

const TYPE_LABEL: Record<string, string> = {
  approval: 'Approval',
  batch_result: 'Batch result',
  agent_question: 'Question',
  daily_summary: 'Daily summary',
};

function FieldsForm({ fields, onSubmit }: { fields: GazetaField[]; onSubmit: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const allFilled = fields.every(f => (values[f.name] ?? '').trim().length > 0);

  function set(name: string, value: string) {
    setValues(prev => ({ ...prev, [name]: value }));
  }

  function submit() {
    if (allFilled) onSubmit(values);
  }

  return (
    <div className="mb-3 space-y-2">
      {fields.map((field, i) => (
        <div key={field.name}>
          <label className="mb-1 block text-xs text-fg-tertiary">{field.label}</label>
          {field.type === 'select' ? (
            <select
              value={values[field.name] ?? ''}
              onChange={e => set(field.name, e.target.value)}
              className="w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none"
            >
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
              type={field.type === 'number' ? 'number' : 'text'}
              value={values[field.name] ?? ''}
              onChange={e => set(field.name, e.target.value)}
              onKeyDown={e => e.key === 'Enter' && i === fields.length - 1 && submit()}
              placeholder={field.label}
              className="w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary"
            />
          )}
        </div>
      ))}
      <Button onClick={submit} disabled={!allFilled}>
        Submit
      </Button>
    </div>
  );
}

export function GazetaCard({
  item,
  onRespond,
  onDismiss,
  onOpenConversation,
}: {
  item: GazetaItem;
  onRespond: (response: unknown) => void;
  onDismiss: () => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const [text, setText] = useState('');
  const schema = item.inputSchema as GazetaInputSchema;

  return (
    <div className="rounded-container border border-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge>{TYPE_LABEL[item.type] ?? item.type}</Badge>
        <span className="text-xs text-fg-tertiary">{new Date(item.createdAt).toLocaleString()}</span>
      </div>

      <h3 className="mb-1 text-sm font-medium text-fg">{item.title}</h3>
      {item.description && (
        <div className="mb-3 text-sm text-fg-secondary [&_p]:mb-2 [&_p:last-child]:mb-0 [&_code]:rounded [&_code]:bg-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
          <Markdown remarkPlugins={[remarkGfm]}>{item.description}</Markdown>
        </div>
      )}

      {schema?.type === 'fields' && <FieldsForm fields={schema.fields} onSubmit={values => onRespond({ fields: values })} />}

      {schema?.type === 'choice' && (
        <div className="mb-3 flex flex-wrap gap-2">
          {schema.choices.map(choice => (
            <Button key={choice} variant="ghost" onClick={() => onRespond({ choice })}>
              {choice}
            </Button>
          ))}
        </div>
      )}

      {schema?.type === 'text' && (
        <div className="mb-3 flex gap-2">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && text.trim() && onRespond({ text })}
            placeholder="Your answer…"
            className="flex-1 rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary"
          />
          <Button onClick={() => text.trim() && onRespond({ text })} disabled={!text.trim()}>
            Reply
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        {!schema && <Button onClick={() => onRespond({ acknowledged: true })}>Mark handled</Button>}
        {item.conversationId && onOpenConversation && (
          <button
            onClick={() => onOpenConversation(item.conversationId!)}
            className="ml-auto flex items-center gap-1 text-xs text-fg-tertiary hover:text-fg"
          >
            <LinkIcon size={12} /> Open conversation
          </button>
        )}
      </div>
    </div>
  );
}

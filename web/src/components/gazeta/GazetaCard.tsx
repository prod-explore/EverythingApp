import { useState } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import type { GazetaItem } from '../../types';
import { Badge } from '../shared/Badge';
import { Button } from '../shared/Button';

const TYPE_LABEL: Record<string, string> = {
  approval: 'Approval',
  batch_result: 'Batch result',
  agent_question: 'Question',
  daily_summary: 'Daily summary',
};

type InputSchema = { type: 'choice'; choices: string[] } | { type: 'text' } | null;

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
  const schema = item.inputSchema as InputSchema;

  return (
    <div className="rounded-container border border-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge>{TYPE_LABEL[item.type] ?? item.type}</Badge>
        <span className="text-xs text-fg-tertiary">{new Date(item.createdAt).toLocaleString()}</span>
      </div>

      <h3 className="mb-1 text-sm font-medium text-fg">{item.title}</h3>
      {item.description && <p className="mb-3 whitespace-pre-wrap text-sm text-fg-secondary">{item.description}</p>}

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

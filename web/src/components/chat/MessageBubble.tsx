import { ActionBarPrimitive, MessagePrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { ComposerPrimitive } from '@assistant-ui/react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import { Check, Copy, Pencil, Quote, RotateCw, Trash2, X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { MarkdownText } from './MarkdownText';
import { ToolCallCard } from './ToolCallCard';

const PlainText: TextMessagePartComponent = ({ text }) => <span>{text}</span>;

const ASSISTANT_PARTS_COMPONENTS = {
  Text: MarkdownText,
  tools: { Fallback: ToolCallCard },
};

/** Small icon button shared by both bubbles' action bars — kept local since it's only ever used here. */
function ActionButton({ children, ...rest }: ComponentProps<'button'>) {
  return (
    <button
      {...rest}
      className="rounded p-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg-secondary disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** Deletes this message and everything after it — routed through the onDelete adapter wired in lib/runtime.ts. */
function DeleteButton() {
  const aui = useAui();
  return (
    <ActionButton
      aria-label="Delete from here"
      title="Delete this message and everything after it"
      onClick={() => void aui.message.delete()}
    >
      <Trash2 size={13} />
    </ActionButton>
  );
}

/** Sets this message as the composer's pending quote — see Composer.tsx for the preview banner this feeds. */
function QuoteButton() {
  const aui = useAui();
  const id = useAuiState(s => s.message.id);
  const text = useAuiState(s =>
    s.message.content
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map(c => c.text)
      .join(''),
  );
  return (
    <ActionButton
      aria-label="Quote"
      title="Quote in reply"
      disabled={!text.trim()}
      onClick={() => aui.thread.composer().setQuote({ text, messageId: id })}
    >
      <Quote size={13} />
    </ActionButton>
  );
}

/** Replaces the normal bubble while a user message is being edited — the ambient composer scope resolves to this message's own edit composer inside MessagePrimitive.Root. */
function EditComposer() {
  return (
    <ComposerPrimitive.Root className="ml-auto flex w-[75%] flex-col gap-2 rounded-message border border-border-hover bg-bg-secondary p-2.5">
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        className="max-h-32 resize-none bg-transparent text-sm text-fg outline-none"
      />
      <div className="flex justify-end gap-1">
        <ComposerPrimitive.Cancel asChild>
          <ActionButton aria-label="Cancel edit">
            <X size={14} />
          </ActionButton>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <ActionButton aria-label="Save edit">
            <Check size={14} />
          </ActionButton>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

export function UserBubble() {
  const isEditing = useAuiState(s => s.composer.isEditing);
  return (
    <MessagePrimitive.Root className="group ml-auto flex max-w-[75%] flex-col items-end gap-1">
      {isEditing ? (
        <EditComposer />
      ) : (
        <>
          <div className="rounded-message bg-fg px-4 py-2.5 text-sm text-bg">
            <MessagePrimitive.Parts components={{ Text: PlainText }} />
          </div>
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            className="flex gap-0.5 opacity-0 group-hover:opacity-100"
          >
            <ActionBarPrimitive.Edit asChild>
              <ActionButton aria-label="Edit">
                <Pencil size={13} />
              </ActionButton>
            </ActionBarPrimitive.Edit>
            <ActionBarPrimitive.Copy asChild>
              <ActionButton aria-label="Copy">
                <Copy size={13} />
              </ActionButton>
            </ActionBarPrimitive.Copy>
            <DeleteButton />
          </ActionBarPrimitive.Root>
        </>
      )}
    </MessagePrimitive.Root>
  );
}

export function AssistantBubble() {
  return (
    <MessagePrimitive.Root className="group mr-auto flex max-w-[85%] flex-col gap-1">
      <div className="prose prose-invert prose-sm max-w-none rounded-message border border-border bg-bg-secondary px-4 py-2.5 text-fg [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-bg [&_pre]:p-3">
        <MessagePrimitive.Parts components={ASSISTANT_PARTS_COMPONENTS} />
      </div>
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        autohideFloat="single-branch"
        className="flex gap-0.5 opacity-0 group-hover:opacity-100"
      >
        <ActionBarPrimitive.Copy asChild>
          <ActionButton aria-label="Copy">
            <Copy size={13} />
          </ActionButton>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload asChild>
          <ActionButton aria-label="Regenerate">
            <RotateCw size={13} />
          </ActionButton>
        </ActionBarPrimitive.Reload>
        <QuoteButton />
        <DeleteButton />
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

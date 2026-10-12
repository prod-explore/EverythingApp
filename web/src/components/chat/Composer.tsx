import { AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { AlertTriangle, Paperclip, RotateCw, Send, X } from 'lucide-react';
import { StopButton } from './StopButton';
import { SlashMenu } from './SlashMenu';

export function Composer({
  error,
  onRetry,
}: {
  /** Set when the last turn ended in an error or was aborted — see lib/runtime.ts. */
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border-t border-border bg-bg">
      {error && (
        <div className="flex items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2 text-xs text-fg-secondary">
          <AlertTriangle size={13} className="shrink-0 text-fg-tertiary" />
          <span className="flex-1 truncate" title={error}>
            {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-bg-tertiary hover:text-fg"
          >
            <RotateCw size={12} /> Retry
          </button>
        </div>
      )}

      <SlashMenu onCommand={name => window.dispatchEvent(new CustomEvent('app:command', { detail: { name } }))} />

      <ComposerPrimitive.Quote className="mx-3 mt-2 flex items-start gap-2 rounded-button border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-fg-tertiary">
        <span className="line-clamp-2 flex-1">
          <ComposerPrimitive.QuoteText />
        </span>
        <ComposerPrimitive.QuoteDismiss className="shrink-0 rounded p-0.5 hover:bg-bg-tertiary hover:text-fg-secondary">
          <X size={12} />
        </ComposerPrimitive.QuoteDismiss>
      </ComposerPrimitive.Quote>

      <ComposerPrimitive.Attachments>
        {({ attachment }) => (
          <AttachmentPrimitive.Root
            key={attachment.id}
            className="mx-3 mt-2 flex items-center gap-2 rounded-button border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-fg-secondary"
          >
            <Paperclip size={12} className="shrink-0 text-fg-tertiary" />
            <span className="flex-1 truncate">
              <AttachmentPrimitive.Name />
            </span>
            <AttachmentPrimitive.Remove className="shrink-0 rounded p-0.5 hover:bg-bg-tertiary hover:text-fg">
              <X size={12} />
            </AttachmentPrimitive.Remove>
          </AttachmentPrimitive.Root>
        )}
      </ComposerPrimitive.Attachments>

      <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl items-end gap-2 p-3">
        <ComposerPrimitive.AddAttachment aria-label="Attach image" title="Attach image" className="shrink-0 rounded-button border border-border p-2.5 text-fg-tertiary transition-colors hover:text-fg-secondary disabled:opacity-30">
          <Paperclip size={16} />
        </ComposerPrimitive.AddAttachment>

        <ComposerPrimitive.Input
          id="composer-input"
          rows={1}
          placeholder="Message…"
          className="max-h-32 flex-1 resize-none rounded-button border border-border bg-bg-secondary px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover"
        />

        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send aria-label="Send message" className="shrink-0 rounded-button bg-fg p-2.5 text-bg transition-opacity disabled:opacity-30">
            <Send size={16} />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <StopButton />
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </div>
  );
}

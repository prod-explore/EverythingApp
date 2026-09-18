import { useState } from 'react';
import { AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { AlertTriangle, Clock, Paperclip, RotateCw, Send, X } from 'lucide-react';
import { sendMessage } from '../../api';
import { StopButton } from './StopButton';

/**
 * Batch mode bypasses the runtime entirely (assistant-ui's onNew always
 * means "run now") — it reads the textarea directly and posts with
 * batch: true, matching the plan's "toggle affects the next send only"
 * intent rather than being a separate composer.
 */
export function Composer({
  conversationId,
  error,
  onRetry,
}: {
  conversationId: string;
  /** Set when the last turn ended in an error or was aborted — see lib/runtime.ts. */
  error?: string;
  onRetry?: () => void;
}) {
  const [batchMode, setBatchMode] = useState(false);

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

      <ComposerPrimitive.Root
        className="flex items-end gap-2 p-3"
        onSubmit={async e => {
          if (!batchMode) return; // let assistant-ui's normal onNew flow handle it
          e.preventDefault();
          const form = e.currentTarget;
          const textarea = form.querySelector('textarea');
          const text = textarea?.value.trim();
          if (!text) return;
          textarea!.value = '';
          await sendMessage(conversationId, text, true);
        }}
      >
        <button
          type="button"
          onClick={() => setBatchMode(b => !b)}
          title={batchMode ? 'Batch mode — cheaper, no live tool calls, resolves later' : 'Send live'}
          className={`shrink-0 rounded-button border p-2.5 transition-colors ${
            batchMode ? 'border-fg bg-fg text-bg' : 'border-border text-fg-tertiary hover:text-fg-secondary'
          }`}
        >
          <Clock size={16} />
        </button>

        {/* Batch mode skips the runtime entirely (see onSubmit above), so
            attachments — which only flow through onNew — don't apply there;
            hide the button rather than let someone attach an image batch
            mode will silently drop. */}
        {!batchMode && (
          <ComposerPrimitive.AddAttachment className="shrink-0 rounded-button border border-border p-2.5 text-fg-tertiary transition-colors hover:text-fg-secondary disabled:opacity-30">
            <Paperclip size={16} />
          </ComposerPrimitive.AddAttachment>
        )}

        <ComposerPrimitive.Input
          id="composer-input"
          rows={1}
          placeholder={batchMode ? 'Batch message (queued, cheaper, no tools)…' : 'Message…'}
          className="max-h-32 flex-1 resize-none rounded-button border border-border bg-bg-secondary px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover"
        />

        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="shrink-0 rounded-button bg-fg p-2.5 text-bg transition-opacity disabled:opacity-30">
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

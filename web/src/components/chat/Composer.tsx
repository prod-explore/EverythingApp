import { useState } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { Clock, Send } from 'lucide-react';
import { sendMessage } from '../../api';
import { StopButton } from './StopButton';

/**
 * Batch mode bypasses the runtime entirely (assistant-ui's onNew always
 * means "run now") — it reads the textarea directly and posts with
 * batch: true, matching the plan's "toggle affects the next send only"
 * intent rather than being a separate composer.
 */
export function Composer({ conversationId }: { conversationId: string }) {
  const [batchMode, setBatchMode] = useState(false);

  return (
    <ComposerPrimitive.Root
      className="flex items-end gap-2 border-t border-border bg-bg p-3"
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

      <ComposerPrimitive.Input
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
  );
}

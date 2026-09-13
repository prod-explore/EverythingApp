import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Modal } from '../shared/Modal';

export function FileViewer({ title, content, onClose }: { title: string; content: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="relative">
        <button
          onClick={() => {
            navigator.clipboard.writeText(content).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="absolute right-2 top-2 flex items-center gap-1 rounded-lg border border-border bg-bg px-2 py-1 text-xs text-fg-secondary hover:text-fg"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        {/* Plain monospace, not markdown: this is arbitrary tool output (JSON, logs,
            file contents, anything) — rendering it as markdown would misinterpret
            stray '#'/'*'/etc. that have nothing to do with formatting. */}
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-4 pt-10 font-mono text-xs text-fg-secondary">
          {content}
        </pre>
      </div>
    </Modal>
  );
}

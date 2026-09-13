import { useState } from 'react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import { Check, Copy } from 'lucide-react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="absolute right-2 top-2 rounded-lg border border-border bg-bg-secondary p-1 text-fg-tertiary opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
      aria-label="Copy code"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function extractText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

export const MarkdownText: TextMessagePartComponent = ({ text }) => (
  <Markdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeHighlight]}
    components={{
      a: props => <a {...props} target="_blank" rel="noreferrer" className="underline decoration-fg-tertiary" />,
      pre: ({ children, ...props }) => (
        <pre {...props} className="group relative">
          <CopyButton text={extractText(children)} />
          {children}
        </pre>
      ),
      code: ({ className, children, ...props }) => {
        const isBlock = Boolean(className); // rehype-highlight only sets a className on fenced blocks
        return isBlock ? (
          <code className={className} {...props}>
            {children}
          </code>
        ) : (
          <code className="rounded bg-bg px-1 py-0.5 font-mono text-xs" {...props}>
            {children}
          </code>
        );
      },
    }}
  >
    {text}
  </Markdown>
);

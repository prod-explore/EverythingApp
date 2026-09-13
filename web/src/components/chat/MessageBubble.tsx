import { MessagePrimitive } from '@assistant-ui/react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import { MarkdownText } from './MarkdownText';
import { ToolCallCard } from './ToolCallCard';

const PlainText: TextMessagePartComponent = ({ text }) => <span>{text}</span>;

const ASSISTANT_PARTS_COMPONENTS = {
  Text: MarkdownText,
  tools: { Fallback: ToolCallCard },
};

export function UserBubble() {
  return (
    <MessagePrimitive.Root className="ml-auto max-w-[75%]">
      <div className="rounded-message bg-fg px-4 py-2.5 text-sm text-bg">
        <MessagePrimitive.Parts components={{ Text: PlainText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

export function AssistantBubble() {
  return (
    <MessagePrimitive.Root className="mr-auto max-w-[85%]">
      <div className="prose prose-invert prose-sm max-w-none rounded-message border border-border bg-bg-secondary px-4 py-2.5 text-fg [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-bg [&_pre]:p-3">
        <MessagePrimitive.Parts components={ASSISTANT_PARTS_COMPONENTS} />
      </div>
    </MessagePrimitive.Root>
  );
}

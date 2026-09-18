import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { MessageSquare } from 'lucide-react';
import { useEverythingAppRuntime } from '../../lib/runtime';
import { EmptyState } from '../shared/EmptyState';
import { Composer } from './Composer';
import { AssistantBubble, UserBubble } from './MessageBubble';

export function ChatView({ conversationId }: { conversationId: string }) {
  const { runtime, error, retry } = useEverythingAppRuntime(conversationId);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <ThreadPrimitive.Empty>
            <EmptyState icon={MessageSquare} message="Say something to get started." />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserBubble key={message.id} /> : <AssistantBubble key={message.id} />)}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <Composer conversationId={conversationId} error={error} onRetry={retry} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

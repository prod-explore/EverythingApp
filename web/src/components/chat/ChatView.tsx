import { useEffect, useRef } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { useEverythingAppRuntime } from '../../lib/runtime';
import { Composer } from './Composer';
import { ChatQuestions } from '../gazeta/ChatQuestions';
import { InlineApprovals } from '../approval/InlineApprovals';
import { AssistantBubble, UserBubble } from './MessageBubble';
import type { useApprovals } from '../../hooks/useApprovals';
import { AnsweredTrail } from '../gazeta/AnsweredTrail';
import { Onboarding } from './Onboarding';

const STICK_PX = 160; // closer than this to the bottom = the reader is "following" the conversation

/** Smoothly follows new content, but only while the reader hasn't scrolled up to read something. */
function useFollowBottom(conversationId: string) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inner = content.current;
    const scroller = inner?.parentElement;
    if (!inner || !scroller) return;
    let following = true;
    const onScroll = () => {
      following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    };
    const follow = () => {
      if (following) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const mo = new MutationObserver(follow);
    mo.observe(inner, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    scroller.scrollTo({ top: scroller.scrollHeight });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      mo.disconnect();
      ro.disconnect();
    };
  }, [conversationId]);
  return content;
}

export function ChatView({
  conversationId,
  onOpenSettings,
  approvals,
}: {
  conversationId: string;
  onOpenSettings: () => void;
  approvals: ReturnType<typeof useApprovals>;
}) {
  const { runtime, error, retry } = useEverythingAppRuntime(conversationId);
  const content = useFollowBottom(conversationId);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4 py-6">
          <div ref={content} className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5">
            <ThreadPrimitive.Empty>
              <Onboarding onOpenSettings={onOpenSettings} />
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>
              {({ message }) => (message.role === 'user' ? <UserBubble key={message.id} /> : <AssistantBubble key={message.id} />)}
            </ThreadPrimitive.Messages>
            <AnsweredTrail conversationId={conversationId} />
            <InlineApprovals pending={approvals.pending} respond={approvals.respond} />
          </div>
        </ThreadPrimitive.Viewport>
        <ChatQuestions conversationId={conversationId} />
        <Composer conversationId={conversationId} error={error} onRetry={retry} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

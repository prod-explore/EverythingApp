import { useGazeta } from '../../hooks/useGazeta';
import { GazetaCard } from './GazetaCard';

/**
 * The same Gazeta question, second view (Plan v3 §7b): open questions from this chat's agents appear as
 * form cards above the composer. Answering here or in the Gazeta inbox updates both (one shared store).
 */
export function ChatQuestions({ conversationId }: { conversationId: string }) {
  const { pending } = useGazeta();
  const questions = pending.filter(i => i.conversationId === conversationId && i.type === 'agent_question');
  if (questions.length === 0) return null;
  return (
    <div className="max-h-[45vh] space-y-2 overflow-y-auto border-t border-border px-4 py-2" aria-label="Questions from the agent">
      {questions.map(q => <GazetaCard key={q.id} item={q} />)}
    </div>
  );
}

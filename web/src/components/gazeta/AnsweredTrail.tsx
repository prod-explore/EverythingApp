import { useEffect } from 'react';
import { CornerDownRight } from 'lucide-react';
import { getGazetaItems } from '../../api';
import { useGazeta } from '../../hooks/useGazeta';

function formatResponse(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    // { answer } / { choice } style single-value answers read better without the key.
    const entries = Object.entries(obj);
    if (entries.length === 1) return String(entries[0]![1]);
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
  }
  return String(response);
}

/** F16: leaves "Odpowiedziałeś: …" in the transcript for questions this chat's agents asked and the user answered. */
export function AnsweredTrail({ conversationId }: { conversationId: string }) {
  const { byId, upsert } = useGazeta();

  // Answers given in earlier sessions aren't in the live store — load this chat's recent ones once.
  useEffect(() => {
    let cancelled = false;
    getGazetaItems({ status: 'responded', conversationId, type: 'agent_question', limit: 20 })
      .then(r => !cancelled && upsert(r.items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, upsert]);

  const answered = Object.values(byId)
    .filter(i => i.conversationId === conversationId && i.type === 'agent_question' && i.status === 'responded')
    .sort((a, b) => ((a.respondedAt ?? a.createdAt) < (b.respondedAt ?? b.createdAt) ? -1 : 1));
  if (answered.length === 0) return null;

  return (
    <div className="space-y-1.5" aria-label="Twoje odpowiedzi">
      {answered.map(i => (
        <div key={i.id} className="flex items-start gap-2 text-xs text-fg-tertiary">
          <CornerDownRight size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="text-fg-secondary">{i.title}</span>
            <br />
            Odpowiedziałeś: <span className="text-fg-secondary">{formatResponse(i.response) || '—'}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

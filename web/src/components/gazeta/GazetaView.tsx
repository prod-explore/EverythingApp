import { useState } from 'react';
import { Newspaper, RefreshCw } from 'lucide-react';
import { useGazeta } from '../../hooks/useGazeta';
import { EmptyState } from '../shared/EmptyState';
import { Modal } from '../shared/Modal';
import { GazetaCard } from './GazetaCard';

export function GazetaView({
  onClose,
  onOpenConversation,
}: {
  onClose: () => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { items, loading, respond, dismiss, refresh } = useGazeta();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Modal
      title="Gazeta"
      onClose={onClose}
      wide
      headerExtra={
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="rounded-full p-1 text-fg-secondary hover:bg-bg-tertiary hover:text-fg disabled:opacity-40"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>
      }
    >
      {loading ? (
        <p className="text-sm text-fg-tertiary">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={Newspaper} message="Nothing waiting for you." />
      ) : (
        <div className="space-y-3">
          {items.map(item => (
            <GazetaCard
              key={item.id}
              item={item}
              onRespond={response => respond(item.id, response)}
              onDismiss={() => dismiss(item.id)}
              onOpenConversation={
                onOpenConversation
                  ? id => {
                      onOpenConversation(id);
                      onClose();
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

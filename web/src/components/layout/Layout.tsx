import type { PropsWithChildren } from 'react';
import { Sidebar } from './Sidebar';
import type { ConversationSummary } from '../../types';

export function Layout({
  conversations,
  selectedId,
  sidebarOpen,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onOpenGazeta,
  onOpenSettings,
  gazetaCount,
  children,
}: PropsWithChildren<{
  conversations: ConversationSummary[];
  selectedId: string | null;
  sidebarOpen: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenGazeta: () => void;
  onOpenSettings: () => void;
  gazetaCount: number;
}>) {
  return (
    <div className="relative flex h-full">
      <div className={`fixed inset-y-0 left-0 z-30 md:static md:z-auto ${sidebarOpen ? 'block' : 'hidden'} md:block`}>
        <Sidebar
          conversations={conversations}
          selectedId={selectedId}
          onSelect={onSelect}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onOpenGazeta={onOpenGazeta}
          onOpenSettings={onOpenSettings}
          gazetaCount={gazetaCount}
        />
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

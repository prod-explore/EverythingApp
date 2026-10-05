import type { PropsWithChildren } from 'react';
import { Sidebar } from './Sidebar';
import type { ConversationSummary, ProjectListItem } from '../../types';

export function Layout({
  conversations,
  projects,
  selectedId,
  selectedProjectId,
  sidebarOpen,
  sidebarCollapsed,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onOpenGazeta,
  onOpenSettings,
  onCreateProject,
  onSelectProject,
  gazetaCount,
  children,
}: PropsWithChildren<{
  conversations: ConversationSummary[];
  projects: ProjectListItem[];
  selectedId: string | null;
  selectedProjectId: string | null;
  sidebarOpen: boolean;
  /** Desktop only: hides the rail completely (mobile uses sidebarOpen). */
  sidebarCollapsed: boolean;
  onSelect: (id: string) => void;
  onCreate: (projectId?: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenGazeta: () => void;
  onOpenSettings: () => void;
  onCreateProject: () => void;
  onSelectProject: (id: string) => void;
  gazetaCount: number;
}>) {
  return (
    <div className="relative flex h-full">
      <div className={`fixed inset-y-0 left-0 z-30 md:static md:z-auto ${sidebarOpen ? 'block' : 'hidden'} ${sidebarCollapsed ? 'md:hidden' : 'md:block'}`}>
        <Sidebar
          conversations={conversations}
          projects={projects}
          selectedId={selectedId}
          selectedProjectId={selectedProjectId}
          onSelect={onSelect}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onOpenGazeta={onOpenGazeta}
          onOpenSettings={onOpenSettings}
          onCreateProject={onCreateProject}
          onSelectProject={onSelectProject}
          gazetaCount={gazetaCount}
        />
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

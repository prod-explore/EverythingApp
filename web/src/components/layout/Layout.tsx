import type { PropsWithChildren } from 'react';
import { Sidebar, type SidebarView } from './Sidebar';
import { SidebarRail } from './SidebarRail';
import type { ConversationSummary, ProjectListItem } from '../../types';

export function Layout({
  conversations,
  projects,
  selectedId,
  selectedProjectId,
  sidebarOpen,
  sidebarCollapsed,
  sidebarView,
  onSidebarViewChange,
  onExpandSidebar,
  onCloseSidebar,
  onOpenProjects,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onOpenGazeta,
  onOpenSettings,
  onCreateProject,
  onSelectProject,
  onEditProject,
  gazetaCount,
  gazetaUrgent,
  children,
}: PropsWithChildren<{
  conversations: ConversationSummary[];
  projects: ProjectListItem[];
  selectedId: string | null;
  selectedProjectId: string | null;
  sidebarOpen: boolean;
  /** Desktop only: shrinks the sidebar to an icon rail (mobile uses sidebarOpen). */
  sidebarCollapsed: boolean;
  sidebarView: SidebarView;
  onSidebarViewChange: (view: SidebarView) => void;
  onExpandSidebar: () => void;
  onCloseSidebar: () => void;
  onOpenProjects: () => void;
  onSelect: (id: string) => void;
  onCreate: (projectId?: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenGazeta: () => void;
  onOpenSettings: () => void;
  onCreateProject: () => void;
  onSelectProject: (id: string) => void;
  onEditProject: (id: string) => void;
  gazetaCount: number;
  gazetaUrgent?: number;
}>) {
  return (
    <div className="relative flex h-full">
      {sidebarOpen && <div className="fixed inset-0 z-20 bg-black/60 md:hidden" aria-hidden="true" onClick={onCloseSidebar} />}
      <div className={`fixed inset-y-0 left-0 z-30 md:static md:z-auto ${sidebarOpen ? 'block' : 'hidden'} ${sidebarCollapsed ? 'md:hidden' : 'md:block'}`}>
        <Sidebar
          conversations={conversations}
          projects={projects}
          selectedId={selectedId}
          selectedProjectId={selectedProjectId}
          view={sidebarView}
          onViewChange={onSidebarViewChange}
          onSelect={onSelect}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onOpenGazeta={onOpenGazeta}
          onOpenSettings={onOpenSettings}
          onCreateProject={onCreateProject}
          onSelectProject={onSelectProject}
          onEditProject={onEditProject}
          gazetaCount={gazetaCount}
          gazetaUrgent={gazetaUrgent}
        />
      </div>
      {sidebarCollapsed && (
        <div className="hidden md:block">
          <SidebarRail
            gazetaCount={gazetaCount}
            gazetaUrgent={gazetaUrgent}
            onExpand={onExpandSidebar}
            onCreate={() => onCreate()}
            onOpenProjects={onOpenProjects}
            onOpenGazeta={onOpenGazeta}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { createProject, getConversation, getToken, getTurnStatus, listProjects, updateConversation } from './api';
import { ApprovalBanner } from './components/approval/ApprovalBanner';
import { ChatView } from './components/chat/ChatView';
import { ConversationSearch } from './components/ConversationSearch';
import { GazetaView } from './components/gazeta/GazetaView';
import { NewProjectModal } from './components/layout/NewProjectModal';
import { ProjectSettingsModal } from './components/layout/ProjectSettingsModal';
import { RightRail } from './components/layout/RightRail';
import type { SidebarView } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { Layout } from './components/layout/Layout';
import { Login } from './components/Login';
import { SettingsModal } from './components/settings/SettingsModal';
import { BrowserPanel } from './components/browser/BrowserPanel';
import { ArtifactsPanel } from './components/browser/ArtifactsPanel';
import { useConversations } from './hooks/useConversations';
import { GazetaContext, useGazetaStore } from './hooks/useGazeta';
import { AgentsPanel } from './components/agents/AgentsPanel';
import { ExplorerPanel } from './components/workspace/ExplorerPanel';
import { SourceControlPanel } from './components/scm/SourceControlPanel';
import { GitHubPanel } from './components/github/GitHubPanel';
import { useModels } from './hooks/useModels';
import { useSSE } from './hooks/useSSE';
import type { BudgetWarning, Conversation, ProjectListItem, SpendWarning } from './types';

export type DockTool = 'agents' | 'files' | 'scm' | 'github';

export default function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null);

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  return <MainApp />;
}

function MainApp() {
  const {
    conversations,
    selectedId,
    setSelectedId,
    loading,
    createConversation,
    renameConversation,
    deleteConversation,
    refresh: refreshConversations,
  } = useConversations();
  const gazeta = useGazetaStore();
  const [dockTool, setDockTool] = useState<DockTool | null>(null);
  const [agentsRefresh, setAgentsRefresh] = useState(0);
  const [budgetWarning, setBudgetWarning] = useState<BudgetWarning | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [gazetaOpen, setGazetaOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Desktop-only: hides the left rail entirely. Remembered across reloads; storage can be unavailable.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false);
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false);
  const [artifactRefresh, setArtifactRefresh] = useState(0);
  const { models } = useModels();
  const [spendWarning, setSpendWarning] = useState<SpendWarning | null>(null);
  const [usage, setUsage] = useState('—');
  const [fullConv, setFullConv] = useState<Conversation | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>('chats');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects: list } = await listProjects();
      setProjects(list);
    } catch {
      // Sidebar just keeps the last known list; the next refresh retries.
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  // Throws on failure so the modal can stay open and say so.
  async function submitNewProject(name: string) {
    const project = await createProject(name);
    await refreshProjects();
    setSelectedProjectId(project.id);
    setNewProjectOpen(false);
  }

  // Clicking the open project again collapses it.
  function handleSelectProject(id: string) {
    setSelectedProjectId(prev => (prev === id ? null : id));
  }

  async function handleCreate(projectId?: string) {
    await createConversation(undefined, projectId);
    if (projectId) void refreshProjects(); // conversationCount changed
  }

  async function handleDelete(id: string) {
    await deleteConversation(id);
    void refreshProjects();
  }

  const selected = conversations.find(c => c.id === selectedId) ?? null;
  const projectOfChat = selected?.projectId ?? null;
  const workspaceOwner = projectOfChat ?? selectedId;

  // Header's model switch needs the full Conversation (model isn't part of
  // the summary list useConversations() returns) — refetched on every
  // conversation switch, and kept in sync locally when the user changes it
  // so the dropdown doesn't visually snap back while the PATCH is in flight.
  useEffect(() => {
    if (!selectedId) { setFullConv(null); return; }
    let cancelled = false;
    getConversation(selectedId)
      .then(c => !cancelled && setFullConv(c))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  function handleModelChange(model: string) {
    if (!selectedId) return;
    setFullConv(prev => (prev ? { ...prev, model } : prev));
    void updateConversation(selectedId, { model }).catch(() => {
      // Best-effort — worst case the next turn uses the previous model, not worth a visible error for this.
    });
  }

  function handleSandboxToggle(enabled: boolean) {
    if (!selectedId) return;
    setFullConv(prev => (prev ? { ...prev, sandboxEnabled: enabled } : prev));
    void updateConversation(selectedId, { sandboxEnabled: enabled }).catch(() => {});
  }

  // A second SSE connection to whichever conversation is open, purely to
  // hear server.ts's emitAll() broadcasts (gazeta:new, etc.) — ChatView
  // opens its own connection to the same stream for turn events, which
  // this doesn't touch. Two connections to one stream is a bit redundant,
  // but far simpler than lifting SSE state into a shared context for one
  // side-channel.
  useSSE(selectedId, (event, data) => {
    if (event.startsWith('gazeta:')) gazeta.handleEvent(event, data);
    // The first turn auto-titles the chat server-side — pick the new title up.
    if (event === 'turn:done') void refreshConversations();
    if (event === 'agent:spawned' || event === 'agent:finished') setAgentsRefresh(r => r + 1);
    if (event === 'agent:budget_warning') setBudgetWarning(data as BudgetWarning);
    if (event === 'usage:warning') setSpendWarning(data as SpendWarning);
    if (event === 'artifact:new') setArtifactRefresh(r => r + 1);
  });

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      getTurnStatus(selectedId)
        .then(s => !cancelled && setUsage(s.usage))
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId]);

  // Keyboard shortcuts. Ctrl/Cmd+N/K/,/B are global; Escape closes whatever's
  // open (search > settings > gazeta > mobile sidebar, innermost first); "/"
  // focuses the composer but only when nothing else already has focus, so it
  // doesn't hijack typing inside the search box or a textarea mid-edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'n') {
        e.preventDefault();
        createConversation();
        return;
      }
      if (mod && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (mod && e.key === 'b') {
        e.preventDefault();
        if (window.matchMedia('(min-width: 768px)').matches) toggleSidebarCollapsed();
        else setSidebarOpen(o => !o);
        return;
      }
      if (e.key === 'Escape') {
        if (searchOpen) setSearchOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (gazetaOpen) setGazetaOpen(false);
        else if (browserPanelOpen) setBrowserPanelOpen(false);
        else if (artifactsPanelOpen) setArtifactsPanelOpen(false);
        else if (sidebarOpen) setSidebarOpen(false);
        return;
      }
      if (e.key === '/' && !mod) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || searchOpen || settingsOpen || gazetaOpen) return;
        e.preventDefault();
        document.getElementById('composer-input')?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createConversation, searchOpen, settingsOpen, gazetaOpen, sidebarOpen, browserPanelOpen, artifactsPanelOpen]);

  function openProjectsView() {
    setSidebarView('projects');
    toggleSidebarCollapsed(); // only reachable from the collapsed rail, so this expands it
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('sidebarCollapsed', next ? '1' : '0');
      } catch {
        // not persisted; the toggle still works for this session
      }
      return next;
    });
  }

  if (loading || !selectedId) {
    return <div className="flex h-full items-center justify-center text-fg-tertiary">Loading…</div>;
  }

  return (
    <GazetaContext.Provider value={gazeta}>
    <Layout
      conversations={conversations}
      selectedId={selectedId}
      sidebarOpen={sidebarOpen}
      sidebarCollapsed={sidebarCollapsed}
      projects={projects}
      selectedProjectId={selectedProjectId}
      onSelect={id => {
        setSelectedId(id);
        const owner = conversations.find(c => c.id === id)?.projectId;
        if (owner) setSelectedProjectId(owner);
        setSidebarOpen(false);
      }}
      onCreate={handleCreate}
      onRename={renameConversation}
      onDelete={handleDelete}
      onCreateProject={() => setNewProjectOpen(true)}
      sidebarView={sidebarView}
      onSidebarViewChange={setSidebarView}
      onExpandSidebar={toggleSidebarCollapsed}
      onOpenProjects={openProjectsView}
      onSelectProject={handleSelectProject}
      onEditProject={setEditProjectId}
      onOpenGazeta={() => setGazetaOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
      gazetaCount={gazeta.pending.length}
      gazetaUrgent={gazeta.urgentCount}
    >
      <Header
        title={selected?.title ?? ''}
        usage={usage}
        model={fullConv ? fullConv.model || fullConv.effectiveModel || null : null}
        models={models}
        sandboxEnabled={fullConv?.sandboxEnabled}
        onModelChange={handleModelChange}
        onSandboxToggle={handleSandboxToggle}
        onToggleSidebar={() => (window.matchMedia('(min-width: 768px)').matches ? toggleSidebarCollapsed() : setSidebarOpen(o => !o))}
        onOpenBrowser={() => setBrowserPanelOpen(o => !o)}
        onOpenArtifacts={() => setArtifactsPanelOpen(o => !o)}
        browserPanelOpen={browserPanelOpen}
        artifactsPanelOpen={artifactsPanelOpen}
      />
      {spendWarning && (
        <div className="flex items-center justify-between gap-3 border-b border-danger/40 px-4 py-2 text-xs text-danger">
          <span>
            {spendWarning.provider} spend this month is ${spendWarning.monthSpendUsd.toFixed(2)} — past your ${spendWarning.thresholdUsd.toFixed(2)} warning threshold.
          </span>
          <button onClick={() => setSpendWarning(null)} className="shrink-0 underline">Dismiss</button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <ChatView conversationId={selectedId} />
          <ApprovalBanner conversationId={selectedId} />
        </div>

        {/* Right dock: browser on top, artifacts below. Side column on desktop, full-screen sheet on mobile. */}
        {(browserPanelOpen || artifactsPanelOpen || dockTool) && (
          <aside className="fixed inset-0 z-40 flex flex-col bg-bg md:static md:inset-auto md:z-auto md:w-[420px] md:shrink-0 md:border-l md:border-border lg:w-[480px]">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {browserPanelOpen && (
                <BrowserPanel conversationId={selectedId} onClose={() => setBrowserPanelOpen(false)} />
              )}
              {dockTool === 'agents' && selectedId && (
                <AgentsPanel conversationId={selectedId} refreshKey={agentsRefresh} budgetWarning={budgetWarning} onClose={() => setDockTool(null)} />
              )}
              {dockTool === 'files' && selectedId && (
                <ExplorerPanel key={workspaceOwner ?? ''} owner={workspaceOwner ?? selectedId} onClose={() => setDockTool(null)} />
              )}
              {dockTool === 'scm' && (projectOfChat ? (
                <SourceControlPanel key={projectOfChat} projectId={projectOfChat} onClose={() => setDockTool(null)} />
              ) : (
                <NeedsProject title="Source Control" onClose={() => setDockTool(null)} />
              ))}
              {dockTool === 'github' && (projectOfChat ? (
                <GitHubPanel key={projectOfChat} projectId={projectOfChat} onClose={() => setDockTool(null)} />
              ) : (
                <NeedsProject title="GitHub" onClose={() => setDockTool(null)} />
              ))}
              {artifactsPanelOpen && (
                <ArtifactsPanel
                  conversationId={selectedId}
                  onClose={() => setArtifactsPanelOpen(false)}
                  refreshTrigger={artifactRefresh}
                />
              )}
            </div>
          </aside>
        )}
        <RightRail
          browserOpen={browserPanelOpen}
          artifactsOpen={artifactsPanelOpen}
          onToggleBrowser={() => setBrowserPanelOpen(o => !o)}
          onToggleArtifacts={() => setArtifactsPanelOpen(o => !o)}
          tool={dockTool}
          onToggleTool={t => setDockTool(cur => (cur === t ? null : t))}
        />
      </div>

      {editProjectId && (
        <ProjectSettingsModal
          projectId={editProjectId}
          onClose={() => setEditProjectId(null)}
          onChanged={() => void refreshProjects()}
        />
      )}
      {newProjectOpen && <NewProjectModal onSubmit={submitNewProject} onClose={() => setNewProjectOpen(false)} />}
      {gazetaOpen && (
        <GazetaView onClose={() => setGazetaOpen(false)} onOpenConversation={id => setSelectedId(id)} projects={projects} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} conversationId={selectedId ?? undefined} />}
      {searchOpen && (
        <ConversationSearch conversations={conversations} onSelect={setSelectedId} onClose={() => setSearchOpen(false)} />
      )}
    </Layout>
    </GazetaContext.Provider>
  );
}


function NeedsProject({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <section className="flex flex-col border-b border-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-sm font-medium text-fg">{title}</h2>
        <button onClick={onClose} className="text-xs text-fg-tertiary hover:text-fg">Close</button>
      </header>
      <p className="px-3 py-4 text-center text-xs text-fg-tertiary">This chat isn't in a project. Move it into a project (or start a chat inside one) to use {title}.</p>
    </section>
  );
}

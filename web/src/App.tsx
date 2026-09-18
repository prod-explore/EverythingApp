import { useEffect, useState } from 'react';
import { getConversation, getToken, getTurnStatus, updateConversation } from './api';
import { ApprovalBanner } from './components/approval/ApprovalBanner';
import { ChatView } from './components/chat/ChatView';
import { ConversationSearch } from './components/ConversationSearch';
import { GazetaView } from './components/gazeta/GazetaView';
import { Header } from './components/layout/Header';
import { Layout } from './components/layout/Layout';
import { Login } from './components/Login';
import { SettingsModal } from './components/settings/SettingsModal';
import { useConversations } from './hooks/useConversations';
import { useGazeta } from './hooks/useGazeta';
import { useSSE } from './hooks/useSSE';
import type { Conversation } from './types';

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
  } = useConversations();
  const { items: gazetaItems, refresh: refreshGazeta } = useGazeta();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [gazetaOpen, setGazetaOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [usage, setUsage] = useState('—');
  const [fullConv, setFullConv] = useState<Conversation | null>(null);

  const selected = conversations.find(c => c.id === selectedId) ?? null;

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

  // A second SSE connection to whichever conversation is open, purely to
  // hear server.ts's emitAll() broadcasts (gazeta:new, etc.) — ChatView
  // opens its own connection to the same stream for turn events, which
  // this doesn't touch. Two connections to one stream is a bit redundant,
  // but far simpler than lifting SSE state into a shared context for one
  // side-channel.
  useSSE(selectedId, event => {
    if (event === 'gazeta:new') refreshGazeta();
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
        setSidebarOpen(o => !o);
        return;
      }
      if (e.key === 'Escape') {
        if (searchOpen) setSearchOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (gazetaOpen) setGazetaOpen(false);
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
  }, [createConversation, searchOpen, settingsOpen, gazetaOpen, sidebarOpen]);

  if (loading || !selectedId) {
    return <div className="flex h-full items-center justify-center text-fg-tertiary">Loading…</div>;
  }

  return (
    <Layout
      conversations={conversations}
      selectedId={selectedId}
      sidebarOpen={sidebarOpen}
      onSelect={id => {
        setSelectedId(id);
        setSidebarOpen(false);
      }}
      onCreate={() => createConversation()}
      onRename={renameConversation}
      onDelete={deleteConversation}
      onOpenGazeta={() => setGazetaOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
      gazetaCount={gazetaItems.length}
    >
      <Header
        title={selected?.title ?? ''}
        usage={usage}
        model={fullConv?.model ?? null}
        onModelChange={handleModelChange}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
      />
      <div className="relative flex-1 overflow-hidden">
        <ChatView conversationId={selectedId} />
        <ApprovalBanner conversationId={selectedId} />
      </div>

      {gazetaOpen && (
        <GazetaView onClose={() => setGazetaOpen(false)} onOpenConversation={id => setSelectedId(id)} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {searchOpen && (
        <ConversationSearch conversations={conversations} onSelect={setSelectedId} onClose={() => setSearchOpen(false)} />
      )}
    </Layout>
  );
}

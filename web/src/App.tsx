import { useEffect, useState } from 'react';
import { getToken, getTurnStatus } from './api';
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

  const selected = conversations.find(c => c.id === selectedId) ?? null;

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

  // Keyboard shortcuts: Ctrl/Cmd+N for a new conversation, Ctrl/Cmd+K to search them.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        createConversation();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createConversation]);

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
      <Header title={selected?.title ?? ''} usage={usage} onToggleSidebar={() => setSidebarOpen(o => !o)} />
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

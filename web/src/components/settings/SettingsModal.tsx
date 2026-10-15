import { useState } from 'react';
import { logout } from '../../api';
import { Modal } from '../shared/Modal';
import { ConnectorsTab } from './tabs/ConnectorsTab';
import { GitHubTab } from './tabs/GitHubTab';
import { ModelsTab } from './tabs/ModelsTab';
import { NotificationsTab } from './tabs/NotificationsTab';
import { SkillsTab } from './tabs/SkillsTab';
import { UsageTab } from './tabs/UsageTab';
import { WebTab } from './tabs/WebTab';

export type SettingsTab = 'models' | 'usage' | 'connectors' | 'web' | 'notifications' | 'github' | 'skills' | 'account';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'web', label: 'Web' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'github', label: 'GitHub' },
  { id: 'skills', label: 'Skills' },
  { id: 'account', label: 'Account' },
];

export function SettingsModal({
  onClose,
  conversationId,
  initialTab = 'models',
}: {
  onClose: () => void;
  /** When provided, the Skills tab shows attach/detach controls for this conversation. */
  conversationId?: string;
  initialTab?: SettingsTab;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      wide
      tabs={
        <div className="flex flex-wrap gap-0.5 border-b border-border pb-2" role="tablist" aria-label="Settings sections">
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              onClick={() => setActiveTab(t.id)}
              className={`rounded-button px-2.5 py-1.5 text-sm font-medium transition-colors ${
                activeTab === t.id
                  ? 'bg-bg-tertiary text-fg'
                  : 'text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {/* Tab content */}
      <div className="min-h-[220px]">
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'usage' && <UsageTab />}
        {activeTab === 'connectors' && <ConnectorsTab />}
        {activeTab === 'web' && <WebTab />}
        {activeTab === 'notifications' && <NotificationsTab />}
        {activeTab === 'github' && <GitHubTab />}
        {activeTab === 'skills' && <SkillsTab conversationId={conversationId} />}
        {activeTab === 'account' && <AccountTab />}
      </div>
    </Modal>
  );
}

function AccountTab() {
  return (
    <div className="space-y-4">
      <div className="rounded-button border border-border px-4 py-3">
        <p className="text-xs text-fg-tertiary mb-1">Authentication</p>
        <p className="text-sm text-fg">Password login (SERVER_PASSWORD, falls back to SERVER_AUTH_TOKEN). Sessions last 30 days.</p>
      </div>
      <button
        onClick={() => {
          void logout().finally(() => window.location.reload());
        }}
        className="w-full rounded-button border border-danger/40 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 transition-colors"
      >
        Log out
      </button>
      <p className="text-xs text-fg-tertiary">
        Logging out ends this browser's session on the server. The server keeps running.
      </p>
    </div>
  );
}

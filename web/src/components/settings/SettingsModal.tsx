import { useState } from 'react';
import { clearToken } from '../../api';
import { Modal } from '../shared/Modal';
import { AppearanceTab } from './tabs/AppearanceTab';
import { ConnectorsTab } from './tabs/ConnectorsTab';
import { ModelsTab } from './tabs/ModelsTab';
import { SkillsTab } from './tabs/SkillsTab';

type Tab = 'models' | 'connectors' | 'skills' | 'appearance' | 'account';

const TABS: { id: Tab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'skills', label: 'Skills' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'account', label: 'Account' },
];

export function SettingsModal({
  onClose,
  conversationId,
}: {
  onClose: () => void;
  /** When provided, the Skills tab shows attach/detach controls for this conversation. */
  conversationId?: string;
}) {
  const [activeTab, setActiveTab] = useState<Tab>('models');

  return (
    <Modal title="Settings" onClose={onClose} wide>
      {/* Tab bar */}
      <div className="mb-6 flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === t.id
                ? 'border-b-2 border-fg text-fg'
                : 'text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-[220px]">
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'connectors' && <ConnectorsTab />}
        {activeTab === 'skills' && <SkillsTab conversationId={conversationId} />}
        {activeTab === 'appearance' && <AppearanceTab />}
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
        <p className="text-sm text-fg">Single shared token (SERVER_AUTH_TOKEN).</p>
      </div>
      <button
        onClick={() => {
          clearToken();
          window.location.reload();
        }}
        className="w-full rounded-button border border-danger/40 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 transition-colors"
      >
        Log out
      </button>
      <p className="text-xs text-fg-tertiary">
        Logging out clears the token from this browser. The server keeps running.
      </p>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { getConnectors } from '../../api';
import { useSettings } from '../../hooks/useSettings';
import type { ConnectorInfo } from '../../types';
import { Badge } from '../shared/Badge';
import { Modal } from '../shared/Modal';

const MODELS = ['claude-sonnet-4-6', 'claude-opus-5', 'claude-haiku-4-5-20251001'];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, loading, set } = useSettings();
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);

  useEffect(() => {
    getConnectors().then(({ connectors }) => setConnectors(connectors));
  }, []);

  if (loading) {
    return (
      <Modal title="Settings" onClose={onClose}>
        <p className="text-sm text-fg-tertiary">Loading…</p>
      </Modal>
    );
  }

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="space-y-6">
        <div>
          <label className="mb-2 block text-xs font-medium text-fg-secondary">Default model</label>
          <select
            value={settings['default_model'] ?? MODELS[0]}
            onChange={e => set('default_model', e.target.value)}
            className="w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none"
          >
            {MODELS.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-fg-secondary">Global system prompt</label>
          <textarea
            rows={4}
            defaultValue={settings['global_system_prompt'] ?? ''}
            onBlur={e => set('global_system_prompt', e.target.value)}
            placeholder="Applies to any conversation that doesn't override it."
            className="w-full resize-none rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary"
          />
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-fg-secondary">Custom instructions</label>
          <textarea
            rows={3}
            defaultValue={settings['custom_instructions'] ?? ''}
            onBlur={e => set('custom_instructions', e.target.value)}
            placeholder="Short standing preferences (tone, format, things to always/never do)."
            className="w-full resize-none rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary"
          />
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-fg-secondary">Connectors</label>
          <div className="space-y-2">
            {connectors.length === 0 && <p className="text-sm text-fg-tertiary">No MCP connectors configured.</p>}
            {connectors.map(c => (
              <div key={c.name} className="flex items-center justify-between rounded-button border border-border px-3 py-2">
                <span className="font-mono text-sm text-fg">{c.name}</span>
                <Badge tone={c.connected ? 'success' : 'danger'}>
                  {c.connected ? `${c.toolCount} tools` : 'disconnected'}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

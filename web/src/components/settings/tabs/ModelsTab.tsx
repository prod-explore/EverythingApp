import { useSettings } from '../../../hooks/useSettings';
import { MODELS } from '../../../lib/models';

export function ModelsTab() {
  const { settings, set } = useSettings();

  return (
    <div className="space-y-6">
      <div>
        <label className="mb-2 block text-xs font-medium text-fg-secondary">Default model</label>
        <select
          value={settings['default_model'] ?? MODELS[0]}
          onChange={e => set('default_model', e.target.value)}
          className="w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none"
        >
          {MODELS.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-fg-secondary">Global system prompt</label>
        <textarea
          rows={5}
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
    </div>
  );
}

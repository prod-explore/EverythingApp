import { useSettings } from '../../../hooks/useSettings';
import { useModels } from '../../../hooks/useModels';
import { ProvidersSection } from './ProvidersSection';
import { ModelSlots } from './ModelSlots';

export function ModelsTab() {
  const { settings, set } = useSettings();
  const { refresh: refreshModels } = useModels();

  return (
    <div className="space-y-6">
      <ProvidersSection onChanged={refreshModels} />
      <ModelSlots onChanged={refreshModels} />

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

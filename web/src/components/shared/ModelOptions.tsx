import { PROVIDER_LABELS } from '../../hooks/useModels';
import type { ModelOption } from '../../types';

/** <option>s grouped by provider; models whose provider has no key are shown but disabled. */
export function ModelOptions({ models, current }: { models: ModelOption[]; current?: string | null }) {
  const groups = [...new Set(models.map(m => m.provider))];
  const known = models.some(m => m.id === current);
  return (
    <>
      {/* A conversation can carry a model that isn't in the catalog (older/custom id) — keep it selectable. */}
      {current && !known && <option value={current}>{current}</option>}
      {groups.map(g => (
        <optgroup key={g} label={PROVIDER_LABELS[g] ?? g}>
          {models
            .filter(m => m.provider === g)
            .map(m => (
              <option key={m.id} value={m.id} disabled={!m.available && m.id !== current}>
                {m.label}
                {m.available ? '' : ' — no key'}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

import type { ModelOption } from '../../types';

const tagSuffix = (m: ModelOption) => {
  const parts = [...(m.locality === 'local' ? ['local'] : []), ...m.tags.slice(0, 3)];
  return parts.length ? ` · ${parts.join(', ')}` : '';
};

/** <option>s grouped by provider (chat models that can call tools — the app is an agent, a model without tools is of no use); models whose provider has no key are shown but disabled. */
export function ModelOptions({ models, current, onlyLocal = false }: { models: ModelOption[]; current?: string | null; /** Ghost chats: only models known to run on the user's own hardware. */ onlyLocal?: boolean }) {
  const chat = models.filter(m => m.kind === 'chat' && m.toolSchemaMode !== 'none' && (!onlyLocal || m.locality === 'local'));
  const groups = [...new Set(chat.map(m => m.provider))];
  const known = chat.some(m => m.id === current);
  return (
    <>
      {/* A conversation can carry a model that isn't in the catalog any more (older id, removed provider) — keep it selectable. */}
      {current && !known && <option value={current}>{current}</option>}
      {groups.map(g => {
        const inGroup = chat.filter(m => m.provider === g);
        return (
          <optgroup key={g} label={inGroup[0]?.providerLabel ?? g}>
            {inGroup.map(m => (
              <option key={m.id} value={m.id} disabled={!m.available && m.id !== current} title={m.description || undefined}>
                {m.label}
                {tagSuffix(m)}
                {m.available ? '' : ' — no key'}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

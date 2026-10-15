import { useCallback, useEffect, useState } from 'react';
import { getSlots, setSlots } from '../../../api';
import { chatModels, useModels } from '../../../hooks/useModels';
import type { SlotKey, SlotsResponse } from '../../../types';
import { ModelOptions } from '../../shared/ModelOptions';

const selectCls = 'w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none';

const SLOTS: Array<{ key: SlotKey; label: string; auto: string; hint: string }> = [
  { key: 'chat', label: 'Chat default', auto: 'Automatic (first free model)', hint: 'What a new conversation starts on.' },
  { key: 'helper', label: 'Helper', auto: 'Automatic (first free model)', hint: 'Chat titles and the daily digest. Only ever a model you pick or a free one.' },
  { key: 'subagent', label: 'Agents', auto: 'Automatic (first free model)', hint: 'Default model for workers the assistant starts.' },
  { key: 'escalation', label: 'Escalation', auto: 'None', hint: 'The stronger model the assistant reaches for when a job is hard.' },
];

/** Which model does which job. An unset slot is resolved from the model tags (the `free` tag in particular). */
export function ModelSlots({ onChanged }: { onChanged?: () => void }) {
  const { models } = useModels();
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => { getSlots().then(setData).catch(e => setError((e as Error).message)); }, []);
  useEffect(load, [load, models.length]);

  async function save(patch: Parameters<typeof setSlots>[0]) {
    setError(null);
    try {
      setData(await setSlots(patch));
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data) return <p className="text-xs text-fg-tertiary">Loading…</p>;
  const chat = chatModels(models);
  const nameOf = (id: string | null) => (id ? (models.find(m => m.id === id)?.label ?? id) : 'nothing usable yet');

  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-fg-secondary">Model slots</label>
      {SLOTS.map(s => (
        <div key={s.key}>
          <label htmlFor={`slot-${s.key}`} className="mb-1 block text-xs text-fg-secondary">{s.label}</label>
          <select
            id={`slot-${s.key}`}
            value={data.slots[s.key]}
            onChange={e => void save({ [s.key]: e.target.value })}
            className={selectCls}
          >
            <option value="">{s.auto}</option>
            <ModelOptions models={chat} current={data.slots[s.key] || null} />
          </select>
          <p className="mt-1 text-xs text-fg-tertiary">
            {s.hint} {data.slots[s.key] === '' && <>Now: <span className="text-fg-secondary">{nameOf(data.resolved[s.key])}</span>.</>}
          </p>
        </div>
      ))}
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={data.allowPaidAgents}
          onChange={e => void save({ allowPaidAgents: e.target.checked })}
        />
        <span>
          Allow agents to use paid models
          <span className="block text-xs text-fg-tertiary">
            Off: a chat running on a free model can only start free workers. Switch the chat itself to a stronger model to delegate to paid ones.
          </span>
        </span>
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

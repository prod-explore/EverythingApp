import { useCallback, useEffect, useState } from 'react';
import { getModels } from '../api';
import type { ModelOption } from '../types';

/** The server's model catalog, annotated with whether each model's provider has a key. Refresh after saving/removing a key. */
const MODELS_CHANGED = 'ea:models-changed';

export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    getModels().then(r => { setModels(r.models); setLoaded(true); }).catch(() => {});
  }, []);
  // Every useModels() instance (header picker, Settings) reloads when any of them changes keys/providers.
  useEffect(() => {
    load();
    window.addEventListener(MODELS_CHANGED, load);
    return () => window.removeEventListener(MODELS_CHANGED, load);
  }, [load]);
  const refresh = useCallback(() => window.dispatchEvent(new Event(MODELS_CHANGED)), []);
  return { models, loaded, refresh };
}

/** Group label for a provider slug, taken from the catalog; falls back to the slug (e.g. a provider removed since). */
export function providerLabel(provider: string, models: Array<{ provider: string; providerLabel: string }> = []): string {
  return models.find(m => m.provider === provider)?.providerLabel ?? provider;
}

/** Chat-capable models only — what a conversation or an agent can run on. Voice/image models have their own pickers later. */
export const chatModels = (models: ModelOption[]): ModelOption[] => models.filter(m => m.kind === 'chat');

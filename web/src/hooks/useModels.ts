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

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  mindgate: 'MindGate',
};

/** Group label for a provider id; custom providers (`custom:slug`) take the label shown in their model names. */
export function providerLabel(provider: string, models: Array<{ provider: string; label: string }> = []): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  if (provider.startsWith('custom:')) {
    const m = models.find(x => x.provider === provider);
    const fromLabel = m ? /\(([^)]+)\)\s*$/.exec(m.label)?.[1] : undefined;
    return fromLabel ?? provider.slice(7);
  }
  return provider;
}

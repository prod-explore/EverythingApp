import { useCallback, useEffect, useState } from 'react';
import { getModels } from '../api';
import type { ModelOption } from '../types';

/** The server's model catalog, annotated with whether each model's provider has a key. Refresh after saving/removing a key. */
export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const refresh = useCallback(() => {
    getModels().then(r => setModels(r.models)).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  return { models, refresh };
}

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
};

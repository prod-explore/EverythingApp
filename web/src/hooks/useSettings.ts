import { useCallback, useEffect, useState } from 'react';
import { getSettings, putSetting } from '../api';

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { settings: s } = await getSettings();
    setSettings(s);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const set = useCallback(async (key: string, value: string) => {
    // Optimistic — settings are low-stakes and local-only; waiting on the
    // round trip before reflecting a toggle in the UI reads as lag for no
    // real benefit.
    setSettings(prev => ({ ...prev, [key]: value }));
    await putSetting(key, value);
  }, []);

  return { settings, loading, set, refresh };
}

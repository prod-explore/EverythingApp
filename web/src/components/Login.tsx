import { useState } from 'react';
import { setToken } from '../api';
import { Button } from './shared/Button';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit() {
    const token = value.trim();
    if (!token || checking) return;
    setError(null);
    setChecking(true);
    try {
      // A raw fetch, deliberately bypassing api.ts's request() helper: that
      // helper treats any 401 as "the stored token went stale" and reacts
      // by clearing it and reloading the whole page — exactly the opposite
      // of what a login attempt needs, which is to fail quietly in place.
      const res = await fetch('/api/conversations', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        setError(res.status === 401 ? 'Wrong token.' : `Server error (${res.status}).`);
        return;
      }
      setToken(token);
      onSuccess();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg p-6">
      <h1 className="text-lg font-medium text-fg">EverythingApp</h1>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <input
          type="password"
          autoFocus
          placeholder="Access token"
          value={value}
          onChange={e => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={e => e.key === 'Enter' && submit()}
          aria-invalid={error ? true : undefined}
          className={`rounded-button border bg-bg-secondary px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover ${
            error ? 'border-red-500' : 'border-border'
          }`}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <Button onClick={submit} disabled={checking}>
          {checking ? 'Checking…' : 'Enter'}
        </Button>
      </div>
    </div>
  );
}

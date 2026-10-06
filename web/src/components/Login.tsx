import { useState } from 'react';
import { ApiError, login } from '../api';
import { Button } from './shared/Button';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit() {
    if (!value || checking) return;
    setError(null);
    setChecking(true);
    try {
      await login(value);
      onSuccess();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(
          e.status === 401 ? 'Wrong password.'
          : e.status === 429 ? 'Too many failed attempts — try again in a few minutes.'
          : `Server error (${e.status}).`,
        );
      } else {
        setError('Could not reach the server.');
      }
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
          placeholder="Password"
          autoComplete="current-password"
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

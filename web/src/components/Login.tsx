import { useState } from 'react';
import { setToken } from '../api';
import { Button } from './shared/Button';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState('');

  function submit() {
    if (!value.trim()) return;
    setToken(value.trim());
    onSuccess();
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
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          className="rounded-button border border-border bg-bg-secondary px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover"
        />
        <Button onClick={submit}>Enter</Button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/Button';

export function NewProjectModal({ onSubmit, onClose }: { onSubmit: (name: string) => Promise<void> | void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSubmit(trimmed);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="New project" className="w-full max-w-sm rounded-lg border border-border bg-bg p-4 shadow-xl">
        <h2 className="mb-3 text-sm font-medium text-fg">New project</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') {
              e.stopPropagation(); // don't also close whatever panel the global Escape handler would close
              onClose();
            }
          }}
          placeholder="Project name"
          maxLength={80}
          className="w-full rounded-button border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none focus:border-border-hover"
        />
        {failed && <p className="mt-2 text-xs text-danger">Couldn't create the project. Try again.</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}

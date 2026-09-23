import { useEffect } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  onClose,
  children,
  wide,
  headerExtra,
}: PropsWithChildren<{ title: string; onClose: () => void; wide?: boolean; headerExtra?: ReactNode }>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`max-h-[85vh] w-full ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-y-auto rounded-container border border-border bg-bg-secondary p-6`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          <div className="flex items-center gap-1">
            {headerExtra}
            <button
              onClick={onClose}
              className="rounded-full p-1 text-fg-secondary hover:bg-bg-tertiary hover:text-fg"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  onClose,
  children,
  wide,
  headerExtra,
  tabs,
}: PropsWithChildren<{
  title: string;
  onClose: () => void;
  wide?: boolean;
  headerExtra?: ReactNode;
  /** Pinned under the title (e.g. a tab bar) — stays visible while the body scrolls. */
  tabs?: ReactNode;
}>) {
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
        className={`flex max-h-[85vh] w-full ${wide ? 'max-w-2xl' : 'max-w-md'} flex-col overflow-hidden rounded-container border border-border bg-bg-secondary`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Header (+ optional tabs) never scroll away; only the body below does. */}
        <div className="shrink-0 px-6 pt-6">
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
          {tabs}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2">{children}</div>
      </div>
    </div>
  );
}

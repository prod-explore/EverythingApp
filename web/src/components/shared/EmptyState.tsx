import type { LucideIcon } from 'lucide-react';

export function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-fg-tertiary">
      <Icon size={28} strokeWidth={1.5} />
      <p className="text-sm">{message}</p>
    </div>
  );
}

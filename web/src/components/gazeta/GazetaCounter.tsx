/** Open-item count; turns red (with the urgent count) while anything urgent is waiting. */
export function GazetaCounter({ count, urgent = 0 }: { count: number; urgent?: number }) {
  if (count === 0) return null;
  const label = urgent > 0 ? `${count} open, ${urgent} urgent` : `${count} open`;
  return (
    <span
      className={`ml-auto rounded-full px-1.5 py-0.5 text-xs ${urgent > 0 ? 'bg-danger text-bg' : 'bg-fg text-bg'}`}
      aria-label={label}
      title={label}
    >
      {urgent > 0 ? `${urgent}!` : ''}
      {urgent > 0 && count > urgent ? ` / ${count}` : urgent > 0 ? '' : count}
    </span>
  );
}

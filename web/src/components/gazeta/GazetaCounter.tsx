export function GazetaCounter({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="ml-auto rounded-full bg-fg px-1.5 py-0.5 text-xs text-bg">{count}</span>;
}

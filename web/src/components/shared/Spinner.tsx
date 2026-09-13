export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-fg-tertiary border-t-fg"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

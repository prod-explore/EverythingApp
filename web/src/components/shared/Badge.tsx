import type { PropsWithChildren } from 'react';

type Tone = 'neutral' | 'danger' | 'success';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-border text-fg-secondary',
  danger: 'border-danger/40 text-danger',
  success: 'border-success/40 text-success',
};

export function Badge({ tone = 'neutral', children }: PropsWithChildren<{ tone?: Tone }>) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

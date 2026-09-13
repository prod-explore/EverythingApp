import { ComposerPrimitive } from '@assistant-ui/react';
import { Square } from 'lucide-react';

export function StopButton() {
  return (
    <ComposerPrimitive.Cancel
      className="shrink-0 rounded-button border border-danger/40 p-2.5 text-danger hover:bg-danger/10"
      title="Stop (kill switch)"
    >
      <Square size={16} />
    </ComposerPrimitive.Cancel>
  );
}

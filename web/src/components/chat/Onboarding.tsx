import { useAui } from '@assistant-ui/react';
import { Bot, FolderTree, Globe, HelpCircle, KeyRound, Sparkles } from 'lucide-react';
import { useModels } from '../../hooks/useModels';

const SUGGESTIONS = [
  { icon: Globe, text: 'Browse example.com and summarize it' },
  { icon: FolderTree, text: 'Create a simple Node.js project in the sandbox' },
  { icon: HelpCircle, text: 'Ask me questions before starting a big task' },
  { icon: Bot, text: 'Start an agent to research a topic and write a report' },
];

/** Shown in an empty chat: a setup prompt when no model is usable yet, otherwise a few conversation starters. */
export function Onboarding({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { models, loaded } = useModels();
  const aui = useAui();
  if (!loaded) return null;
  const hasModel = models.some(m => m.kind === 'chat' && m.available);

  if (!hasModel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Sparkles size={30} strokeWidth={1.5} className="text-fg-tertiary" />
        <h2 className="text-lg font-semibold text-fg">Welcome to EverythingApp</h2>
        <p className="max-w-sm text-sm text-fg-tertiary">
          To get started, add a model provider — your MindGate hub, an API key (Gemini, DeepSeek, OpenRouter…) or any OpenAI-compatible server, local ones included.
        </p>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 rounded-button bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
        >
          <KeyRound size={15} /> Add a model in Settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Sparkles size={28} strokeWidth={1.5} className="text-fg-tertiary" />
      <p className="text-sm text-fg-tertiary">How can I help? Write a message or start from a suggestion:</p>
      <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map(s => (
          <button
            key={s.text}
            onClick={() => {
              aui.thread.composer().setText(s.text);
              document.getElementById('composer-input')?.focus();
            }}
            className="flex items-start gap-2 rounded-container border border-border bg-bg-secondary px-3 py-2.5 text-left text-xs text-fg-secondary hover:border-border-hover hover:text-fg"
          >
            <s.icon size={14} className="mt-0.5 shrink-0 text-fg-tertiary" />
            {s.text}
          </button>
        ))}
      </div>
    </div>
  );
}

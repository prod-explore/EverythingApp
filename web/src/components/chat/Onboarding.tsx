import { useAui } from '@assistant-ui/react';
import { Bot, FolderTree, Globe, HelpCircle, KeyRound, Sparkles } from 'lucide-react';
import { useModels } from '../../hooks/useModels';

const SUGGESTIONS = [
  { icon: Globe, text: 'Przejrzyj stronę example.com i streść ją' },
  { icon: FolderTree, text: 'Stwórz w sandboxie prosty projekt Node.js' },
  { icon: HelpCircle, text: 'Zadaj mi pytania, zanim zaczniesz duże zadanie' },
  { icon: Bot, text: 'Uruchom agenta, który zbada temat i zrobi raport' },
];

/** Shown in an empty chat: a setup prompt when no model is usable yet, otherwise a few conversation starters. */
export function Onboarding({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { models, loaded } = useModels();
  const aui = useAui();
  if (!loaded) return null;
  const hasModel = models.some(m => m.available);

  if (!hasModel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Sparkles size={30} strokeWidth={1.5} className="text-fg-tertiary" />
        <h2 className="text-lg font-semibold text-fg">Witaj w EverythingApp</h2>
        <p className="max-w-sm text-sm text-fg-tertiary">
          Żeby zacząć, dodaj dostawcę modelu — klucz API (Anthropic, Gemini, DeepSeek…) albo własny serwer zgodny z OpenAI, także lokalny.
        </p>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 rounded-button bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
        >
          <KeyRound size={15} /> Dodaj model w Ustawieniach
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Sparkles size={28} strokeWidth={1.5} className="text-fg-tertiary" />
      <p className="text-sm text-fg-tertiary">W czym mogę pomóc? Napisz wiadomość albo zacznij od podpowiedzi:</p>
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

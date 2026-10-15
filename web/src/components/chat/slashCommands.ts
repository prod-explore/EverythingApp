export interface SlashCommand { name: string; hint: string }

/** Commands the composer understands. Chat-level ones are handled in App.tsx via the `app:command` event. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', hint: 'Start a new conversation' },
  { name: 'export', hint: 'Download this chat as Markdown' },
  { name: 'init', hint: 'Have the assistant write AGENTS.md for this project' },
  { name: 'compact', hint: 'Summarise older messages to free context' },
  { name: 'agents', hint: 'Open the Agents panel' },
  { name: 'files', hint: 'Open the Files panel' },
  { name: 'search', hint: 'Search all conversations' },
];

/** Lists commands while the composer text is a bare "/word"; Enter/Tab runs the highlighted one. */

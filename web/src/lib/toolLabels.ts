import {
  Bot, Camera, Clock, FilePen, FileText, Flag, Globe, GitBranch, HelpCircle, MessageSquare, MousePointerClick,
  Search, Square, Terminal, Wrench, type LucideIcon,
} from 'lucide-react';

export type ToolLabel = { icon: LucideIcon; label: string; detail?: string };

type Args = Record<string, unknown> | undefined;

function str(args: Args, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.length > 40 ? `${url.slice(0, 40)}…` : url;
  }
}

function clip(s: string | undefined, n = 60): string | undefined {
  if (!s) return undefined;
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** MCP tools are exposed as `<server>__<tool>`; the friendly label only cares about the tool part. */
function baseName(toolName: string): string {
  const i = toolName.lastIndexOf('__');
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

/**
 * Human-readable label + icon for a raw tool call (F13). Unknown tools fall back to the raw name,
 * so a new connector never renders as nothing. Past tense once finished, present while running.
 */
export function toolLabel(toolName: string, args: Args, running: boolean): ToolLabel {
  const name = baseName(toolName);
  const r = (done: string, doing: string) => (running ? doing : done);
  switch (name) {
    case 'request_human_input':
      return { icon: HelpCircle, label: r('Zapytał Cię', 'Pyta Cię'), detail: clip(str(args, 'question', 'title', 'prompt')) };
    case 'post_report':
      return { icon: Flag, label: r('Opublikował raport', 'Publikuje raport'), detail: clip(str(args, 'title')) };
    case 'run_bash':
      return { icon: Terminal, label: r('Wykonał polecenie', 'Wykonuje polecenie'), detail: clip(str(args, 'command', 'cmd')) };
    case 'git_op':
      return { icon: GitBranch, label: r('Użył gita', 'Używa gita'), detail: clip(str(args, 'op', 'operation', 'command')) };
    case 'read_file':
      return { icon: FileText, label: r('Przeczytał plik', 'Czyta plik'), detail: clip(str(args, 'path', 'file')) };
    case 'write_file':
    case 'edit_file':
      return { icon: FilePen, label: r('Zapisał plik', 'Zapisuje plik'), detail: clip(str(args, 'path', 'file')) };
    case 'browse_url':
    case 'browser_open':
      return { icon: Globe, label: r('Przeglądał stronę', 'Przegląda stronę'), detail: host(str(args, 'url')) };
    case 'browser_observe':
      return { icon: Globe, label: r('Obejrzał stronę', 'Ogląda stronę') };
    case 'browser_act':
      return { icon: MousePointerClick, label: r('Kliknął na stronie', 'Działa na stronie'), detail: clip(str(args, 'label', 'action')) };
    case 'browser_screenshot':
    case 'browser_recording':
      return { icon: Camera, label: r('Zrobił zrzut ekranu', 'Robi zrzut ekranu') };
    case 'browser_close':
      return { icon: Globe, label: r('Zamknął przeglądarkę', 'Zamyka przeglądarkę') };
    case 'web_search':
      return { icon: Search, label: r('Szukał w sieci', 'Szuka w sieci'), detail: clip(str(args, 'query', 'q')) };
    case 'spawn_agent':
    case 'spawn_subagent':
      return { icon: Bot, label: r('Uruchomił agenta', 'Uruchamia agenta'), detail: clip(str(args, 'name', 'role', 'goal', 'task')) };
    case 'wait_agents':
      return { icon: Clock, label: r('Poczekał na agentów', 'Czeka na agentów') };
    case 'send_message':
      return { icon: MessageSquare, label: r('Wysłał wiadomość do agenta', 'Wysyła wiadomość do agenta') };
    case 'stop_agent':
      return { icon: Square, label: r('Zatrzymał agenta', 'Zatrzymuje agenta') };
    case 'list_agents':
    case 'get_run':
      return { icon: Bot, label: r('Sprawdził agentów', 'Sprawdza agentów') };
    default:
      return { icon: Wrench, label: toolName };
  }
}

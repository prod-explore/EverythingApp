import {
  Bot, Camera, ClipboardList, Clock, FilePen, FileText, Flag, Globe, GitBranch, HelpCircle, MessageSquare, MousePointerClick,
  ListChecks, Search, Square, Terminal, Wrench, type LucideIcon,
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
      return { icon: HelpCircle, label: r('Asked you', 'Asking you'), detail: clip(str(args, 'question', 'title', 'prompt')) };
    case 'todo_write':
      return { icon: ListChecks, label: r('Updated the task list', 'Updating the task list') };
    case 'propose_plan':
      return { icon: ClipboardList, label: r('Proposed a plan', 'Proposing a plan') };
    case 'post_report':
      return { icon: Flag, label: r('Posted a report', 'Posting a report'), detail: clip(str(args, 'title')) };
    case 'run_bash':
      return { icon: Terminal, label: r('Ran a command', 'Running a command'), detail: clip(str(args, 'command', 'cmd')) };
    case 'git_op':
      return { icon: GitBranch, label: r('Used git', 'Using git'), detail: clip(str(args, 'op', 'operation', 'command')) };
    case 'read_file':
      return { icon: FileText, label: r('Read a file', 'Reading a file'), detail: clip(str(args, 'path', 'file')) };
    case 'write_file':
      return { icon: FilePen, label: r('Wrote a file', 'Writing a file'), detail: clip(str(args, 'path', 'file')) };
    case 'edit_file':
      return { icon: FilePen, label: r('Edited a file', 'Editing a file'), detail: clip(str(args, 'path', 'file')) };
    case 'browse_url':
    case 'browser_open':
      return { icon: Globe, label: r('Browsed a page', 'Browsing a page'), detail: host(str(args, 'url')) };
    case 'browser_observe':
      return { icon: Globe, label: r('Looked at the page', 'Looking at the page') };
    case 'browser_act':
      return { icon: MousePointerClick, label: r('Acted on the page', 'Acting on the page'), detail: clip(str(args, 'label', 'action')) };
    case 'browser_screenshot':
    case 'browser_recording':
      return { icon: Camera, label: r('Took a screenshot', 'Taking a screenshot') };
    case 'browser_close':
      return { icon: Globe, label: r('Closed the browser', 'Closing the browser') };
    case 'web_search':
      return { icon: Search, label: r('Searched the web', 'Searching the web'), detail: clip(str(args, 'query', 'q')) };
    case 'spawn_agent':
      return { icon: Bot, label: r('Started an agent', 'Starting an agent'), detail: clip(str(args, 'name', 'role', 'goal', 'task')) };
    case 'wait_agents':
      return { icon: Clock, label: r('Waited for agents', 'Waiting for agents') };
    case 'send_message':
      return { icon: MessageSquare, label: r('Messaged an agent', 'Messaging an agent') };
    case 'stop_agent':
      return { icon: Square, label: r('Stopped an agent', 'Stopping an agent') };
    case 'list_agents':
    case 'get_run':
      return { icon: Bot, label: r('Checked on agents', 'Checking on agents') };
    default:
      return { icon: Wrench, label: toolName };
  }
}

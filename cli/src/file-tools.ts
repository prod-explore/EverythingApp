import type * as Llm from './llm-types.js';
import type { VirtualTool } from './llm-loop.js';
import type { SandboxExec } from './supervisor-client.js';
import { MAX_EDIT_BYTES, resolveWorkspacePath, WorkspaceWriteError, writeWorkspaceFile } from './workspace-write.js';

/**
 * Chat functions for text files in the project workspace: read_file, write_file, edit_file. Like in Claude Code,
 * changing a text file is not something the user is asked to approve every time — the tools only reach /workspace of the
 * chat's own sandbox, `.git` is off limits, and a checkpoint is taken before every turn (Files → Checkpoints rolls back).
 * Shell commands (run_bash) keep going through the command policy.
 */

const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 60_000;
const DIFF_MAX_LINES = 40;

export const READ_FILE_TOOL: Llm.Tool = {
  name: 'read_file',
  description:
    'Read a text file from the project workspace. Returns the lines numbered ("  12\\t…"). Long files are returned in parts: pass offset (1-based line) and limit to continue. ' +
    'Paths are relative to /workspace (or absolute inside it).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, e.g. "src/app.ts".' },
      offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
      limit: { type: 'integer', description: `Number of lines. Default ${READ_DEFAULT_LINES}.` },
    },
    required: ['path'],
  },
};

export const WRITE_FILE_TOOL: Llm.Tool = {
  name: 'write_file',
  description:
    'Create a text file in the project workspace, or replace it completely (missing folders are created). ' +
    'For a change to part of an existing file use edit_file — it is safer and cheaper. The user is not asked to approve this; ' +
    'a checkpoint of the workspace is taken at the start of every turn.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, e.g. "notes/todo.md".' },
      content: { type: 'string', description: 'The complete new content of the file.' },
    },
    required: ['path', 'content'],
  },
};

export const EDIT_FILE_TOOL: Llm.Tool = {
  name: 'edit_file',
  description:
    'Change part of an existing text file by replacing an exact piece of text. old_string must match the file exactly (whitespace and line breaks included) ' +
    'and be unique in it — include a few surrounding lines to make it unique, or set replace_all to change every occurrence. Read the file first. ' +
    'The user is not asked to approve this.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'The exact text to replace.' },
      new_string: { type: 'string', description: 'The replacement (may be empty to delete the text).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

/** Appended to the system prompt of every chat (every chat has a workspace). */
export const FILE_TOOLS_PROMPT =
  'To look at or change text files use read_file, edit_file and write_file (no approval needed) rather than cat/sed/echo redirections in the shell. ' +
  'Read a file before editing it, prefer edit_file over rewriting a whole file, and keep run_bash for running programs. ' +
  'When you produce a file the user is meant to open (a report, a document, an image), pin it with pin_file.';

export const PIN_FILE_TOOL: Llm.Tool = {
  name: 'pin_file',
  description:
    'Pin a file of the workspace so the user finds it at the top of the Files panel — use it for what the user is meant to open: ' +
    'a report, a result, a generated document or image. A pin only points at the file; the user always sees its current version. ' +
    'Do not pin working files. The user is not asked to approve this.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, e.g. "out/report.md".' },
      note: { type: 'string', description: 'Optional one-line description shown next to the pin.' },
    },
    required: ['path'],
  },
};

export const UNPIN_FILE_TOOL: Llm.Tool = {
  name: 'unpin_file',
  description: 'Remove the pin of a file (the file itself stays in the workspace).',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

export interface FileToolsDeps {
  owner: string;
  sandbox: SandboxExec;
  /** Bytes of a workspace file (the supervisor's reader; works while the sandbox is stopped). */
  readFile: (owner: string, path: string) => Promise<Buffer>;
  /** Called after every successful change, for the audit log. */
  onWrite?: (info: { action: 'write_file' | 'edit_file'; path: string; bytes: number }) => void;
  /** Where pins are kept; without it the pin tools are not offered. */
  pins?: { add: (path: string, note?: string) => void; remove: (path: string) => boolean };
}

const err = (text: string) => ({ text, isError: true as const });
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Reads a file as UTF-8 text; refuses binary content. */
async function readText(deps: FileToolsDeps, path: string): Promise<string | { error: string }> {
  let buf: Buffer;
  try {
    buf = await deps.readFile(deps.owner, path);
  } catch (e) {
    const m = (e as Error).message;
    return { error: /not found|no such|404|ENOENT/i.test(m) ? `File not found: ${path}` : `Could not read ${path}: ${m}` };
  }
  if (buf.includes(0)) return { error: `${path} looks like a binary file — read_file/edit_file only handle text.` };
  return buf.toString('utf8');
}

/** A short before/after of what changed, so the transcript shows the edit without re-reading the file. */
export function miniDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const out = [
    ...a.slice(start, endA + 1).map(l => `- ${l}`),
    ...b.slice(start, endB + 1).map(l => `+ ${l}`),
  ];
  const shown = out.slice(0, DIFF_MAX_LINES);
  if (out.length > shown.length) shown.push(`… (${out.length - shown.length} more changed lines)`);
  return `@@ line ${start + 1} @@\n${shown.join('\n')}`;
}

export function fileTools(deps: FileToolsDeps): VirtualTool[] {
  const resolve = (raw: unknown): string | { error: string } => {
    const p = str(raw);
    if (!p) return { error: 'path is required' };
    try { return resolveWorkspacePath(p); } catch (e) { return { error: (e as Error).message }; }
  };

  const readTool: VirtualTool = {
    definition: READ_FILE_TOOL,
    handler: async input => {
      const path = resolve(input['path']);
      if (typeof path !== 'string') return err(path.error);
      const text = await readText(deps, path);
      if (typeof text !== 'string') return err(text.error);
      const lines = text.split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const offset = Math.max(1, Math.floor(Number(input['offset'])) || 1);
      const limit = Math.max(1, Math.floor(Number(input['limit'])) || READ_DEFAULT_LINES);
      if (offset > lines.length && lines.length > 0) return err(`${path} has only ${lines.length} lines.`);
      let chars = 0;
      const out: string[] = [];
      let i = offset - 1;
      for (; i < lines.length && out.length < limit; i++) {
        const row = `${String(i + 1).padStart(6)}\t${lines[i]}`;
        if (chars + row.length > READ_MAX_CHARS && out.length > 0) break;
        out.push(row);
        chars += row.length + 1;
      }
      const more = i < lines.length ? `\n[… ${lines.length - i} more lines — continue with offset ${i + 1}]` : '';
      return { text: (out.length ? out.join('\n') : '(empty file)') + more };
    },
  };

  const writeTool: VirtualTool = {
    definition: WRITE_FILE_TOOL,
    handler: async input => {
      const content = str(input['content']);
      if (content === undefined) return err('content must be a string (the complete file).');
      if (content.includes('\0')) return err('content contains NUL bytes — only text files can be written.');
      try {
        const r = await writeWorkspaceFile(deps.sandbox, deps.owner, str(input['path']) ?? '', content);
        deps.onWrite?.({ action: 'write_file', path: r.path, bytes: r.bytes });
        return { text: `Saved ${r.path} (${r.bytes} bytes).` };
      } catch (e) {
        return err(e instanceof WorkspaceWriteError ? e.message : `write failed: ${(e as Error).message}`);
      }
    },
  };

  const editTool: VirtualTool = {
    definition: EDIT_FILE_TOOL,
    handler: async input => {
      const path = resolve(input['path']);
      if (typeof path !== 'string') return err(path.error);
      const oldS = str(input['old_string']);
      const newS = str(input['new_string']);
      if (!oldS) return err('old_string must be a non-empty string. To create or replace a whole file use write_file.');
      if (newS === undefined) return err('new_string must be a string (empty to delete the text).');
      if (oldS === newS) return err('old_string and new_string are identical — nothing to change.');
      const before = await readText(deps, path);
      if (typeof before !== 'string') return err(before.error);
      if (Buffer.byteLength(before, 'utf8') > MAX_EDIT_BYTES) return err(`${path} is larger than ${MAX_EDIT_BYTES / 1024} KB — change it with a shell command instead.`);

      const count = before.split(oldS).length - 1;
      if (count === 0) return err(`old_string was not found in ${path}. It must match exactly, including whitespace and line breaks — read the file again and copy the text.`);
      if (count > 1 && input['replace_all'] !== true) {
        return err(`old_string occurs ${count} times in ${path}. Add surrounding lines to make it unique, or set replace_all to change every occurrence.`);
      }
      // split/join instead of String.replace: no `$&` style substitutions in the replacement text.
      const after = before.split(oldS).join(newS);
      try {
        const r = await writeWorkspaceFile(deps.sandbox, deps.owner, path, after);
        deps.onWrite?.({ action: 'edit_file', path: r.path, bytes: r.bytes });
        return { text: `Edited ${r.path}: ${count} replacement${count === 1 ? '' : 's'}.\n${miniDiff(before, after)}` };
      } catch (e) {
        return err(e instanceof WorkspaceWriteError ? e.message : `write failed: ${(e as Error).message}`);
      }
    },
  };

  const pins = deps.pins;
  const pinTool: VirtualTool | null = pins ? {
    definition: PIN_FILE_TOOL,
    handler: async input => {
      const path = resolve(input['path']);
      if (typeof path !== 'string') return err(path.error);
      try { await deps.readFile(deps.owner, path); } catch { return err(`${path} does not exist — write the file first, then pin it.`); }
      pins.add(path, str(input['note']));
      return { text: `Pinned ${path}. The user sees it at the top of the Files panel.` };
    },
  } : null;
  const unpinTool: VirtualTool | null = pins ? {
    definition: UNPIN_FILE_TOOL,
    handler: async input => {
      const path = resolve(input['path']);
      if (typeof path !== 'string') return err(path.error);
      return pins.remove(path) ? { text: `Unpinned ${path}.` } : err(`${path} is not pinned.`);
    },
  } : null;

  return [readTool, editTool, writeTool, ...(pinTool && unpinTool ? [pinTool, unpinTool] : [])];
}

/**
 * Command policy engine (Plan v3 §5) — replaces "approve per tool" for shell commands.
 *
 * Before: the approval key was the tool name, so "always" on run_bash let every command through.
 * Now: a command is split into its sub-commands (`a && b | c; $(d)`), each one is classified
 * allow / ask / deny against the project policy and the persisted prefix grants, and the whole
 * command is only as permissive as its least permissive part. An allow on `ls` therefore never
 * lets `ls && rm -rf ~` through.
 *
 * This is a gate on what runs inside the sandbox — the sandbox itself is still the boundary.
 */

export type CommandMode = 'strict' | 'auto' | 'allowlist';
export type CommandDecision = 'allow' | 'ask' | 'deny';

export interface CommandPolicy {
  /** strict: ask for every command (unless granted); auto: ask only when crossing a boundary; allowlist: allow prefixes, ask the rest. */
  mode: CommandMode;
  /** Extra allowed prefixes (on top of SAFE_PREFIXES in allowlist mode). */
  allow: string[];
  /** Always-blocked prefixes / patterns (on top of DENY_PATTERNS). */
  deny: string[];
  /** Domains network commands may reach without asking in auto mode (glob: `*.npmjs.org`). */
  domains: string[];
}

export const DEFAULT_COMMAND_POLICY: CommandPolicy = { mode: 'strict', allow: [], deny: [], domains: [] };

/** Read-only, side-effect-free prefixes — allowed without asking in allowlist mode. */
export const SAFE_PREFIXES = [
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'grep', 'rg', 'which', 'whoami', 'date',
  'tree', 'stat', 'file', 'du', 'df', 'env', 'printenv', 'sort', 'uniq', 'diff', 'true', 'false', 'test',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote -v', 'git rev-parse', 'git blame',
  'node --version', 'npm --version', 'npm ls', 'python --version', 'python3 --version',
];

/** Always blocked, regardless of mode or grants. */
const DENY_PATTERNS: RegExp[] = [
  /^rm\s+(-\w+\s+)*(\/|\/\*|~|~\/|\$HOME)(\s|$)/,
  /^(mkfs|mkfs\.\w+|fdisk|parted|wipefs)\b/,
  /^dd\b.*\bof=\/dev\//,
  /^(shutdown|reboot|halt|poweroff)\b/,
  /^:\(\)\s*\{/, // fork bomb
  /^chmod\s+(-\w+\s+)*[0-7]*777\s+\/(\s|$)/,
];

/** Commands with a meaningful sub-command: grant prefixes use two words (`git commit`, `npm install`). */
const TWO_WORD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'docker', 'cargo', 'go', 'pip', 'pip3', 'apt', 'apt-get', 'kubectl', 'gh', 'make', 'python', 'python3', 'node', 'uv', 'poetry']);

const NETWORK_TOOLS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);

export function parseCommandPolicy(raw: unknown): CommandPolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(s => s.trim()) : []);
  const mode = p['mode'] === 'auto' || p['mode'] === 'allowlist' || p['mode'] === 'strict' ? p['mode'] : 'strict';
  return { mode, allow: strings(p['allow']), deny: strings(p['deny']), domains: strings(p['domains']) };
}

// ─── Shell splitting ────────────────────────────────────────────────────────

/**
 * Splits a shell command into sub-commands: on `;`, `&&`, `||`, `|`, `&`, newlines, and recursively
 * into `$(…)`, `` `…` ``, `<(…)`/`>(…)` and `( … )` subshells. Quotes are respected (single quotes
 * are literal; double quotes still expand `$(…)`). Not a full bash parser — the goal is that no
 * executable part of the string escapes classification; an over-split only costs an extra prompt.
 */
export function splitShellCommand(command: string, depth = 0): string[] {
  const out: string[] = [];
  splitInto(command, out, 0);
  return out.map(normalize).filter(s => s !== '').flatMap(sub => {
    // `bash -c "…"`, `sh -c '…'`, `eval "…"`: the quoted string is itself a command line.
    const m = /^(?:(?:ba|z|da|k)?sh(?:\s+-\w+)*\s+-\w*c|eval)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(.+))/.exec(sub);
    if (!m || depth > 4) return [sub];
    return [sub.split(' ')[0]!, ...splitShellCommand(m[1] ?? m[2] ?? m[3] ?? '', depth + 1)];
  });
}

function splitInto(src: string, out: string[], depth: number): void {
  if (depth > 8) { out.push(src); return; }
  let cur = '';
  let i = 0;
  const flush = () => { out.push(cur); cur = ''; };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '\\' && next !== undefined) { cur += c + next; i += 2; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end + 1;
      cur += src.slice(i, stop); i = stop; continue;
    }
    if (c === '"') {
      // Double quotes: keep the text, but executable substitutions inside still count.
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') {
          const end = matchParen(src, j + 1);
          splitInto(src.slice(j + 2, end), out, depth + 1);
          j = end + 1; continue;
        }
        if (src[j] === '`') {
          const end = src.indexOf('`', j + 1);
          const stop = end === -1 ? src.length : end;
          splitInto(src.slice(j + 1, stop), out, depth + 1);
          j = stop + 1; continue;
        }
        j++;
      }
      cur += src.slice(i, Math.min(j + 1, src.length)); i = j + 1; continue;
    }
    if ((c === '$' || c === '<' || c === '>') && next === '(') {
      const end = matchParen(src, i + 1);
      splitInto(src.slice(i + 2, end), out, depth + 1);
      cur += ' __SUBST__ '; i = end + 1; continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end === -1 ? src.length : end;
      splitInto(src.slice(i + 1, stop), out, depth + 1);
      cur += ' __SUBST__ '; i = stop + 1; continue;
    }
    if (c === '(' && cur.trim() === '') {
      const end = matchParen(src, i);
      splitInto(src.slice(i + 1, end), out, depth + 1);
      i = end + 1; continue;
    }
    if (c === '{' && cur.trim() === '' && (next === ' ' || next === '\n')) { i++; continue; }
    if (c === '}' && cur.trim() === '') { i++; continue; }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl; continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      // `2>&1`, `&>file`, `>&2` are redirections, not separators.
      if (c === '&' && (src[i - 1] === '>' || src[i - 1] === '<' || next === '>')) { cur += c; i++; continue; }
      if (c === '|' && src[i - 1] === '>') { cur += c; i++; continue; } // `>|` clobber
      flush();
      i += (c === '&' && next === '&') || (c === '|' && (next === '|' || next === '&')) || (c === ';' && next === ';') ? 2 : 1;
      continue;
    }
    cur += c; i++;
  }
  flush();
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); i = e === -1 ? src.length : e; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

/** Trim, collapse whitespace, drop leading `VAR=value` assignments and wrappers like `sudo`/`env`/`time`. */
function normalize(sub: string): string {
  let s = sub.replace(/\s+/g, ' ').trim();
  for (;;) {
    const before = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s*/, '');
    s = s.replace(/^(sudo|env|time|nohup|nice|command|exec|builtin)(\s+-\S+)*\s+/, '');
    if (s === before) break;
  }
  return s.replace(/^(then|do|else|elif|if|while|until|!)\s+/, '').replace(/^(fi|done|esac|then|do|else)$/, '');
}

// ─── Classification ─────────────────────────────────────────────────────────

/** The prefix a grant for this sub-command would cover: `git commit`, `npm install`, `python3 script.py`→`python3`. */
export function grantPrefix(sub: string): string {
  const words = sub.split(' ').filter(Boolean);
  const first = (words[0] ?? '').replace(/^.*\//, ''); // /usr/bin/git → git
  if (!first) return '';
  const second = words[1];
  if (TWO_WORD.has(first) && second && /^[a-z][\w-]*$/.test(second)) return `${first} ${second}`;
  return first;
}

/** Word-boundary prefix match: `git status` matches `git status -s`, not `git statusx`; `ls` doesn't match `lsblk`. */
export function matchesPrefix(sub: string, prefix: string): boolean {
  const s = sub.replace(/^\S*\//, ''); // tolerate absolute binary paths
  return s === prefix || s.startsWith(prefix + ' ');
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

/** Boundary checks for auto mode: push, network to an unlisted domain, writes outside /workspace and /tmp. */
function crossesBoundary(sub: string, policy: CommandPolicy): string | null {
  const first = sub.split(' ')[0]!.replace(/^.*\//, '');
  if (/^git (push|remote (add|set-url))\b/.test(sub)) return 'pushes to or changes a remote';
  if (NETWORK_TOOLS.has(first)) {
    const hosts = [...sub.matchAll(/(?:https?|ftp|ssh):\/\/(?:[^@\s/]+@)?([^/\s:'"]+)/g)].map(m => m[1]!);
    if (first === 'ssh' || first === 'scp' || first === 'sftp' || first === 'rsync' || first === 'nc' || first === 'ncat' || first === 'telnet') {
      return `opens a ${first} connection`;
    }
    if (hosts.length === 0) return `network command without a recognisable URL`;
    const unknown = hosts.filter(h => !policy.domains.some(d => hostMatches(h, d)));
    if (unknown.length) return `reaches a new domain: ${unknown.join(', ')}`;
  }
  // Writes outside the workspace: redirections and write-ish commands targeting absolute paths.
  const writeTargets = [...sub.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(\/[^\s;|&]+)/g)].map(m => m[1]!);
  if (/^(rm|mv|cp|chmod|chown|ln|mkdir|touch|truncate|install)\b/.test(first)) {
    writeTargets.push(...sub.split(' ').slice(1).filter(w => w.startsWith('/')));
  }
  const outside = writeTargets.filter(p => !/^\/(workspace|tmp|dev\/null|dev\/stdout|dev\/stderr)(\/|$)/.test(p));
  if (outside.length) return `writes outside /workspace: ${outside.join(', ')}`;
  return null;
}

export interface SubcommandVerdict {
  command: string;
  prefix: string;
  decision: CommandDecision;
  reason: string;
}

export interface CommandVerdict {
  decision: CommandDecision;
  subcommands: SubcommandVerdict[];
}

/**
 * Classifies a full command line. `granted(prefix)` reports whether a persisted grant covers a
 * prefix in the current context (chat/project/always, model/skill scoped).
 */
export function evaluateCommand(command: string, policy: CommandPolicy, granted: (prefix: string) => boolean): CommandVerdict {
  const subs = splitShellCommand(command);
  if (subs.length === 0) return { decision: 'ask', subcommands: [] };

  const subcommands = subs.map((sub): SubcommandVerdict => {
    const prefix = grantPrefix(sub);
    if (DENY_PATTERNS.some(re => re.test(sub)) || policy.deny.some(d => matchesPrefix(sub, d))) {
      return { command: sub, prefix, decision: 'deny', reason: 'blocked by policy' };
    }
    if (sub.includes('__SUBST__') && prefix === '__SUBST__') {
      return { command: sub, prefix, decision: 'ask', reason: 'command name comes from a substitution' };
    }
    // A boundary crossing always asks — even with a grant, in every mode (Plan v3 §5).
    const boundary = crossesBoundary(sub, policy);
    if (boundary) return { command: sub, prefix, decision: 'ask', reason: boundary };
    if (granted(prefix)) return { command: sub, prefix, decision: 'allow', reason: 'granted' };
    if (policy.allow.some(a => matchesPrefix(sub, a))) return { command: sub, prefix, decision: 'allow', reason: 'project allowlist' };
    if (policy.mode === 'auto') return { command: sub, prefix, decision: 'allow', reason: 'auto mode (inside sandbox)' };
    if (policy.mode === 'allowlist' && SAFE_PREFIXES.some(a => matchesPrefix(sub, a))) {
      return { command: sub, prefix, decision: 'allow', reason: 'safe read-only command' };
    }
    return { command: sub, prefix, decision: 'ask', reason: policy.mode === 'strict' ? 'strict mode' : 'not on the allowlist' };
  });

  const decision: CommandDecision = subcommands.some(s => s.decision === 'deny')
    ? 'deny'
    : subcommands.every(s => s.decision === 'allow') ? 'allow' : 'ask';
  return { decision, subcommands };
}

/** Tools whose argument is a shell command, and where to find it. */
export function extractCommand(toolLabel: string, args: Record<string, unknown>): string | null {
  const real = toolLabel.split('/').pop() ?? toolLabel;
  if (real === 'run_bash' || real === 'terminal_send' || real === 'run_command') {
    const cmd = args['command'] ?? args['keys'] ?? args['input'];
    return typeof cmd === 'string' ? cmd : null;
  }
  return null;
}

/** Grant label for a command prefix (stored in approval_grants.tool_label). */
export const commandGrantLabel = (prefix: string) => `cmd:${prefix}`;

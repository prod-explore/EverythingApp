import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbPath } from './db.js';
import { parseCommandPolicy, type CommandPolicy } from './command-policy.js';

/**
 * Global policy file (policy.json) — the one place for "always allow / always block / known domains" and the
 * default browser policy. Like Antigravity's or Claude Code's settings file it is plain JSON on disk: edit it with
 * any editor, the server re-reads it on the next tool call (mtime-checked), nothing to restart and no UI to click
 * through. Per-project settings can only ADD to it for commands; they never override a deny.
 */
export interface BrowserPolicyFile {
  domainAllow: string[];
  domainDeny: string[];
  js: 'allowed' | 'review' | 'disabled';
}

export interface PolicyFile {
  commands: Pick<CommandPolicy, 'allow' | 'deny' | 'domains'> & { mode?: CommandPolicy['mode'] };
  browser: BrowserPolicyFile;
}

export const DEFAULT_POLICY_FILE: PolicyFile & { _help: string } = {
  _help:
    'commands.allow / commands.deny are command prefixes ("npm test", "git push --force"); commands.domains are hosts the sandbox may reach ' +
    'in auto mode (wildcards: "*.npmjs.org"); commands.mode is the default for projects (strict | allowlist | auto). ' +
    'browser.domainAllow empty = any public site. Destructive patterns are always blocked regardless of this file.',
  commands: { mode: 'strict', allow: [], deny: ['git push --force', 'git push -f'], domains: ['github.com', '*.githubusercontent.com', 'registry.npmjs.org', '*.npmjs.org', 'pypi.org', 'files.pythonhosted.org'] },
  browser: { domainAllow: [], domainDeny: [], js: 'allowed' },
};

export function policyFilePath(): string {
  return process.env['EVERYTHINGAPP_POLICY_FILE'] ?? join(dirname(dbPath()), 'policy.json');
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(s => s.trim()) : []);

/** Tolerant parser: junk in, safe defaults out. Never throws. */
export function parsePolicyFile(raw: unknown): PolicyFile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const c = parseCommandPolicy(o['commands']);
  const cmdRaw = (o['commands'] && typeof o['commands'] === 'object' ? o['commands'] : {}) as Record<string, unknown>;
  const b = (o['browser'] && typeof o['browser'] === 'object' ? o['browser'] : {}) as Record<string, unknown>;
  const js = b['js'] === 'review' || b['js'] === 'disabled' || b['js'] === 'allowed' ? b['js'] : 'allowed';
  return {
    commands: {
      allow: c.allow,
      deny: c.deny,
      domains: c.domains,
      ...(cmdRaw['mode'] === 'auto' || cmdRaw['mode'] === 'allowlist' || cmdRaw['mode'] === 'strict' ? { mode: cmdRaw['mode'] } : {}),
    },
    browser: { domainAllow: strings(b['domainAllow']), domainDeny: strings(b['domainDeny']), js },
  };
}

/** Loads and caches the policy file; re-reads when its mtime changes. Creates the default file on first use. */
export class PolicyStore {
  private cache: { mtimeMs: number; policy: PolicyFile } | null = null;
  /** Set when the file exists but is not valid JSON — shown in logs; the last good policy stays in force. */
  lastError: string | null = null;

  constructor(private readonly path: string | null = policyFilePath()) {}

  get(): PolicyFile {
    if (!this.path) return parsePolicyFile({});
    try {
      if (!existsSync(this.path)) {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(DEFAULT_POLICY_FILE, null, 2) + '\n', { flag: 'wx' });
      }
      const mtimeMs = statSync(this.path).mtimeMs;
      if (this.cache?.mtimeMs === mtimeMs) return this.cache.policy;
      const policy = parsePolicyFile(JSON.parse(readFileSync(this.path, 'utf8')));
      this.cache = { mtimeMs, policy };
      this.lastError = null;
      return policy;
    } catch (err) {
      this.lastError = (err as Error).message;
      if (this.cache) return this.cache.policy; // a typo while editing must not drop the deny list
      return parsePolicyFile(DEFAULT_POLICY_FILE);
    }
  }
}

/** Project policy + file policy → what the gate evaluates. Deny and domains accumulate; the file's mode is only a default. */
export function mergeCommandPolicy(file: PolicyFile['commands'], project: CommandPolicy, projectHasMode: boolean): CommandPolicy {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    mode: projectHasMode ? project.mode : (file.mode ?? project.mode),
    allow: uniq([...file.allow, ...project.allow]),
    deny: uniq([...file.deny, ...project.deny]),
    domains: uniq([...file.domains, ...project.domains]),
  };
}

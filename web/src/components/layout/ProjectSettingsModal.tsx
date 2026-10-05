import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { getProject, listApprovalGrants, revokeApprovalGrant, updateProject } from '../../api';
import { projectRepos } from '../../api-workspace';
import type { ProjectRepo, PushMode } from '../../types-workspace';
import type { ApprovalGrantRow, CommandMode, CommandPolicy } from '../../types';
import { Button } from '../shared/Button';
import { Modal } from '../shared/Modal';

const MODES: { id: CommandMode; label: string; hint: string }[] = [
  { id: 'strict', label: 'Strict', hint: 'Ask before every command (except prefixes you granted).' },
  { id: 'allowlist', label: 'Allowlist', hint: 'Read-only commands (ls, cat, git status…) and your prefixes run; everything else asks.' },
  { id: 'auto', label: 'Auto in sandbox', hint: 'Anything inside the sandbox runs; asks only at a boundary: push, a new domain, writes outside /workspace.' },
];

const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);

function parsePolicy(raw: unknown): CommandPolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<CommandPolicy>;
  return { mode: p.mode ?? 'strict', allow: p.allow ?? [], deny: p.deny ?? [], domains: p.domains ?? [] };
}

/** Project name/description, command policy (Plan v3 §5) and the project's persisted grants. */
export function ProjectSettingsModal({ projectId, onClose, onChanged }: { projectId: string; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<CommandMode>('strict');
  const [allow, setAllow] = useState('');
  const [deny, setDeny] = useState('');
  const [domains, setDomains] = useState('');
  const [grants, setGrants] = useState<ApprovalGrantRow[]>([]);
  const [repos, setRepos] = useState<ProjectRepo[]>([]);
  const [newRepo, setNewRepo] = useState('');
  const [repoError, setRepoError] = useState<string | null>(null);
  const [browserAllow, setBrowserAllow] = useState('');
  const [browserDeny, setBrowserDeny] = useState('');
  const [browserJs, setBrowserJs] = useState<'allowed' | 'review' | 'disabled'>('allowed');
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [project, { grants: g }, r] = await Promise.all([getProject(projectId), listApprovalGrants({ projectId }), projectRepos.list(projectId).catch(() => ({ repos: [] as ProjectRepo[] }))]);
        if (cancelled) return;
        const policy = parsePolicy(project.policy['commands']);
        setName(project.name);
        setDescription(project.description ?? '');
        setMode(policy.mode);
        setAllow(policy.allow.join('\n'));
        setDeny(policy.deny.join('\n'));
        setDomains(policy.domains.join('\n'));
        setGrants(g);
        setRepos(r.repos);
        const b = (project.policy['browser'] ?? {}) as { domainAllow?: string[]; domainDeny?: string[]; js?: 'allowed' | 'review' | 'disabled' };
        setBrowserAllow((b.domainAllow ?? []).join('\n'));
        setBrowserDeny((b.domainDeny ?? []).join('\n'));
        setBrowserJs(b.js ?? 'allowed');
        const gi = (project.policy['git'] ?? {}) as { name?: string; email?: string };
        setGitName(gi.name ?? '');
        setGitEmail(gi.email ?? '');
        setStatus('idle');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  async function save() {
    setStatus('saving');
    try {
      await updateProject(projectId, {
        name,
        description,
        policy: {
          commands: { mode, allow: lines(allow), deny: lines(deny), domains: lines(domains) },
          browser: { domainAllow: lines(browserAllow), domainDeny: lines(browserDeny), js: browserJs },
          git: { name: gitName.trim(), email: gitEmail.trim() },
        },
      });
      setStatus('saved');
      onChanged();
    } catch {
      setStatus('error');
    }
  }

  async function addRepo() {
    setRepoError(null);
    try {
      setRepos((await projectRepos.add(projectId, newRepo.trim())).repos);
      setNewRepo('');
    } catch (e) {
      setRepoError((e as Error).message);
    }
  }

  async function setPushMode(repoId: string, pushMode: PushMode) {
    setRepos((await projectRepos.update(projectId, repoId, { pushMode })).repos);
  }

  async function removeRepo(repoId: string) {
    await projectRepos.remove(projectId, repoId);
    setRepos(rs => rs.filter(r => r.id !== repoId));
  }

  async function revoke(id: string) {
    await revokeApprovalGrant(id);
    setGrants(gs => gs.filter(g => g.id !== id));
  }

  const field = 'w-full rounded-button border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-border-hover';
  const area = `${field} h-20 resize-y font-mono text-xs`;

  return (
    <Modal title="Project settings" onClose={onClose} wide>
      {status === 'loading' ? (
        <p className="text-sm text-fg-tertiary">Loading…</p>
      ) : (
        <div className="space-y-5">
          <section className="space-y-2">
            <input className={field} value={name} onChange={e => setName(e.target.value)} maxLength={80} aria-label="Project name" />
            <textarea className={`${field} h-16 resize-y`} value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" aria-label="Description" />
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-fg">Shell commands</h3>
            <div className="space-y-1.5" role="radiogroup" aria-label="Command mode">
              {MODES.map(m => (
                <label key={m.id} className={`flex cursor-pointer gap-2 rounded-button border px-3 py-2 text-sm ${mode === m.id ? 'border-accent bg-bg' : 'border-border'}`}>
                  <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} className="mt-0.5" />
                  <span>
                    <span className="font-medium text-fg">{m.label}</span>
                    <span className="block text-xs text-fg-tertiary">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-xs text-fg-secondary">
                Always allow (prefixes)
                <textarea className={area} value={allow} onChange={e => setAllow(e.target.value)} placeholder={'npm test\nmake build'} />
              </label>
              <label className="text-xs text-fg-secondary">
                Always block (prefixes)
                <textarea className={area} value={deny} onChange={e => setDeny(e.target.value)} placeholder={'docker\ngit push --force'} />
              </label>
              <label className="text-xs text-fg-secondary">
                Known domains (auto mode)
                <textarea className={area} value={domains} onChange={e => setDomains(e.target.value)} placeholder={'*.npmjs.org\ngithub.com'} />
              </label>
            </div>
            <p className="mt-1 text-xs text-fg-tertiary">
              Commands are split at <code>&amp;&amp;</code>, <code>|</code>, <code>;</code> and <code>$(…)</code>; every part must pass. Destructive patterns are always blocked.
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-fg">Repositories</h3>
            <p className="mb-2 text-xs text-fg-tertiary">
              Linked GitHub repositories: the sandbox's git reaches only these (through git-proxy), and the GitHub panel shows them. Push: <b>ask</b> shows an approval card, <b>allow</b> skips it (except force/delete and protected branches), <b>deny</b> blocks.
            </p>
            {repos.length > 0 && (
              <ul className="mb-2 divide-y divide-border rounded-button border border-border">
                {repos.map(r => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">{r.owner}/{r.repo}</span>
                    <label className="sr-only" htmlFor={`push-${r.id}`}>Push mode</label>
                    <select id={`push-${r.id}`} value={r.pushMode} onChange={e => void setPushMode(r.id, e.target.value as PushMode)} className="rounded border border-border bg-bg px-1 py-0.5 text-fg">
                      <option value="ask">push: ask</option>
                      <option value="allow">push: allow</option>
                      <option value="deny">push: deny</option>
                    </select>
                    <button onClick={() => void removeRepo(r.id)} className="rounded p-1 text-fg-tertiary hover:text-danger" aria-label={`Unlink ${r.owner}/${r.repo}`}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <input className={field} value={newRepo} onChange={e => setNewRepo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newRepo.trim()) void addRepo(); }} placeholder="owner/repo or https://github.com/owner/repo" aria-label="Repository to link" />
              <Button onClick={() => void addRepo()} disabled={!newRepo.trim()}>Link</Button>
            </div>
            {repoError && <p className="mt-1 text-xs text-danger">{repoError}</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-fg-secondary">
                Commit author name
                <input className={field} value={gitName} onChange={e => setGitName(e.target.value)} placeholder="EverythingApp" />
              </label>
              <label className="text-xs text-fg-secondary">
                Commit author email
                <input className={field} value={gitEmail} onChange={e => setGitEmail(e.target.value)} placeholder="you@example.com" />
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-fg">Browser</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs text-fg-secondary">
                Allowed domains (empty = any public site)
                <textarea className={area} value={browserAllow} onChange={e => setBrowserAllow(e.target.value)} placeholder={'example.com\n*.example.com'} />
              </label>
              <label className="text-xs text-fg-secondary">
                Blocked domains
                <textarea className={area} value={browserDeny} onChange={e => setBrowserDeny(e.target.value)} placeholder={'*.ads.example'} />
              </label>
              <label className="text-xs text-fg-secondary">
                JavaScript
                <select className={field} value={browserJs} onChange={e => setBrowserJs(e.target.value as typeof browserJs)}>
                  <option value="allowed">allowed</option>
                  <option value="review">allowed, flagged in results</option>
                  <option value="disabled">disabled</option>
                </select>
              </label>
            </div>
            <p className="mt-1 text-xs text-fg-tertiary">These can only tighten the server-wide browser policy. Logins and payments always happen in takeover mode, by you.</p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-fg">Project grants</h3>
            {grants.length === 0 ? (
              <p className="text-xs text-fg-tertiary">No grants yet. Choosing “Approve for this project” on an approval card adds one here.</p>
            ) : (
              <ul className="divide-y divide-border rounded-button border border-border">
                {grants.map(g => (
                  <li key={g.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">{g.toolLabel.replace(/^cmd:/, '$ ')}</span>
                    {g.subjectType && <span className="text-fg-tertiary">{g.subjectType}: {g.subjectId}</span>}
                    <button onClick={() => void revoke(g.id)} className="rounded p-1 text-fg-tertiary hover:text-danger" aria-label={`Revoke ${g.toolLabel}`}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex items-center justify-end gap-2">
            {status === 'saved' && <span className="text-xs text-fg-tertiary">Saved</span>}
            {status === 'error' && <span className="text-xs text-danger">Couldn't save. Try again.</span>}
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button onClick={() => void save()} disabled={status === 'saving' || !name.trim()}>Save</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

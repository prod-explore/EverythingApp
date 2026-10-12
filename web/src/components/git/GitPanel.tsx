import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { githubApi, githubConnect, scm, scmRepos } from '../../api-workspace';
import type { ScmRepo } from '../../types-workspace';
import { DockPanel, PanelMessage } from '../shared/DockPanel';
import { GitHubBody, type GitHubTab } from '../github/GitHubPanel';
import { ScmBody } from '../scm/SourceControlPanel';

type ScmTab = 'changes' | 'history' | 'branches';
type GitTab = ScmTab | GitHubTab;

const TABS: { id: GitTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
  { id: 'branches', label: 'Branches' },
  { id: 'pulls', label: 'PRs' },
  { id: 'issues', label: 'Issues' },
  { id: 'actions', label: 'Actions' },
];
const isScmTab = (t: GitTab): t is ScmTab => t === 'changes' || t === 'history' || t === 'branches';

/** One entry of the shared repository selector: a checkout in the sandbox and/or a GitHub repository. */
interface RepoEntry {
  key: string;
  /** Directory under /workspace when it is checked out in the sandbox; null = GitHub-only (not cloned). */
  dir: string | null;
  owner: string | null;
  repo: string | null;
}

function label(r: RepoEntry): string {
  if (r.owner && r.repo) return `${r.owner}/${r.repo}${r.dir === null ? ' (not cloned)' : ''}`;
  return r.dir ? `/workspace/${r.dir}` : '/workspace';
}

/**
 * Unified Git panel (Plan v3 §7.2 + §7.3): Source Control and GitHub in one dock panel. A single repository
 * selector (sandbox checkouts first, then the connected account's recent repos) drives all six tabs:
 * Changes | History | Branches (git in the sandbox) and PRs | Issues | Actions (GitHub REST via the server).
 */
export function GitPanel({ projectId, onClose, onConnect }: { projectId: string; onClose: () => void; onConnect: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [local, setLocal] = useState<ScmRepo[] | null>(null);
  const [remote, setRemote] = useState<Array<{ owner: string; repo: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<GitTab>('changes');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    githubConnect.status().then(s => setConnected(s.connected)).catch(() => setConnected(true)); // unknown → let tabs show their own errors
  }, []);

  const loadLocal = useCallback(async (preferDir?: string) => {
    try {
      const r = await scmRepos.list(projectId);
      setLocal(r.repos);
      if (preferDir !== undefined) setSelected(`dir:${preferDir}`);
    } catch {
      setLocal(l => l ?? []); // sandbox may be asleep; the tabs report their own errors
    }
  }, [projectId]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);

  useEffect(() => {
    let cancelled = false;
    githubApi<Array<{ name: string; owner: { login: string } }>>(projectId, '/user/repos?sort=pushed&per_page=50')
      .then(list => { if (!cancelled) setRemote(list.map(r => ({ owner: r.owner.login, repo: r.name }))); })
      .catch(() => { /* not connected / offline: only sandbox repos are listed */ });
    return () => { cancelled = true; };
  }, [projectId, connected]);

  const entries = useMemo<RepoEntry[]>(() => {
    const out: RepoEntry[] = [];
    const seen = new Set<string>();
    const add = (r: ScmRepo) => {
      out.push({ key: `dir:${r.dir}`, dir: r.dir, owner: r.owner, repo: r.repo });
      if (r.owner && r.repo) seen.add(`${r.owner}/${r.repo}`.toLowerCase());
    };
    for (const r of local ?? []) if (r.dir !== '') add(r);
    add((local ?? []).find(r => r.dir === '') ?? { dir: '', origin: null, owner: null, repo: null }); // /workspace itself, last
    for (const r of remote) {
      const id = `${r.owner}/${r.repo}`.toLowerCase();
      if (!seen.has(id)) { seen.add(id); out.push({ key: `gh:${id}`, dir: null, owner: r.owner, repo: r.repo }); }
    }
    return out;
  }, [local, remote]);

  // Default selection: the first sandbox checkout that is an actual repository, else whatever is first.
  const current = useMemo(() => {
    const explicit = entries.find(e => e.key === selected);
    if (explicit) return explicit;
    return entries.find(e => e.dir) ?? entries[0] ?? null;
  }, [entries, selected]);

  const hasGithub = !!(current?.owner && current.repo);
  const disabled = (t: GitTab): boolean => (isScmTab(t) ? current?.dir === null : !hasGithub);

  // Keep the active tab valid for the selected repository.
  useEffect(() => {
    if (!current) return;
    if (disabled(tab)) setTab(current.dir === null ? 'pulls' : 'changes');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key]);

  const loading = local === null;

  return (
    <DockPanel
      title="Git"
      icon={<GitBranch size={16} />}
      onClose={onClose}
      actions={
        <button onClick={() => { setRefreshKey(k => k + 1); void loadLocal(); }} className="rounded p-1 text-fg-tertiary hover:text-fg" aria-label="Refresh"><RefreshCw size={14} /></button>
      }
    >
      <div className="space-y-1.5 border-b border-border px-3 py-1.5 text-xs">
        <label className="sr-only" htmlFor="git-repo">Repository</label>
        <select
          id="git-repo"
          value={current?.key ?? ''}
          onChange={e => setSelected(e.target.value)}
          className="w-full min-w-0 rounded border border-border bg-bg px-1 py-0.5 text-fg"
        >
          {entries.map(r => <option key={r.key} value={r.key}>{label(r)}</option>)}
        </select>
        <div className="flex flex-wrap rounded-button border border-border" role="tablist" aria-label="Git views">
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              disabled={disabled(t.id)}
              title={disabled(t.id) ? (isScmTab(t.id) ? 'Clone this repository into the sandbox first' : 'This folder has no GitHub remote') : undefined}
              onClick={() => setTab(t.id)}
              className={`flex-1 px-2 py-0.5 ${tab === t.id ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary'} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <PanelMessage>Loading…</PanelMessage>
      ) : !current ? (
        <PanelMessage>No repositories found. Clone one by URL, or log in to GitHub in Settings.</PanelMessage>
      ) : isScmTab(tab) ? (
        current.dir === null ? (
          <CloneRepo
            key={current.key}
            projectId={projectId}
            url={`github.com/${current.owner}/${current.repo}`}
            onCloned={name => { setTab('changes'); return loadLocal(name); }}
          />
        ) : (
          <ScmBody
            key={`${current.key}:${tab}`}
            projectId={projectId}
            dir={current.dir}
            tab={tab}
            refreshKey={refreshKey}
            onCloned={name => loadLocal(name)}
          />
        )
      ) : connected === false ? (
        <div className="space-y-3 p-4 text-center">
          <PanelMessage>GitHub is not connected yet.</PanelMessage>
          <button onClick={onConnect} className="rounded-button bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90">Connect GitHub</button>
        </div>
      ) : hasGithub ? (
        <GitHubBody key={`${current.key}:${tab}:${refreshKey}`} projectId={projectId} repo={{ owner: current.owner!, repo: current.repo! }} tab={tab as GitHubTab} />
      ) : (
        <PanelMessage>This folder has no GitHub remote.</PanelMessage>
      )}
    </DockPanel>
  );
}

/** Shown for a GitHub-only repository: clones it into the sandbox so the git tabs work. */
function CloneRepo({ projectId, url, onCloned }: { projectId: string; url: string; onCloned: (dirName: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function clone() {
    setBusy(true);
    setError(null);
    try {
      await scm.sync(projectId, '', 'clone', url);
      await onCloned(url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 p-4 text-center">
      <PanelMessage>This repository is not cloned in the sandbox yet. PRs, Issues and Actions work without it.</PanelMessage>
      <button onClick={() => void clone()} disabled={busy} className="rounded-button bg-fg px-4 py-1.5 text-xs font-medium text-bg disabled:opacity-50">
        {busy ? 'Cloning…' : 'Clone into sandbox'}
      </button>
      {error && <PanelMessage tone="error">{error}</PanelMessage>}
    </div>
  );
}

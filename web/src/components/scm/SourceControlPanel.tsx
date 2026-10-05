import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { fetchWorkspaceFile, projectRepos, scm } from '../../api-workspace';
import type { ProjectRepo, ScmBranch, ScmCommit, ScmFile, ScmStatus } from '../../types-workspace';
import { DockPanel, PanelMessage } from '../shared/DockPanel';

/**
 * Source Control (Plan v3 §7.3), like VS Code's: git runs inside the project sandbox; clicks here are
 * the human's own actions (no approval), network operations go through git-proxy.
 */
export function SourceControlPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [repos, setRepos] = useState<ProjectRepo[]>([]);
  const [dir, setDir] = useState<string>('');
  const [tab, setTab] = useState<'changes' | 'history' | 'branches'>('changes');
  const [status, setStatus] = useState<ScmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<{ file: ScmFile; staged: boolean } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    void projectRepos.list(projectId).then(r => {
      setRepos(r.repos);
      setDir(d => d || r.repos[0]?.repo || '');
    }).catch(() => {});
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await scm.status(projectId, dir));
      setError(null);
    } catch (e) {
      setStatus(null);
      setError((e as Error).message);
    }
  }, [projectId, dir]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      const out = (r as { output?: string } | undefined)?.output;
      if (out) setOutput(out.trim());
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const staged = useMemo(() => status?.files.filter(f => !f.conflicted && f.index !== ' ' && f.index !== '?') ?? [], [status]);
  const changed = useMemo(() => status?.files.filter(f => !f.conflicted && (f.worktree !== ' ' || f.index === '?')) ?? [], [status]);
  const conflicts = useMemo(() => status?.files.filter(f => f.conflicted) ?? [], [status]);
  const notRepo = error?.includes('not a git repository');
  const repoForDir = repos.find(r => r.repo === dir);

  return (
    <DockPanel
      title="Source Control"
      icon={<GitBranch size={16} />}
      onClose={onClose}
      actions={
        <button onClick={() => void refresh()} className="rounded p-1 text-fg-tertiary hover:text-fg" aria-label="Refresh"><RefreshCw size={14} /></button>
      }
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <label className="sr-only" htmlFor="scm-dir">Repository</label>
        <select id="scm-dir" value={dir} onChange={e => { setDir(e.target.value); setDiffFile(null); }} className="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5 text-fg">
          {repos.map(r => <option key={r.id} value={r.repo}>/workspace/{r.repo} ({r.owner}/{r.repo})</option>)}
          <option value="">/workspace</option>
        </select>
        <div className="flex rounded-button border border-border" role="tablist">
          {(['changes', 'history', 'branches'] as const).map(t => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-2 py-0.5 capitalize ${tab === t ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary'}`}>{t}</button>
          ))}
        </div>
      </div>

      {notRepo ? (
        <div className="space-y-2 p-3 text-xs">
          <PanelMessage>/workspace/{dir} is not a git repository yet.</PanelMessage>
          {repoForDir && (
            <button onClick={() => void act('clone', () => scm.sync(projectId, '', 'clone', repoForDir.id))} disabled={!!busy} className="w-full rounded-button bg-fg px-3 py-1.5 text-bg font-medium disabled:opacity-50">
              {busy === 'clone' ? 'Cloning…' : `Clone ${repoForDir.owner}/${repoForDir.repo}`}
            </button>
          )}
          {repos.length === 0 && <PanelMessage>Link a GitHub repository in Project settings to clone it here.</PanelMessage>}
        </div>
      ) : (
        <>
          {status && (
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs">
              <GitBranch size={13} className="text-fg-tertiary" />
              <span className="font-medium text-fg">{status.branch ?? '(detached)'}</span>
              {status.upstream && <span className="text-fg-tertiary">→ {status.upstream}</span>}
              {(status.ahead > 0 || status.behind > 0) && <span className="text-fg-tertiary">↑{status.ahead} ↓{status.behind}</span>}
              <span className="flex-1" />
              <SyncButton label="Fetch" busy={busy} onClick={() => act('Fetch', () => scm.sync(projectId, dir, 'fetch'))} icon={<RefreshCw size={12} />} />
              <SyncButton label="Pull" busy={busy} onClick={() => act('Pull', () => scm.sync(projectId, dir, 'pull'))} icon={<ArrowDown size={12} />} />
              <SyncButton label="Push" busy={busy} onClick={() => act('Push', () => scm.sync(projectId, dir, 'push'))} icon={<ArrowUp size={12} />} />
            </div>
          )}
          {error && <PanelMessage tone="error">{error}</PanelMessage>}
          {output && (
            <div className="relative border-b border-border">
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] text-fg-secondary">{output}</pre>
              <button onClick={() => setOutput(null)} className="absolute right-2 top-1 text-[10px] text-fg-tertiary underline">clear</button>
            </div>
          )}

          {tab === 'changes' && (conflict ? (
            <ConflictEditor projectId={projectId} dir={dir} path={conflict} onDone={() => { setConflict(null); void refresh(); }} />
          ) : diffFile ? (
            <DiffView projectId={projectId} dir={dir} file={diffFile.file} staged={diffFile.staged} onBack={() => setDiffFile(null)} onChanged={refresh} />
          ) : (
            <div>
              <CommitBox busy={busy} hasStaged={staged.length > 0} onCommit={(m, amend) => act('Commit', () => scm.commit(projectId, dir, m, amend))} />
              {conflicts.length > 0 && (
                <FileGroup title="Merge conflicts" files={conflicts} onOpen={f => setConflict(f.path)} actions={() => null} />
              )}
              <FileGroup
                title="Staged changes"
                files={staged}
                letter={f => f.index}
                onOpen={f => setDiffFile({ file: f, staged: true })}
                groupAction={staged.length ? { label: 'Unstage all', icon: <Minus size={12} />, run: () => act('unstage', () => scm.unstage(projectId, dir, staged.map(f => f.path))) } : undefined}
                actions={f => <IconBtn label={`Unstage ${f.path}`} onClick={() => act('unstage', () => scm.unstage(projectId, dir, [f.path]))}><Minus size={12} /></IconBtn>}
              />
              <FileGroup
                title="Changes"
                files={changed}
                letter={f => (f.index === '?' ? 'U' : f.worktree)}
                onOpen={f => setDiffFile({ file: f, staged: false })}
                groupAction={changed.length ? { label: 'Stage all', icon: <Plus size={12} />, run: () => act('stage', () => scm.stage(projectId, dir, changed.map(f => f.path))) } : undefined}
                actions={f => (
                  <>
                    <IconBtn label={`Discard changes in ${f.path}`} onClick={() => { if (confirm(`Discard changes in ${f.path}?`)) void act('discard', () => scm.discard(projectId, dir, [f.path])); }}><Undo2 size={12} /></IconBtn>
                    <IconBtn label={`Stage ${f.path}`} onClick={() => act('stage', () => scm.stage(projectId, dir, [f.path]))}><Plus size={12} /></IconBtn>
                  </>
                )}
              />
              {status && status.files.length === 0 && <PanelMessage>No changes.</PanelMessage>}
              <StashBar busy={busy} onAction={(a, msg) => act(`stash ${a}`, () => scm.stash(projectId, dir, a, a === 'pop' ? 0 : undefined, msg))} />
            </div>
          ))}
          {tab === 'history' && <HistoryView projectId={projectId} dir={dir} />}
          {tab === 'branches' && <BranchesView projectId={projectId} dir={dir} onChanged={refresh} onOutput={setOutput} />}
        </>
      )}
    </DockPanel>
  );
}

function SyncButton({ label, busy, onClick, icon }: { label: string; busy: string | null; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={!!busy} title={label} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-secondary hover:bg-bg-secondary disabled:opacity-50">
      {icon}<span>{busy === label ? '…' : label}</span>
    </button>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={e => { e.stopPropagation(); onClick(); }} aria-label={label} title={label} className="rounded p-0.5 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg">{children}</button>;
}

function CommitBox({ busy, hasStaged, onCommit }: { busy: string | null; hasStaged: boolean; onCommit: (message: string, amend: boolean) => Promise<void> }) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const submit = async () => { if (!message.trim()) return; await onCommit(message, amend); setMessage(''); setAmend(false); };
  return (
    <div className="space-y-1.5 border-b border-border p-3">
      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(); }}
        placeholder="Commit message (Ctrl+Enter)"
        aria-label="Commit message"
        className="h-16 w-full resize-y rounded-button border border-border bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-border-hover"
      />
      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1 text-fg-secondary"><input type="checkbox" checked={amend} onChange={e => setAmend(e.target.checked)} /> Amend</label>
        <span className="flex-1" />
        <button onClick={() => void submit()} disabled={!!busy || !message.trim() || (!hasStaged && !amend)} className="flex items-center gap-1 rounded-button bg-fg px-3 py-1 text-bg font-medium disabled:opacity-50">
          <GitCommitHorizontal size={13} /> {busy === 'Commit' ? 'Committing…' : 'Commit'}
        </button>
      </div>
    </div>
  );
}

function FileGroup({ title, files, letter, onOpen, actions, groupAction }: {
  title: string;
  files: ScmFile[];
  letter?: (f: ScmFile) => string;
  onOpen: (f: ScmFile) => void;
  actions: (f: ScmFile) => React.ReactNode;
  groupAction?: { label: string; icon: React.ReactNode; run: () => void };
}) {
  if (files.length === 0) return null;
  return (
    <div className="border-b border-border py-1">
      <div className="flex items-center px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-tertiary">
        <span className="flex-1">{title} ({files.length})</span>
        {groupAction && <IconBtn label={groupAction.label} onClick={groupAction.run}>{groupAction.icon}</IconBtn>}
      </div>
      <ul>
        {files.map(f => (
          <li key={f.path} className="group flex cursor-pointer items-center gap-2 px-3 py-0.5 text-xs hover:bg-bg-secondary" onClick={() => onOpen(f)}>
            <span className="min-w-0 flex-1 truncate text-fg" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
              {f.path.split('/').pop()} <span className="text-fg-tertiary">{f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : ''}</span>
            </span>
            <span className="hidden gap-0.5 group-hover:flex">{actions(f)}</span>
            {letter && <span className="w-3 shrink-0 text-center font-mono text-fg-secondary">{letter(f)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Splits a single-file unified diff into its header and hunks (for hunk staging). */
function splitDiff(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split('\n');
  const first = lines.findIndex(l => l.startsWith('@@'));
  if (first === -1) return { header: diff, hunks: [] };
  const header = lines.slice(0, first).join('\n');
  const hunks: string[] = [];
  let cur: string[] = [];
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@') && cur.length) { hunks.push(cur.join('\n')); cur = []; }
    if (l.startsWith('diff --git') && cur.length) break; // a second file (shouldn't happen for one path)
    cur.push(l);
  }
  if (cur.length) hunks.push(cur.join('\n').replace(/\n+$/, ''));
  return { header, hunks };
}

function DiffView({ projectId, dir, file, staged, onBack, onChanged }: { projectId: string; dir: string; file: ScmFile; staged: boolean; onBack: () => void; onChanged: () => Promise<void> }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [blame, setBlame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (file.index === '?' && !staged) {
        // Untracked: show the file itself (whole file is the change).
        const f = await fetchWorkspaceFile(projectId, `/workspace/${dir ? dir + '/' : ''}${file.path}`);
        URL.revokeObjectURL(f.url);
        setDiff(f.text !== undefined ? f.text.split('\n').map(l => '+' + l).join('\n') : '(binary file)');
      } else {
        setDiff((await scm.diff(projectId, dir, file.path, staged)).diff);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, dir, file, staged]);
  useEffect(() => { void load(); }, [load]);

  const { header, hunks } = useMemo(() => (diff ? splitDiff(diff) : { header: '', hunks: [] }), [diff]);
  const hunkPatchable = file.index !== '?' || staged;

  async function applyHunk(h: string) {
    try {
      await scm.apply(projectId, dir, `${header}\n${h}\n`, staged);
      await onChanged();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadBlame() {
    try {
      const raw = (await scm.blame(projectId, dir, file.path)).blame;
      // --line-porcelain → "sha author: line"
      const out: string[] = [];
      let sha = '', author = '';
      for (const l of raw.split('\n')) {
        if (/^[0-9a-f]{40} /.test(l)) sha = l.slice(0, 8);
        else if (l.startsWith('author ')) author = l.slice(7);
        else if (l.startsWith('\t')) out.push(`${sha} ${author.padEnd(14).slice(0, 14)} │ ${l.slice(1)}`);
      }
      setBlame(out.join('\n'));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <button onClick={onBack} className="rounded p-0.5 text-fg-tertiary hover:text-fg" aria-label="Back to changes"><ArrowLeft size={14} /></button>
        <span className="min-w-0 flex-1 truncate font-mono text-fg">{file.path}</span>
        <span className="text-fg-tertiary">{staged ? 'staged' : 'working tree'}</span>
        {file.index !== '?' && <button onClick={() => (blame === null ? void loadBlame() : setBlame(null))} className="text-fg-tertiary underline hover:text-fg">{blame === null ? 'Blame' : 'Diff'}</button>}
      </div>
      {error && <PanelMessage tone="error">{error}</PanelMessage>}
      <div className="min-h-0 flex-1 overflow-auto">
        {blame !== null ? (
          <pre className="p-2 font-mono text-[11px] text-fg-secondary">{blame}</pre>
        ) : diff === null ? (
          <PanelMessage>Loading…</PanelMessage>
        ) : hunks.length === 0 ? (
          <pre className="p-2 font-mono text-[11px]">{diff.split('\n').map((l, i) => <DiffLine key={i} line={l} />)}</pre>
        ) : (
          hunks.map((h, i) => (
            <div key={i} className="border-b border-border">
              {hunkPatchable && (
                <div className="flex justify-end px-2 pt-1">
                  <button onClick={() => void applyHunk(h)} className="rounded px-1.5 py-0.5 text-[11px] text-fg-tertiary hover:bg-bg-secondary hover:text-fg">
                    {staged ? 'Unstage hunk' : 'Stage hunk'}
                  </button>
                </div>
              )}
              <pre className="px-2 pb-2 font-mono text-[11px]">{h.split('\n').map((l, j) => <DiffLine key={j} line={l} />)}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const cls = line.startsWith('+') ? 'bg-success/10 text-success' : line.startsWith('-') ? 'bg-danger/10 text-danger' : line.startsWith('@@') ? 'text-accent' : 'text-fg-secondary';
  return <div className={`whitespace-pre-wrap break-all ${cls}`}>{line || ' '}</div>;
}

function ConflictEditor({ projectId, dir, path, onDone }: { projectId: string; dir: string; path: string; onDone: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetchWorkspaceFile(projectId, `/workspace/${dir ? dir + '/' : ''}${path}`)
      .then(f => { URL.revokeObjectURL(f.url); setText(f.text ?? ''); })
      .catch(e => setError((e as Error).message));
  }, [projectId, dir, path]);

  // Resolve one conflict block by keeping ours / theirs / both.
  function take(which: 'ours' | 'theirs' | 'both') {
    setText(t => t && t.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/, (_m, ours: string, theirs: string) => (which === 'ours' ? ours : which === 'theirs' ? theirs : ours + theirs)));
  }
  const remaining = text ? (text.match(/^<<<<<<< /gm) ?? []).length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <button onClick={onDone} className="rounded p-0.5 text-fg-tertiary hover:text-fg" aria-label="Back"><ArrowLeft size={14} /></button>
        <span className="min-w-0 flex-1 truncate font-mono text-fg">{path}</span>
        <span className="text-fg-tertiary">{remaining} conflict{remaining === 1 ? '' : 's'}</span>
        {remaining > 0 && (['ours', 'theirs', 'both'] as const).map(w => (
          <button key={w} onClick={() => take(w)} className="rounded px-1.5 py-0.5 text-fg-secondary hover:bg-bg-secondary">Take {w}</button>
        ))}
        <button
          disabled={text === null || remaining > 0}
          onClick={() => void scm.resolve(projectId, dir, path, text ?? '').then(onDone).catch(e => setError((e as Error).message))}
          className="rounded-button bg-fg px-2 py-0.5 text-bg font-medium disabled:opacity-50"
        >
          Mark resolved
        </button>
      </div>
      {error && <PanelMessage tone="error">{error}</PanelMessage>}
      {text !== null && (
        <textarea value={text} onChange={e => setText(e.target.value)} aria-label="File content" className="min-h-0 flex-1 resize-none bg-bg p-2 font-mono text-[11px] text-fg outline-none" spellCheck={false} />
      )}
    </div>
  );
}

function StashBar({ busy, onAction }: { busy: string | null; onAction: (a: 'push' | 'pop' | 'list', message?: string) => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-fg-tertiary">
      <span>Stash:</span>
      <button disabled={!!busy} onClick={() => onAction('push', prompt('Stash message (optional)') ?? undefined)} className="underline hover:text-fg disabled:opacity-50">save</button>
      <button disabled={!!busy} onClick={() => onAction('pop')} className="underline hover:text-fg disabled:opacity-50">pop</button>
      <button disabled={!!busy} onClick={() => onAction('list')} className="underline hover:text-fg disabled:opacity-50">list</button>
    </div>
  );
}

/** Commit list with a small lane graph (computed client-side from parent links). */
function HistoryView({ projectId, dir }: { projectId: string; dir: string }) {
  const [commits, setCommits] = useState<ScmCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ sha: string; text: string } | null>(null);
  useEffect(() => {
    void scm.log(projectId, dir).then(r => setCommits(r.commits)).catch(e => setError((e as Error).message));
  }, [projectId, dir]);

  const rows = useMemo(() => {
    if (!commits) return [];
    let lanes: (string | null)[] = [];
    return commits.map(c => {
      let lane = lanes.indexOf(c.sha);
      if (lane === -1) { lane = lanes.indexOf(null); if (lane === -1) lane = lanes.length; }
      lanes[lane] = c.parents[0] ?? null;
      for (const p of c.parents.slice(1)) if (!lanes.includes(p)) { const free = lanes.indexOf(null); if (free === -1) lanes.push(p); else lanes[free] = p; }
      // Collapse duplicate lanes waiting for the same parent.
      lanes = lanes.map((l, i) => (l && lanes.indexOf(l) !== i ? null : l));
      return { c, lane, width: lanes.length };
    });
  }, [commits]);

  if (error) return <PanelMessage tone="error">{error}</PanelMessage>;
  if (!commits) return <PanelMessage>Loading…</PanelMessage>;
  if (shown) {
    return (
      <div>
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
          <button onClick={() => setShown(null)} className="rounded p-0.5 text-fg-tertiary hover:text-fg" aria-label="Back to history"><ArrowLeft size={14} /></button>
          <span className="font-mono text-fg">{shown.sha.slice(0, 10)}</span>
        </div>
        <pre className="p-2 font-mono text-[11px]">{shown.text.split('\n').map((l, i) => <DiffLine key={i} line={l} />)}</pre>
      </div>
    );
  }
  const maxWidth = Math.min(Math.max(...rows.map(r => r.width), 1), 8);
  return (
    <ul className="py-1">
      {rows.map(({ c, lane }) => (
        <li key={c.sha}>
          <button onClick={() => void scm.show(projectId, dir, c.sha).then(r => setShown({ sha: c.sha, text: r.output }))} className="flex w-full items-center gap-2 px-3 py-0.5 text-left text-xs hover:bg-bg-secondary">
            <svg width={maxWidth * 10} height={16} className="shrink-0" aria-hidden>
              <circle cx={Math.min(lane, maxWidth - 1) * 10 + 5} cy={8} r={3.5} className={c.parents.length > 1 ? 'fill-accent' : 'fill-fg-secondary'} />
            </svg>
            <span className="min-w-0 flex-1 truncate text-fg">
              {c.refs.filter(Boolean).map(r => <span key={r} className="mr-1 rounded bg-accent/15 px-1 text-[10px] text-accent">{r.replace('HEAD -> ', '')}</span>)}
              {c.subject}
            </span>
            <span className="shrink-0 text-fg-tertiary">{c.author.split(' ')[0]}</span>
            <span className="shrink-0 font-mono text-fg-tertiary">{c.sha.slice(0, 7)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function BranchesView({ projectId, dir, onChanged, onOutput }: { projectId: string; dir: string; onChanged: () => Promise<void>; onOutput: (s: string) => void }) {
  const [branches, setBranches] = useState<ScmBranch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(() => scm.branches(projectId, dir).then(r => setBranches(r.branches)).catch(e => setError((e as Error).message)), [projectId, dir]);
  useEffect(() => { void load(); }, [load]);

  async function checkout(branch: string, create: boolean) {
    try {
      const r = await scm.checkout(projectId, dir, branch.replace(/^remotes\/origin\//, '').replace(/^origin\//, ''), create);
      if (r.output) onOutput(r.output);
      setName('');
      await load();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="flex gap-2 border-b border-border p-3">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="new-branch-name" aria-label="New branch name" className="min-w-0 flex-1 rounded-button border border-border bg-bg px-2 py-1 text-xs text-fg outline-none" />
        <button disabled={!/^[\w./-]+$/.test(name)} onClick={() => void checkout(name, true)} className="rounded-button bg-fg px-2 py-1 text-xs text-bg font-medium disabled:opacity-50">Create</button>
      </div>
      {error && <PanelMessage tone="error">{error}</PanelMessage>}
      <ul className="py-1">
        {branches?.map(b => (
          <li key={b.name}>
            <button onClick={() => !b.current && void checkout(b.name, false)} className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-bg-secondary ${b.current ? 'font-medium text-fg' : 'text-fg-secondary'}`}>
              <GitBranch size={12} className="shrink-0 text-fg-tertiary" />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {b.track && <span className="text-fg-tertiary">{b.track}</span>}
              <span className="font-mono text-fg-tertiary">{b.sha}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

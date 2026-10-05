import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CircleCheck, CircleDot, CircleX, Clock, ExternalLink, GitPullRequest, GitMerge as Github, Play } from 'lucide-react';
import { githubApi, githubConnect, githubText, projectRepos } from '../../api-workspace';
import type { ProjectRepo } from '../../types-workspace';
import { MarkdownBody as MarkdownText } from '../chat/MarkdownText';
import { DockPanel, PanelMessage } from '../shared/DockPanel';

/* Minimal shapes of the GitHub REST responses we render. */
interface GhUser { login: string }
interface GhIssue { number: number; title: string; state: string; user: GhUser; body: string | null; comments: number; html_url: string; pull_request?: unknown; created_at: string; labels: Array<{ name: string }> }
interface GhPull extends GhIssue { head: { ref: string; sha: string }; base: { ref: string }; draft: boolean; mergeable?: boolean | null; merged?: boolean }
interface GhComment { id: number; user: GhUser; body: string; created_at: string; path?: string; line?: number }
interface GhFile { filename: string; status: string; additions: number; deletions: number; patch?: string }
interface GhCheckRun { id: number; name: string; status: string; conclusion: string | null; html_url: string }
interface GhRun { id: number; name: string; display_title: string; status: string; conclusion: string | null; head_branch: string; event: string; created_at: string; html_url: string }
interface GhJob { id: number; name: string; status: string; conclusion: string | null }

type View =
  | { kind: 'list' }
  | { kind: 'pull'; number: number }
  | { kind: 'issue'; number: number }
  | { kind: 'run'; id: number };

function StateIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== 'completed') return <Clock size={13} className="shrink-0 text-accent" />;
  if (conclusion === 'success') return <CircleCheck size={13} className="shrink-0 text-success" />;
  if (conclusion === 'skipped' || conclusion === 'neutral') return <CircleDot size={13} className="shrink-0 text-fg-tertiary" />;
  return <CircleX size={13} className="shrink-0 text-danger" />;
}

/** GitHub panel (Plan v3 §7.2): PRs, issues, checks and Actions for the project's linked repos, through the server. */
export function GitHubPanel({ projectId, onClose, onConnect }: { projectId: string; onClose: () => void; onConnect: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    githubConnect.status().then(s => setConnected(s.connected)).catch(() => setConnected(true)); // unknown → let the panel show its own errors
  }, []);
  const [repos, setRepos] = useState<ProjectRepo[] | null>(null);
  const [repo, setRepo] = useState<ProjectRepo | null>(null);
  const [tab, setTab] = useState<'pulls' | 'issues' | 'actions'>('pulls');
  const [view, setView] = useState<View>({ kind: 'list' });

  useEffect(() => {
    void projectRepos.list(projectId).then(r => { setRepos(r.repos); setRepo(r.repos[0] ?? null); }).catch(() => setRepos([]));
  }, [projectId]);

  const base = repo ? `/repos/${repo.owner}/${repo.repo}` : '';

  return (
    <DockPanel title="GitHub" icon={<Github size={16} />} onClose={onClose}>
      {connected === false ? (
        <div className="space-y-3 p-4 text-center">
          <PanelMessage>GitHub is not connected yet.</PanelMessage>
          <button onClick={onConnect} className="rounded-button bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90">Connect GitHub</button>
        </div>
      ) : (<>
      {repos && repos.length === 0 && <PanelMessage>No repositories linked. Add one in Project settings → Repositories.</PanelMessage>}
      {repo && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
            <select
              aria-label="Repository"
              value={repo.id}
              onChange={e => { setRepo(repos!.find(r => r.id === e.target.value) ?? null); setView({ kind: 'list' }); }}
              className="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5 text-fg"
            >
              {repos!.map(r => <option key={r.id} value={r.id}>{r.owner}/{r.repo}</option>)}
            </select>
            <div className="flex rounded-button border border-border" role="tablist">
              {(['pulls', 'issues', 'actions'] as const).map(t => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setView({ kind: 'list' }); }} className={`px-2 py-0.5 ${tab === t ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary'}`}>
                  {t === 'pulls' ? 'PRs' : t === 'issues' ? 'Issues' : 'Actions'}
                </button>
              ))}
            </div>
          </div>
          {view.kind === 'list' && tab === 'pulls' && <IssueList projectId={projectId} path={`${base}/pulls?state=open&per_page=50`} onOpen={n => setView({ kind: 'pull', number: n })} />}
          {view.kind === 'list' && tab === 'issues' && <IssueList projectId={projectId} path={`${base}/issues?state=open&per_page=50`} filterPulls onOpen={n => setView({ kind: 'issue', number: n })} />}
          {view.kind === 'list' && tab === 'actions' && <RunList projectId={projectId} base={base} onOpen={id => setView({ kind: 'run', id })} />}
          {view.kind === 'pull' && <PullDetail projectId={projectId} base={base} number={view.number} onBack={() => setView({ kind: 'list' })} />}
          {view.kind === 'issue' && <IssueDetail projectId={projectId} base={base} number={view.number} onBack={() => setView({ kind: 'list' })} />}
          {view.kind === 'run' && <RunDetail projectId={projectId} base={base} id={view.id} onBack={() => setView({ kind: 'list' })} />}
        </>
      )}
      </>)}
    </DockPanel>
  );
}

function useGh<T>(projectId: string, path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await githubApi<T>(projectId, path)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [projectId, path]);
  useEffect(() => { setData(null); void reload(); }, [reload]);
  return { data, error, reload };
}

function Back({ onBack, title, href }: { onBack: () => void; title: string; href?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <button onClick={onBack} className="rounded p-0.5 text-fg-tertiary hover:text-fg" aria-label="Back"><ArrowLeft size={14} /></button>
      <span className="min-w-0 flex-1 truncate font-medium text-fg">{title}</span>
      {href && <a href={href} target="_blank" rel="noreferrer noopener" className="text-fg-tertiary hover:text-fg" aria-label="Open on GitHub"><ExternalLink size={13} /></a>}
    </div>
  );
}

function IssueList({ projectId, path, filterPulls, onOpen }: { projectId: string; path: string; filterPulls?: boolean; onOpen: (n: number) => void }) {
  const { data, error } = useGh<GhIssue[]>(projectId, path);
  if (error) return <PanelMessage tone="error">{error}</PanelMessage>;
  if (!data) return <PanelMessage>Loading…</PanelMessage>;
  const items = filterPulls ? data.filter(i => !i.pull_request) : data;
  if (items.length === 0) return <PanelMessage>Nothing open.</PanelMessage>;
  return (
    <ul className="divide-y divide-border">
      {items.map(i => (
        <li key={i.number}>
          <button onClick={() => onOpen(i.number)} className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-secondary">
            <div className="flex items-center gap-1.5">
              {filterPulls ? <CircleDot size={13} className="shrink-0 text-success" /> : <GitPullRequest size={13} className="shrink-0 text-success" />}
              <span className="min-w-0 flex-1 truncate text-fg">{i.title}</span>
              <span className="text-fg-tertiary">#{i.number}</span>
            </div>
            <div className="ml-5 text-fg-tertiary">
              {i.user.login} · {new Date(i.created_at).toLocaleDateString()}{i.comments ? ` · ${i.comments} comments` : ''}
              {i.labels.map(l => <span key={l.name} className="ml-1 rounded bg-bg-tertiary px-1">{l.name}</span>)}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CommentBox({ onSubmit, placeholder = 'Leave a comment' }: { onSubmit: (body: string) => Promise<void>; placeholder?: string }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-1.5 p-3">
      <textarea value={body} onChange={e => setBody(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="h-16 w-full resize-y rounded-button border border-border bg-bg px-2 py-1.5 text-xs text-fg outline-none" />
      <div className="flex justify-end">
        <button disabled={!body.trim() || busy} onClick={async () => { setBusy(true); try { await onSubmit(body); setBody(''); } finally { setBusy(false); } }} className="rounded-button bg-fg px-3 py-1 text-xs text-bg font-medium disabled:opacity-50">Comment</button>
      </div>
    </div>
  );
}

function Comments({ comments }: { comments: GhComment[] }) {
  return (
    <ul className="space-y-2 px-3 py-2">
      {comments.map(c => (
        <li key={c.id} className="rounded-button border border-border p-2 text-xs">
          <div className="mb-1 text-fg-tertiary">{c.user.login} · {new Date(c.created_at).toLocaleString()}{c.path ? ` · ${c.path}${c.line ? `:${c.line}` : ''}` : ''}</div>
          <MarkdownText text={c.body} />
        </li>
      ))}
    </ul>
  );
}

function PullDetail({ projectId, base, number, onBack }: { projectId: string; base: string; number: number; onBack: () => void }) {
  const pr = useGh<GhPull>(projectId, `${base}/pulls/${number}`);
  const files = useGh<GhFile[]>(projectId, `${base}/pulls/${number}/files?per_page=100`);
  const comments = useGh<GhComment[]>(projectId, `${base}/issues/${number}/comments?per_page=100`);
  const reviewComments = useGh<GhComment[]>(projectId, `${base}/pulls/${number}/comments?per_page=100`);
  const checks = useGh<{ check_runs: GhCheckRun[] }>(projectId, pr.data ? `${base}/commits/${pr.data.head.sha}/check-runs` : null);
  const [tab, setTab] = useState<'conversation' | 'files' | 'checks'>('conversation');
  const [msg, setMsg] = useState<string | null>(null);

  if (pr.error) return <><Back onBack={onBack} title={`#${number}`} /><PanelMessage tone="error">{pr.error}</PanelMessage></>;
  if (!pr.data) return <><Back onBack={onBack} title={`#${number}`} /><PanelMessage>Loading…</PanelMessage></>;
  const p = pr.data;

  async function merge(method: 'merge' | 'squash' | 'rebase') {
    if (!confirm(`${method} PR #${number} into ${p.base.ref}?`)) return;
    try {
      const r = await githubApi<{ message: string }>(projectId, `${base}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: method } });
      setMsg(r.message);
      await pr.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div>
      <Back onBack={onBack} title={`#${number} ${p.title}`} href={p.html_url} />
      <div className="border-b border-border px-3 py-1.5 text-xs text-fg-tertiary">
        {p.merged ? 'merged' : p.state}{p.draft ? ' · draft' : ''} · {p.user.login} wants to merge <code>{p.head.ref}</code> into <code>{p.base.ref}</code>
      </div>
      <div className="flex border-b border-border text-xs" role="tablist">
        {(['conversation', 'files', 'checks'] as const).map(t => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex-1 py-1 capitalize ${tab === t ? 'border-b-2 border-accent text-fg' : 'text-fg-tertiary'}`}>
            {t}{t === 'files' && files.data ? ` (${files.data.length})` : ''}
          </button>
        ))}
      </div>
      {msg && <PanelMessage>{msg}</PanelMessage>}
      {tab === 'conversation' && (
        <>
          {p.body && <div className="px-3 py-2 text-xs"><MarkdownText text={p.body} /></div>}
          <Comments comments={[...(comments.data ?? []), ...(reviewComments.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))} />
          <CommentBox onSubmit={async body => { await githubApi(projectId, `${base}/issues/${number}/comments`, { method: 'POST', body: { body } }); await comments.reload(); }} />
          {p.state === 'open' && !p.merged && (
            <div className="flex gap-2 border-t border-border p-3 text-xs">
              <button onClick={() => void merge('squash')} className="rounded-button bg-success px-2 py-1 text-black font-medium">Squash & merge</button>
              <button onClick={() => void merge('merge')} className="rounded-button border border-border px-2 py-1 text-fg">Merge commit</button>
              <button onClick={() => void merge('rebase')} className="rounded-button border border-border px-2 py-1 text-fg">Rebase</button>
            </div>
          )}
        </>
      )}
      {tab === 'files' && (files.data ?? []).map(f => (
        <details key={f.filename} className="border-b border-border text-xs">
          <summary className="cursor-pointer px-3 py-1 hover:bg-bg-secondary">
            <span className="font-mono text-fg">{f.filename}</span> <span className="text-success">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span>
          </summary>
          <pre className="overflow-auto px-3 pb-2 font-mono text-[11px]">
            {(f.patch ?? '(binary or too large)').split('\n').map((l, i) => (
              <div key={i} className={l.startsWith('+') ? 'bg-success/10 text-success' : l.startsWith('-') ? 'bg-danger/10 text-danger' : l.startsWith('@@') ? 'text-accent' : 'text-fg-secondary'}>{l || ' '}</div>
            ))}
          </pre>
        </details>
      ))}
      {tab === 'checks' && (
        <ul className="divide-y divide-border">
          {(checks.data?.check_runs ?? []).map(c => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <StateIcon status={c.status} conclusion={c.conclusion} />
              <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
              <span className="text-fg-tertiary">{c.conclusion ?? c.status}</span>
            </li>
          ))}
          {checks.data && checks.data.check_runs.length === 0 && <PanelMessage>No checks.</PanelMessage>}
        </ul>
      )}
    </div>
  );
}

function IssueDetail({ projectId, base, number, onBack }: { projectId: string; base: string; number: number; onBack: () => void }) {
  const issue = useGh<GhIssue>(projectId, `${base}/issues/${number}`);
  const comments = useGh<GhComment[]>(projectId, `${base}/issues/${number}/comments?per_page=100`);
  if (!issue.data) return <><Back onBack={onBack} title={`#${number}`} />{issue.error ? <PanelMessage tone="error">{issue.error}</PanelMessage> : <PanelMessage>Loading…</PanelMessage>}</>;
  const i = issue.data;
  const toggle = async () => { await githubApi(projectId, `${base}/issues/${number}`, { method: 'PATCH', body: { state: i.state === 'open' ? 'closed' : 'open' } }); await issue.reload(); };
  return (
    <div>
      <Back onBack={onBack} title={`#${number} ${i.title}`} href={i.html_url} />
      <div className="flex items-center border-b border-border px-3 py-1.5 text-xs text-fg-tertiary">
        <span className="flex-1">{i.state} · {i.user.login}</span>
        <button onClick={() => void toggle()} className="underline hover:text-fg">{i.state === 'open' ? 'Close issue' : 'Reopen'}</button>
      </div>
      {i.body && <div className="px-3 py-2 text-xs"><MarkdownText text={i.body} /></div>}
      <Comments comments={comments.data ?? []} />
      <CommentBox onSubmit={async body => { await githubApi(projectId, `${base}/issues/${number}/comments`, { method: 'POST', body: { body } }); await comments.reload(); }} />
    </div>
  );
}

function RunList({ projectId, base, onOpen }: { projectId: string; base: string; onOpen: (id: number) => void }) {
  const { data, error } = useGh<{ workflow_runs: GhRun[] }>(projectId, `${base}/actions/runs?per_page=30`);
  if (error) return <PanelMessage tone="error">{error}</PanelMessage>;
  if (!data) return <PanelMessage>Loading…</PanelMessage>;
  if (data.workflow_runs.length === 0) return <PanelMessage>No workflow runs.</PanelMessage>;
  return (
    <ul className="divide-y divide-border">
      {data.workflow_runs.map(r => (
        <li key={r.id}>
          <button onClick={() => onOpen(r.id)} className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-secondary">
            <div className="flex items-center gap-1.5">
              <StateIcon status={r.status} conclusion={r.conclusion} />
              <span className="min-w-0 flex-1 truncate text-fg">{r.display_title}</span>
            </div>
            <div className="ml-5 text-fg-tertiary">{r.name} · {r.head_branch} · {r.event} · {new Date(r.created_at).toLocaleString()}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RunDetail({ projectId, base, id, onBack }: { projectId: string; base: string; id: number; onBack: () => void }) {
  const run = useGh<GhRun>(projectId, `${base}/actions/runs/${id}`);
  const jobs = useGh<{ jobs: GhJob[] }>(projectId, `${base}/actions/runs/${id}/jobs`);
  const [log, setLog] = useState<{ job: string; text: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function openLog(job: GhJob) {
    try {
      setLog({ job: job.name, text: 'Loading…' });
      const text = await githubText(projectId, `${base}/actions/jobs/${job.id}/logs`);
      setLog({ job: job.name, text: text.slice(-200_000) });
    } catch (e) { setLog({ job: job.name, text: (e as Error).message }); }
  }
  async function rerun(failedOnly: boolean) {
    try {
      await githubApi(projectId, `${base}/actions/runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST', body: {} });
      setMsg('Re-run requested.');
      await run.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div>
      <Back onBack={log ? () => setLog(null) : onBack} title={log ? log.job : run.data?.display_title ?? `run ${id}`} href={run.data?.html_url} />
      {msg && <PanelMessage>{msg}</PanelMessage>}
      {log ? (
        <pre className="overflow-auto whitespace-pre-wrap p-2 font-mono text-[10px] text-fg-secondary">{log.text}</pre>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {(jobs.data?.jobs ?? []).map(j => (
              <li key={j.id}>
                <button onClick={() => void openLog(j)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-bg-secondary">
                  <StateIcon status={j.status} conclusion={j.conclusion} />
                  <span className="min-w-0 flex-1 truncate text-fg">{j.name}</span>
                  <span className="text-fg-tertiary">logs</span>
                </button>
              </li>
            ))}
          </ul>
          {run.data?.status === 'completed' && (
            <div className="flex gap-2 p-3 text-xs">
              <button onClick={() => void rerun(false)} className="flex items-center gap-1 rounded-button border border-border px-2 py-1 text-fg"><Play size={12} /> Re-run all</button>
              {run.data.conclusion === 'failure' && <button onClick={() => void rerun(true)} className="rounded-button border border-border px-2 py-1 text-fg">Re-run failed</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

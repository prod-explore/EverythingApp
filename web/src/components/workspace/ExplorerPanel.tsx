import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, File, FileText, Folder, FolderTree, History, Image, Link2, RotateCcw } from 'lucide-react';
import { fetchWorkspaceFile, listCheckpoints, listWorkspaceFiles, rollbackWorkspace } from '../../api-workspace';
import type { Checkpoint, WorkspaceEntry, WorkspaceListing } from '../../types-workspace';
import { DockPanel, PanelMessage } from '../shared/DockPanel';

const ROOT = '/workspace';

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function EntryIcon({ e }: { e: WorkspaceEntry }) {
  if (e.type === 'directory') return <Folder size={14} className="shrink-0 text-accent" />;
  if (e.type === 'symlink') return <Link2 size={14} className="shrink-0 text-fg-tertiary" />;
  if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) return <Image size={14} className="shrink-0 text-fg-secondary" />;
  if (/\.(md|txt|json|ts|tsx|js|py|sh|ya?ml|csv|log|html|css)$/i.test(e.name)) return <FileText size={14} className="shrink-0 text-fg-secondary" />;
  return <File size={14} className="shrink-0 text-fg-secondary" />;
}

/**
 * Workspace Explorer (Plan v3 §4): the project's sandbox files, read byte-wise by the supervisor even
 * while the sandbox is stopped. Preview: text/markdown/images only, everything else downloads.
 * Checkpoints: one per agent turn; rollback restores the workspace to that point.
 */
export function ExplorerPanel({ owner, onClose }: { owner: string; onClose: () => void }) {
  const [path, setPath] = useState(ROOT);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; url: string; type: string; text?: string; size: number } | null>(null);
  const [tab, setTab] = useState<'files' | 'checkpoints'>('files');

  const load = useCallback(async (p: string) => {
    setError(null);
    try {
      setListing(await listWorkspaceFiles(owner, p));
      setPath(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [owner]);

  useEffect(() => { void load(ROOT); }, [load]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const openFile = useCallback(async (p: string) => {
    setError(null);
    try {
      const f = await fetchWorkspaceFile(owner, p);
      setPreview(prev => { if (prev) URL.revokeObjectURL(prev.url); return { path: p, ...f }; });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [owner]);

  // "Open current version" from a Gazeta report pin.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (detail?.path) { setTab('files'); void openFile(detail.path); }
    }
    window.addEventListener('ea:open-file', onOpen);
    return () => window.removeEventListener('ea:open-file', onOpen);
  }, [openFile]);

  const crumbs = path.split('/').filter(Boolean);

  return (
    <DockPanel
      title="Files"
      icon={<FolderTree size={16} />}
      onClose={onClose}
      actions={
        <div className="flex rounded-button border border-border text-xs" role="tablist">
          {(['files', 'checkpoints'] as const).map(t => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-2 py-0.5 ${tab === t ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary'}`}>
              {t === 'files' ? 'Files' : 'Checkpoints'}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'checkpoints' ? (
        <CheckpointList owner={owner} onRolledBack={() => void load(path)} />
      ) : preview ? (
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
            <button onClick={() => setPreview(null)} className="rounded p-0.5 text-fg-tertiary hover:text-fg" aria-label="Back to folder"><ArrowLeft size={14} /></button>
            <span className="min-w-0 flex-1 truncate font-mono text-fg-secondary">{preview.path}</span>
            <span className="text-fg-tertiary">{formatSize(preview.size)}</span>
            <a href={preview.url} download={preview.path.split('/').pop()} className="text-fg-tertiary underline hover:text-fg">Download</a>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {preview.text !== undefined ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-fg">{preview.text}</pre>
            ) : preview.type.startsWith('image/') ? (
              <img src={preview.url} alt={preview.path} className="max-w-full" />
            ) : (
              <PanelMessage>No preview for this file type — use Download.</PanelMessage>
            )}
          </div>
        </div>
      ) : (
        <div>
          <nav className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-1.5 text-xs" aria-label="Path">
            {crumbs.map((c, i) => {
              const target = '/' + crumbs.slice(0, i + 1).join('/');
              return (
                <span key={target} className="flex items-center gap-0.5">
                  {i > 0 && <span className="text-fg-tertiary">/</span>}
                  <button onClick={() => void load(target)} className={`rounded px-1 hover:bg-bg-secondary ${i === crumbs.length - 1 ? 'text-fg' : 'text-fg-secondary'}`}>{c}</button>
                </span>
              );
            })}
          </nav>
          {error && <PanelMessage tone="error">{error}</PanelMessage>}
          {listing?.empty && <PanelMessage>This workspace has no files yet — it is created the first time the agent uses the sandbox.</PanelMessage>}
          <ul className="py-1">
            {path !== ROOT && (
              <li>
                <button onClick={() => void load(path.split('/').slice(0, -1).join('/') || ROOT)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-fg-secondary hover:bg-bg-secondary">
                  <Folder size={14} className="text-fg-tertiary" /> ..
                </button>
              </li>
            )}
            {listing?.entries.map(e => (
              <li key={e.path}>
                <button
                  onClick={() => (e.type === 'directory' ? void load(e.path) : e.type === 'file' ? void openFile(e.path) : undefined)}
                  disabled={e.type === 'symlink' || e.type === 'other'}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-fg hover:bg-bg-secondary disabled:cursor-default disabled:opacity-60"
                  title={e.type === 'symlink' ? `symlink → ${e.target ?? '?'} (not followed)` : e.path}
                >
                  <EntryIcon e={e} />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {e.type === 'file' && <span className="shrink-0 text-fg-tertiary">{formatSize(e.size)}</span>}
                </button>
              </li>
            ))}
          </ul>
          {listing?.truncated && <PanelMessage>Listing truncated — too many entries.</PanelMessage>}
        </div>
      )}
    </DockPanel>
  );
}

function CheckpointList({ owner, onRolledBack }: { owner: string; onRolledBack: () => void }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCheckpoints((await listCheckpoints(owner)).checkpoints); setError(null); } catch (e) { setError((e as Error).message); }
  }, [owner]);
  useEffect(() => { void load(); }, [load]);

  async function rollback(id: string) {
    setBusy(true);
    try {
      await rollbackWorkspace(owner, id);
      setConfirming(null);
      onRolledBack();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <PanelMessage tone="error">{error}</PanelMessage>;
  if (!checkpoints) return <PanelMessage>Loading…</PanelMessage>;
  if (checkpoints.length === 0) return <PanelMessage>No checkpoints yet. One is taken before every agent turn that uses the sandbox.</PanelMessage>;
  return (
    <ul className="divide-y divide-border">
      {checkpoints.map(cp => (
        <li key={cp.id} className="px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <History size={13} className="shrink-0 text-fg-tertiary" />
            <span className="min-w-0 flex-1 truncate text-fg">{cp.label || cp.id}</span>
            <span className="shrink-0 text-fg-tertiary">{new Date(cp.createdAt).toLocaleString()}</span>
            <button onClick={() => setConfirming(cp.id)} className="rounded p-1 text-fg-tertiary hover:text-fg" aria-label={`Roll back to ${cp.label}`} title="Roll back to here">
              <RotateCcw size={13} />
            </button>
          </div>
          {confirming === cp.id && (
            <div className="mt-2 rounded-button border border-danger/40 p-2">
              <p className="text-fg-secondary">Restore the workspace to this point? Changes made after it are discarded (git history in your repos is not touched; ignored files like node_modules stay).</p>
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setConfirming(null)} className="px-2 py-1 text-fg-tertiary hover:text-fg">Cancel</button>
                <button onClick={() => void rollback(cp.id)} disabled={busy} className="rounded-button bg-danger px-2 py-1 text-white disabled:opacity-50">Roll back</button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { deleteProject, getProject, listApprovalGrants, revokeApprovalGrant, updateProject } from '../../api';
import type { ApprovalGrantRow, CommandMode } from '../../types';
import { Button } from '../shared/Button';
import { Modal } from '../shared/Modal';

const MODES: { id: CommandMode; label: string; hint: string }[] = [
  { id: 'strict', label: 'Strict', hint: 'Ask before every command (except prefixes you granted).' },
  { id: 'allowlist', label: 'Allowlist', hint: 'Read-only commands (ls, cat, git status…) and your granted prefixes run; everything else asks.' },
  { id: 'auto', label: 'Auto in sandbox', hint: 'Anything inside the sandbox runs; asks only at a boundary: push, a new domain, writes outside /workspace.' },
];

/**
 * Project settings are deliberately small: name, description, how eager the shell approval is, and the grants
 * you gave on approval cards. Always-allow / always-block lists, known domains and the default browser policy
 * live in `policy.json` on the server (like Antigravity's or Claude Code's settings file); GitHub is logged in
 * once in Settings → GitHub and repositories are simply cloned in the sandbox by URL.
 */
export function ProjectSettingsModal({ projectId, onClose, onChanged, onDeleted }: {
  projectId: string;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<CommandMode>('strict');
  const [grants, setGrants] = useState<ApprovalGrantRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [project, { grants: g }] = await Promise.all([getProject(projectId), listApprovalGrants({ projectId })]);
        if (cancelled) return;
        const commands = (project.policy['commands'] ?? {}) as { mode?: CommandMode };
        setName(project.name);
        setDescription(project.description ?? '');
        setMode(commands.mode ?? 'strict');
        setGrants(g);
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
      // Only the mode is written; the server merges policy section by section, so lists set elsewhere survive.
      await updateProject(projectId, { name, description, policy: { commands: { mode } } });
      setStatus('saved');
      onChanged();
    } catch {
      setStatus('error');
    }
  }

  async function revoke(id: string) {
    await revokeApprovalGrant(id);
    setGrants(gs => gs.filter(g => g.id !== id));
  }

  async function remove(keepChats: boolean) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(projectId, keepChats);
      onDeleted();
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  }

  const field = 'w-full rounded-button border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-border-hover';

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
            <p className="mt-1 text-xs text-fg-tertiary">
              Always-allow / always-block prefixes, known domains and the browser policy are edited in <code>policy.json</code> next to the database
              (changes apply on the next command, no restart). Destructive patterns are always blocked.
            </p>
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

          <section className="rounded-button border border-danger/40 p-3" aria-label="Danger zone">
            <h3 className="mb-1 text-sm font-medium text-danger">Delete project</h3>
            <p className="mb-2 text-xs text-fg-tertiary">Files in the sandbox workspace are kept on disk; chats, agent runs and grants are removed — or you can keep the chats as quick chats.</p>
            {!confirmDelete ? (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete project…</Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void remove(false)} disabled={deleting}>Delete project and its chats</Button>
                <Button variant="ghost" onClick={() => void remove(true)} disabled={deleting}>Delete project, keep chats</Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</Button>
              </div>
            )}
            {deleteError && <p className="mt-2 text-xs text-danger" role="alert">{deleteError}</p>}
          </section>
        </div>
      )}
    </Modal>
  );
}

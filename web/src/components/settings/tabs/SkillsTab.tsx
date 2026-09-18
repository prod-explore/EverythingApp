import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Check, X, Tag } from 'lucide-react';
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  getConversationSkills,
  attachSkill,
  detachSkill,
} from '../../../api';
import type { Skill } from '../../../types';
import { Button } from '../../shared/Button';

interface SkillFormData {
  name: string;
  description: string;
  prompt: string;
  allowedTools: string; // comma-separated input
}

const EMPTY_FORM: SkillFormData = { name: '', description: '', prompt: '', allowedTools: '' };

function toForm(s: Skill): SkillFormData {
  return { name: s.name, description: s.description, prompt: s.prompt, allowedTools: s.allowedTools.join(', ') };
}

function parseTags(raw: string): string[] {
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

/**
 * Skills tab — manage the global Skills library and (if a conversationId is
 * provided) attach/detach skills from the current conversation.
 */
export function SkillsTab({ conversationId }: { conversationId?: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<SkillFormData>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [{ skills: all }, convSkills] = await Promise.all([
      listSkills(),
      conversationId ? getConversationSkills(conversationId).then(r => r.skills) : Promise.resolve([]),
    ]);
    setSkills(all);
    setAttached(new Set(convSkills.map(s => s.id)));
  }

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  function startEdit(s: Skill) {
    setEditingId(s.id);
    setCreating(false);
    setForm(toForm(s));
    setError(null);
  }

  function cancelForm() {
    setEditingId(null);
    setCreating(false);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const opts = {
        name: form.name.trim(),
        description: form.description.trim(),
        prompt: form.prompt.trim(),
        allowedTools: parseTags(form.allowedTools),
      };
      if (creating) {
        await createSkill(opts);
      } else if (editingId) {
        await updateSkill(editingId, opts);
      }
      cancelForm();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this skill? This will detach it from all conversations.')) return;
    await deleteSkill(id);
    await reload();
  }

  async function toggleAttach(skillId: string) {
    if (!conversationId) return;
    if (attached.has(skillId)) {
      await detachSkill(conversationId, skillId);
    } else {
      await attachSkill(conversationId, skillId);
    }
    await reload();
  }

  if (loading) return <p className="text-sm text-fg-tertiary">Loading skills…</p>;

  const isFormOpen = creating || editingId !== null;

  return (
    <div className="space-y-4">
      {/* Skill list */}
      {skills.length === 0 && !isFormOpen && (
        <p className="text-sm text-fg-tertiary">No skills yet. Create one to get started.</p>
      )}

      {skills.map(s => {
        const isEditing = editingId === s.id;
        const isAttached = attached.has(s.id);

        if (isEditing) {
          return (
            <SkillForm
              key={s.id}
              form={form}
              setForm={setForm}
              onSave={save}
              onCancel={cancelForm}
              saving={saving}
              error={error}
              label="Save changes"
            />
          );
        }

        return (
          <div key={s.id} className="rounded-button border border-border px-3 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{s.name}</span>
                  {s.allowedTools.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {s.allowedTools.map(t => (
                        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-bg px-2 py-0.5 font-mono text-xs text-fg-tertiary border border-border">
                          <Tag size={10} /> {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {s.description && <p className="mt-0.5 text-xs text-fg-tertiary">{s.description}</p>}
                {s.prompt && (
                  <pre className="mt-1 line-clamp-2 text-xs text-fg-secondary whitespace-pre-wrap">{s.prompt}</pre>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {conversationId && (
                  <button
                    onClick={() => toggleAttach(s.id)}
                    title={isAttached ? 'Detach from this conversation' : 'Attach to this conversation'}
                    className={`rounded-button px-2 py-1 text-xs font-medium transition-colors ${
                      isAttached
                        ? 'bg-fg text-bg hover:opacity-80'
                        : 'border border-border text-fg-secondary hover:border-border-hover'
                    }`}
                  >
                    {isAttached ? '✓ Attached' : 'Attach'}
                  </button>
                )}
                <button
                  onClick={() => startEdit(s)}
                  title="Edit"
                  className="rounded-button p-1.5 text-fg-tertiary hover:text-fg"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => remove(s.id)}
                  title="Delete"
                  className="rounded-button p-1.5 text-fg-tertiary hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Create form */}
      {creating && (
        <SkillForm
          form={form}
          setForm={setForm}
          onSave={save}
          onCancel={cancelForm}
          saving={saving}
          error={error}
          label="Create skill"
        />
      )}

      {/* Add button */}
      {!isFormOpen && (
        <Button variant="ghost" onClick={startCreate} className="w-full">
          <Plus size={14} className="mr-1" /> New skill
        </Button>
      )}

      {conversationId && (
        <p className="text-xs text-fg-tertiary">
          Attached skills inject their prompt into the system prompt for this conversation.
        </p>
      )}
    </div>
  );
}

function SkillForm({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  error,
  label,
}: {
  form: SkillFormData;
  setForm: (f: SkillFormData) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  label: string;
}) {
  return (
    <div className="rounded-button border border-border bg-bg-secondary px-4 py-4 space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-fg-secondary">Name *</label>
        <input
          autoFocus
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. Polish Reply Writer"
          className="w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none placeholder:text-fg-tertiary"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-fg-secondary">Description</label>
        <input
          value={form.description}
          onChange={e => setForm({ ...form, description: e.target.value })}
          placeholder="Short description for the skill list"
          className="w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none placeholder:text-fg-tertiary"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-fg-secondary">Prompt</label>
        <textarea
          rows={4}
          value={form.prompt}
          onChange={e => setForm({ ...form, prompt: e.target.value })}
          placeholder="Instructions injected into the system prompt when this skill is attached…"
          className="w-full resize-none rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none placeholder:text-fg-tertiary"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-fg-secondary">Intended tools (comma-separated, informational)</label>
        <input
          value={form.allowedTools}
          onChange={e => setForm({ ...form, allowedTools: e.target.value })}
          placeholder="e.g. sandbox__run_bash, obsidian__search_notes"
          className="w-full rounded-button border border-border bg-bg px-3 py-1.5 font-mono text-xs text-fg outline-none placeholder:text-fg-tertiary"
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel} className="flex items-center gap-1">
          <X size={14} /> Cancel
        </Button>
        <Button variant="primary" onClick={onSave} disabled={saving} className="flex items-center gap-1">
          <Check size={14} /> {saving ? 'Saving…' : label}
        </Button>
      </div>
    </div>
  );
}

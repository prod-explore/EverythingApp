import { useEffect, useState } from 'react';
import { Download, Image, FileText, File, Trash2, X, FolderOpen } from 'lucide-react';
import { getToken } from '../../api';
import type { ArtifactRow } from '../../types';

/**
 * §6b Chunk B: Artifacts panel.
 *
 * Lists all artifacts for the current conversation, with inline preview for
 * images and a download link for everything else. Refreshed every time the
 * panel opens, and live-updated via SSE artifact:new events (wired in App.tsx).
 */

async function fetchArtifacts(conversationId: string): Promise<ArtifactRow[]> {
  const token = getToken() ?? '';
  const res = await fetch(`/api/conversations/${conversationId}/artifacts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch artifacts');
  const data = await res.json() as { artifacts: ArtifactRow[] };
  return data.artifacts;
}

async function deleteArtifact(id: string): Promise<void> {
  const token = getToken() ?? '';
  await fetch(`/api/artifacts/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

function artifactFileUrl(id: string): string {
  return `/api/artifacts/${id}/file?token=${encodeURIComponent(getToken() ?? '')}`;
}

function MimeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <Image size={16} className="shrink-0 text-fg-secondary" />;
  if (mimeType.startsWith('text/')) return <FileText size={16} className="shrink-0 text-fg-secondary" />;
  return <File size={16} className="shrink-0 text-fg-secondary" />;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArtifactsPanel({
  conversationId,
  onClose,
  refreshTrigger,
}: {
  conversationId: string;
  onClose: () => void;
  /** Increment this to trigger a refresh (e.g. on SSE artifact:new). */
  refreshTrigger?: number;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchArtifacts(conversationId)
      .then(rows => { if (!cancelled) { setArtifacts(rows); setError(null); } })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId, refreshTrigger]);

  async function handleDelete(id: string) {
    await deleteArtifact(id);
    setArtifacts(prev => prev.filter(a => a.id !== id));
    if (previewId === id) setPreviewId(null);
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-secondary">
        <FolderOpen size={15} className="text-fg-secondary shrink-0" />
        <span className="text-sm font-medium text-fg flex-1">Artifacts</span>
        <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary" aria-label="Close artifacts panel">
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12 text-xs text-fg-tertiary">Loading…</div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center py-12 text-xs text-danger">{error}</div>
        )}
        {!loading && !error && artifacts.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-fg-tertiary">
            <FolderOpen size={28} className="opacity-40" />
            <span>No artifacts yet.</span>
            <span className="text-fg-quaternary">Screenshots and files saved by the browser agent appear here.</span>
          </div>
        )}
        {!loading && !error && artifacts.length > 0 && (
          <ul className="divide-y divide-border">
            {artifacts.map(artifact => (
              <li key={artifact.id} className="flex flex-col gap-1 p-3 hover:bg-bg-secondary">
                <div className="flex items-center gap-2">
                  <MimeIcon mimeType={artifact.mimeType} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-fg truncate">{artifact.filename}</div>
                    <div className="text-xs text-fg-tertiary">
                      {humanBytes(artifact.sizeBytes)} · {artifact.source} · {new Date(artifact.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {artifact.mimeType.startsWith('image/') && (
                      <button
                        onClick={() => setPreviewId(prev => prev === artifact.id ? null : artifact.id)}
                        className="text-fg-tertiary hover:text-fg-secondary text-xs underline"
                        title="Preview"
                      >
                        {previewId === artifact.id ? 'Hide' : 'Preview'}
                      </button>
                    )}
                    <a
                      href={artifactFileUrl(artifact.id)}
                      download={artifact.filename}
                      className="text-fg-tertiary hover:text-fg-secondary"
                      title="Download"
                    >
                      <Download size={13} />
                    </a>
                    <button
                      onClick={() => void handleDelete(artifact.id)}
                      className="text-fg-tertiary hover:text-danger"
                      title="Delete artifact"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {previewId === artifact.id && artifact.mimeType.startsWith('image/') && (
                  <img
                    src={artifactFileUrl(artifact.id)}
                    alt={artifact.filename}
                    className="mt-1 rounded border border-border max-h-64 object-contain w-full bg-black"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

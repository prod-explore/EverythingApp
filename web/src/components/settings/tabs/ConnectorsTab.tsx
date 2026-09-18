import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getConnectors } from '../../../api';
import type { ConnectorInfo } from '../../../types';
import { Badge } from '../../shared/Badge';

/**
 * Connectors tab — expandable list of MCP connectors with their tools.
 * Each tool row shows the name and description.
 *
 * Phase 2 note: "always allow" per-tool is surfaced in the ApprovalModal's
 * scope picker (once/chat/always). A future enhancement could add static
 * pre-grants here that persist across server restarts, but the in-flow
 * picker is the primary mechanism for now.
 */
export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getConnectors()
      .then(({ connectors }) => setConnectors(connectors))
      .finally(() => setLoading(false));
  }, []);

  function toggle(name: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  if (loading) {
    return <p className="text-sm text-fg-tertiary">Loading connectors…</p>;
  }

  if (connectors.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-fg-tertiary">No MCP connectors configured.</p>
        <p className="text-xs text-fg-tertiary">
          Add connectors via the <code className="font-mono">MCP_CONNECTORS</code> env var and restart the server.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {connectors.map(c => {
        const isExpanded = expanded.has(c.name);
        return (
          <div key={c.name} className="rounded-button border border-border">
            <button
              onClick={() => toggle(c.name)}
              className="flex w-full items-center justify-between px-3 py-2 text-left"
            >
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronDown size={14} className="shrink-0 text-fg-tertiary" /> : <ChevronRight size={14} className="shrink-0 text-fg-tertiary" />}
                <span className="font-mono text-sm text-fg">{c.name}</span>
              </div>
              <Badge tone={c.connected ? 'success' : 'danger'}>
                {c.connected ? `${c.toolCount} tools` : 'disconnected'}
              </Badge>
            </button>

            {isExpanded && c.tools.length > 0 && (
              <div className="border-t border-border px-3 pb-2 pt-1">
                {c.tools.map(t => (
                  <div key={t.name} className="py-1.5">
                    <div className="font-mono text-xs text-fg">{t.name}</div>
                    {t.description && (
                      <div className="mt-0.5 text-xs text-fg-tertiary">{t.description}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isExpanded && c.tools.length === 0 && (
              <div className="border-t border-border px-3 py-2">
                <p className="text-xs text-fg-tertiary">No tools exposed by this connector.</p>
              </div>
            )}
          </div>
        );
      })}

      <p className="pt-1 text-xs text-fg-tertiary">
        To grant permanent per-tool approval, click <strong>Approve for this chat</strong> or <strong>Always approve</strong> in the approval dialog when a tool call comes in.
      </p>
    </div>
  );
}

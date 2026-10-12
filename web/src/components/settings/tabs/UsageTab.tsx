import { useEffect, useState } from 'react';
import { getUsageReport } from '../../../api';
import { providerLabel, useModels } from '../../../hooks/useModels';
import type { UsageRange, UsageReport, UsageTotals } from '../../../types';

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
];

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function Table({ title, rows }: { title: string; rows: Array<{ key: string; label: string; t: UsageTotals }> }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-fg-secondary">{title}</h3>
      <div className="overflow-x-auto rounded-button border border-border">
        <table className="w-full text-left text-xs">
          <thead className="text-fg-tertiary">
            <tr>
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 text-right font-normal">Calls</th>
              <th className="px-3 py-2 text-right font-normal">In / out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} className="border-t border-border text-fg">
                <td className="max-w-[10rem] truncate px-3 py-2">{r.label}</td>
                <td className="px-3 py-2 text-right text-fg-secondary">{r.t.calls}</td>
                <td className="px-3 py-2 text-right text-fg-secondary">
                  {tok(r.t.inputTokens + r.t.cacheReadTokens + r.t.cacheWriteTokens)} / {tok(r.t.outputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsageTab() {
  const [range, setRange] = useState<UsageRange>('30d');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { models } = useModels();
  const modelLabel = (id: string) => models.find(m => m.id === id)?.label ?? id;

  useEffect(() => {
    let cancelled = false;
    getUsageReport(range)
      .then(r => !cancelled && (setReport(r), setError(null)))
      .catch(e => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const maxDay = Math.max(1, ...(report?.byDay.map(d => d.tokens) ?? []));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1">
        {RANGES.map(r => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className={`rounded-button px-3 py-1 text-xs ${range === r.id ? 'border border-fg/40 text-fg' : 'border border-border text-fg-tertiary hover:text-fg-secondary'}`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!report && !error && <p className="text-xs text-fg-tertiary">Loading…</p>}
      {report && (
        <>
          <div className="rounded-button border border-border px-4 py-3">
            <p className="text-xs text-fg-tertiary">Tokens</p>
            <p className="text-2xl font-medium text-fg">{tok(report.totals.inputTokens + report.totals.cacheReadTokens + report.totals.cacheWriteTokens + report.totals.outputTokens)}</p>
            <p className="text-xs text-fg-tertiary">
              {report.totals.calls} calls · {tok(report.totals.inputTokens + report.totals.cacheReadTokens + report.totals.cacheWriteTokens)} in ·{' '}
              {tok(report.totals.outputTokens)} out
            </p>
          </div>

          {report.byDay.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-medium text-fg-secondary">By day</h3>
              <div className="flex h-24 items-end gap-1">
                {report.byDay.map(d => (
                  <div key={d.day} className="group relative flex-1" title={`${d.day}: ${tok(d.tokens)} tokens · ${d.calls} calls`}>
                    <div className="w-full rounded-sm bg-fg" style={{ height: `${Math.max(2, (d.tokens / maxDay) * 96)}px` }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-fg-tertiary">
                <span>{report.byDay[0]!.day}</span>
                <span>{report.byDay[report.byDay.length - 1]!.day}</span>
              </div>
            </div>
          )}

          <Table title="By provider" rows={report.byProvider.map(p => ({ key: p.provider, label: providerLabel(p.provider, models), t: p }))} />
          <Table title="By model" rows={report.byModel.map(m => ({ key: m.provider + m.model, label: modelLabel(m.model), t: m }))} />
          <Table
            title="By conversation"
            rows={report.byConversation.map(c => ({ key: c.conversationId ?? 'none', label: c.title ?? (c.conversationId ? '(deleted conversation)' : '(no conversation)'), t: c }))}
          />
        </>
      )}
    </div>
  );
}

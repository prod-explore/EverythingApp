import { useEffect, useState } from 'react';
import { getUsageReport } from '../../../api';
import { PROVIDER_LABELS } from '../../../hooks/useModels';
import type { UsageRange, UsageReport, UsageTotals } from '../../../types';

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
];

const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
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
              <th className="px-3 py-2 text-right font-normal">Cost</th>
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
                <td className="px-3 py-2 text-right">
                  {r.t.unpricedCalls > 0 ? '≥' : ''}
                  {usd(r.t.costUsd)}
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

  useEffect(() => {
    let cancelled = false;
    getUsageReport(range)
      .then(r => !cancelled && (setReport(r), setError(null)))
      .catch(e => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const maxDay = Math.max(0.0001, ...(report?.byDay.map(d => d.costUsd) ?? []));

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
            <p className="text-xs text-fg-tertiary">Spend</p>
            <p className="text-2xl font-medium text-fg">
              {report.totals.unpricedCalls > 0 ? '≥' : ''}
              {usd(report.totals.costUsd)}
            </p>
            <p className="text-xs text-fg-tertiary">
              {report.totals.calls} calls · {tok(report.totals.inputTokens + report.totals.cacheReadTokens + report.totals.cacheWriteTokens)} in ·{' '}
              {tok(report.totals.outputTokens)} out
            </p>
            {report.totals.unpricedCalls > 0 && (
              <p className="mt-1 text-xs text-fg-tertiary">
                {report.totals.unpricedCalls} call(s) used a model with no known price and are counted as $0 — set MODEL_PRICING_JSON on the server.
              </p>
            )}
          </div>

          {report.monthToDate.some(m => m.warnUsd !== null) && (
            <div className="space-y-1">
              {report.monthToDate
                .filter(m => m.warnUsd !== null)
                .map(m => (
                  <div key={m.provider} className="text-xs text-fg-secondary">
                    {PROVIDER_LABELS[m.provider] ?? m.provider} this month: {usd(m.costUsd)} of {usd(m.warnUsd!)} warning threshold
                    <div className="mt-1 h-1 rounded bg-bg-tertiary">
                      <div className={`h-1 rounded ${m.costUsd >= m.warnUsd! ? 'bg-danger' : 'bg-fg'}`} style={{ width: `${Math.min(100, (m.costUsd / m.warnUsd!) * 100)}%` }} />
                    </div>
                  </div>
                ))}
            </div>
          )}

          {report.byDay.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-medium text-fg-secondary">By day</h3>
              <div className="flex h-24 items-end gap-1">
                {report.byDay.map(d => (
                  <div key={d.day} className="group relative flex-1" title={`${d.day}: ${usd(d.costUsd)} · ${d.calls} calls`}>
                    <div className="w-full rounded-sm bg-fg" style={{ height: `${Math.max(2, (d.costUsd / maxDay) * 96)}px` }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-fg-tertiary">
                <span>{report.byDay[0]!.day}</span>
                <span>{report.byDay[report.byDay.length - 1]!.day}</span>
              </div>
            </div>
          )}

          <Table title="By provider" rows={report.byProvider.map(p => ({ key: p.provider, label: PROVIDER_LABELS[p.provider] ?? p.provider, t: p }))} />
          <Table title="By model" rows={report.byModel.map(m => ({ key: m.provider + m.model, label: m.model, t: m }))} />
          <Table
            title="By conversation"
            rows={report.byConversation.map(c => ({ key: c.conversationId ?? 'none', label: c.title ?? (c.conversationId ? '(deleted conversation)' : '(batch / no conversation)'), t: c }))}
          />
        </>
      )}
    </div>
  );
}

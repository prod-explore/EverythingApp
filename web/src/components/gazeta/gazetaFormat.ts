export const TYPE_LABEL: Record<string, string> = {
  approval: 'Approval',
  agent_question: 'Question',
  report: 'Report',
  daily_summary: 'Daily summary',
};

/** Human-readable version of whatever shape the form sent back. */
export function summarizeResponse(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.choice === 'string') return r.choice;
    if (typeof r.text === 'string') return r.text;
    if (r.acknowledged === true) return 'Marked handled';
    if (r.fields && typeof r.fields === 'object') {
      return Object.entries(r.fields as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');
    }
  }
  return JSON.stringify(response);
}

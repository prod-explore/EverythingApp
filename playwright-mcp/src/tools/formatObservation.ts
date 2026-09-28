import type { QuarantinedObservation } from '../observe.js';

export function formatObservation(obs: QuarantinedObservation, note?: string): string {
  return [
    note,
    `URL: ${obs.url}`,
    `Title: ${obs.title}`,
    `Quarantine model: ${obs.quarantineModel}`,
    '',
    '── Page summary ──',
    obs.summary,
    '',
    `── Interactive elements (${obs.elementCount}) ──`,
    obs.elementTable,
    '',
    'To act, call browser_act with the [ref] number of the element and a `label` copied ' +
      'from its line above (e.g. ref 3, label "Delete Account"). Re-observe with browser_observe ' +
      'if the page may have changed since this list was generated — refs can go stale after a ' +
      'navigation or re-render.',
  ]
    .filter(s => s !== undefined && s !== null)
    .join('\n');
}

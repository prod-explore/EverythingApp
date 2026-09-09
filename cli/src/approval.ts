import * as readline from 'node:readline/promises';

/**
 * Patterns that look potentially irreversible/destructive — §12 pt.5 of the
 * Master Brief. This is a UI hint, not a security boundary (the real
 * boundary is that the call needs a human "y" at all, per §7 pt.3 —
 * enforcement lives outside the model, not in string matching that a
 * determined prompt injection could word around). Deliberately simple and
 * a bit over-eager: false positives just mean an extra warning banner on a
 * safe command, false negatives mean no warning on a genuinely risky one —
 * the asymmetry favors warning too often.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i, // rm -rf, -fr, -Rf, etc.
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:.*\}\s*;\s*:/, // classic shell fork-bomb shape
];

export function looksDangerous(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args);
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * The human-in-the-loop Approval Gate from the Master Brief (§7), implemented
 * as a plain terminal prompt instead of the Phase 4 mobile push-notification
 * queue. Same security property: a tool call with a side effect never runs
 * without an explicit yes from a human, enforced here — outside the model —
 * not by asking the model nicely.
 *
 * Also supports "always allow" per tool for the running session — the same
 * pattern Claude Code and most other agent CLIs already use, not something
 * worth reinventing. It resets when the process exits; nothing risky is
 * silently remembered across sessions. A call that LOOKS dangerous always
 * re-prompts even for an "always allowed" tool, and saying yes to one never
 * extends "always allow" to future dangerous calls — "always allow git_op"
 * was granted for routine use, not for a specific `--force` push nobody's
 * seen yet.
 */
export class ApprovalGate {
  private readonly alwaysAllowed = new Set<string>();

  constructor(private readonly rl: readline.Interface) {}

  async confirm(toolLabel: string, args: Record<string, unknown>): Promise<boolean> {
    const dangerous = looksDangerous(args);

    if (this.alwaysAllowed.has(toolLabel) && !dangerous) return true;

    if (dangerous) {
      console.log(`\n⚠️  [approval] WYGLĄDA NA RYZYKOWNE / POTENCJALNIE NIEODWRACALNE — sprawdź argumenty uważnie.`);
    }
    console.log(`[approval] chce wykonać: ${toolLabel}`);
    console.log(`[approval] argumenty: ${JSON.stringify(args)}`);
    const answer = (
      await this.rl.question('[approval] zatwierdzić? [y/N, a = zawsze dla tej sesji] ')
    )
      .trim()
      .toLowerCase();

    if (answer === 'a') {
      if (dangerous) {
        console.log('[approval] to konkretne wywołanie wygląda na ryzykowne — zatwierdzam tylko raz, nie zapisuję "zawsze zezwalaj" dla takich wywołań.');
        return true;
      }
      this.alwaysAllowed.add(toolLabel);
      console.log(`[approval] '${toolLabel}' będzie odtąd auto-zatwierdzane do końca tej sesji`);
      return true;
    }
    return answer === 'y';
  }
}

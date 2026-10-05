import type { SanitizeStats } from './sanitize.js';

/**
 * Prompt-injection classifier — deterministic, non-generative, and used ONLY as a signal.
 *
 * It never rewrites, drops or reorders page content (that was the old LLM filter's failure mode:
 * a model deciding what the agent gets to see). It scores the already-sanitised text against a fixed
 * set of patterns and reports `suspected` + human-readable reasons, which the tool result exposes as
 * `injection_suspected` for the orchestrator's approval gate to consume.
 */

export interface InjectionInput {
  /** Visible page text (sanitised). */
  text: string;
  /** Element labels (sanitised). */
  labels?: string[];
  title?: string;
  /** Text the page renders invisibly (display:none, opacity 0, off-screen, aria-hidden, 0px font…), sanitised. */
  hiddenText?: string;
  /** Characters of visible vs hidden text, for the hidden-text ratio. */
  visibleChars?: number;
  hiddenChars?: number;
  /** What sanitisation stripped (tag chars, zero-width, bidi…). */
  stripped?: SanitizeStats;
}

export interface InjectionResult {
  suspected: boolean;
  score: number;
  reasons: string[];
}

/** Score at/above which a page is flagged. */
export const INJECTION_THRESHOLD = 3;

interface Rule {
  id: string;
  weight: number;
  re: RegExp;
}

// Patterns are matched against NFKC-normalised, invisible-stripped text, case-insensitively.
const RULES: Rule[] = [
  {
    id: 'instruction override ("ignore previous instructions")',
    weight: 3,
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions|guidelines|directives|messages|context)\b/i,
  },
  {
    id: 'role reassignment ("you are now…")',
    weight: 2,
    re: /\b(you are now|you're now|from now on,? you|you will now act|act as (an?|the) (ai|assistant|agent|system)|pretend (to be|you are)|new persona)\b/i,
  },
  {
    id: 'mentions the system/developer prompt',
    weight: 2,
    re: /\b(system prompt|system message|developer (message|prompt|mode)|hidden instructions|initial instructions|jailbreak)\b/i,
  },
  {
    id: 'chat role markers ("assistant:", "<|im_start|>")',
    weight: 2,
    re: /(^|\n)\s*(system|assistant|developer|human|user)\s*:|<\|(im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(system|assistant|instructions?)>/i,
  },
  {
    id: 'addresses the AI agent directly',
    weight: 2,
    re: /\b(attention|note|message|instructions?) (to|for) (the )?(ai|llm|assistant|agent|language model|chatbot|claude|gpt)\b|\b(dear|hey|hello) (ai|assistant|agent|llm|claude|chatgpt)\b|\bif you are an? (ai|llm|language model|assistant|agent)\b/i,
  },
  {
    id: 'names agent tools / internal parameters',
    weight: 2,
    re: /\b(browser_act|browser_open|browser_observe|browser_close|browse_url|run_bash|git_op|read_log|terminal_list|_conversation_id|_project_id|_policy|_allow_downloads|tool_use|function_call)\b/i,
  },
  {
    id: 'asks to hide actions from the user',
    weight: 3,
    re: /\b(do not|don't|never) (tell|inform|mention|reveal|show|alert|notify)\b[^.\n]{0,30}\b(user|human|operator|anyone)\b|\bwithout (telling|informing|notifying|asking) the (user|human|operator)\b/i,
  },
  {
    id: 'credential / data exfiltration request',
    weight: 2,
    re: /\b(send|email|post|upload|paste|forward|reveal|print|output|leak|exfiltrate)\b[^.\n]{0,40}\b(your|the user'?s|all|any|stored|saved)\s+(api[ _-]?keys?|passwords?|credentials|secrets?|(access|auth|api|session) tokens?|ssh keys?|cookies|conversation history|chat history|env(ironment)? variables)\b/i,
  },
  {
    id: 'new/updated instructions announcement',
    weight: 1,
    re: /\b(new|updated|important|urgent|real|actual|additional) (instructions?|directives?|task|orders)\b\s*[:!]/i,
  },
  {
    id: 'spoofed untrusted-content delimiter',
    weight: 3,
    re: /untrusted_page_content|<\/?\s*untrusted|end of (untrusted|page) content/i,
  },
];

const HIDDEN_RATIO_MIN_CHARS = 200;
const HIDDEN_RATIO_THRESHOLD = 0.5;

function matchRules(text: string): Rule[] {
  if (!text) return [];
  return RULES.filter(r => r.re.test(text));
}

export function scoreInjection(input: InjectionInput): InjectionResult {
  const reasons: string[] = [];
  let score = 0;

  const visibleCorpus = [input.title ?? '', input.text, ...(input.labels ?? [])].join('\n');
  const visibleHits = matchRules(visibleCorpus);
  for (const r of visibleHits) {
    score += r.weight;
    reasons.push(`visible text: ${r.id}`);
  }

  // Hidden text never reaches the agent, but a page that hides instructions is hostile — flag it.
  const visibleIds = new Set(visibleHits.map(r => r.id));
  for (const r of matchRules(input.hiddenText ?? '')) {
    if (visibleIds.has(r.id)) continue;
    score += r.weight;
    reasons.push(`hidden text: ${r.id}`);
  }

  const visibleChars = input.visibleChars ?? 0;
  const hiddenChars = input.hiddenChars ?? 0;
  const total = visibleChars + hiddenChars;
  if (hiddenChars >= HIDDEN_RATIO_MIN_CHARS && total > 0) {
    const ratio = hiddenChars / total;
    if (ratio >= HIDDEN_RATIO_THRESHOLD) {
      score += 1;
      reasons.push(`high hidden-text ratio (${Math.round(ratio * 100)}% of page text is invisible)`);
    }
  }

  const s = input.stripped;
  if (s) {
    if (s.tagChars > 0) {
      score += 3;
      reasons.push(`Unicode tag characters (${s.tagChars}) — invisible ASCII smuggling`);
    }
    if (s.bidi >= 3) {
      score += 1;
      reasons.push(`bidi control characters (${s.bidi})`);
    }
    if (s.zeroWidth >= 20) {
      score += 1;
      reasons.push(`many zero-width/invisible characters (${s.zeroWidth})`);
    }
  }

  return { suspected: score >= INJECTION_THRESHOLD, score, reasons };
}

import 'dotenv/config';
import { assertStrongSecret } from './secret-check.js';
import { parseJsPolicy, parsePatternList, type JsPolicy } from './policy.js';

export interface PlaywrightConfig {
  mcpPort: number;
  apiKey: string;
  /** Request timeout for Playwright navigation in ms. Default 30000. */
  navTimeoutMs: number;
  /** Max concurrent browser sessions (tabs). Sessions beyond this are refused until an
   * idle one is reclaimed. Default 4 — a Pi-sized budget, override for beefier hardware. */
  maxSessions: number;
  /** Milliseconds a session may sit idle before the watchdog closes it. Default 30 min,
   * matching the sandbox's SANDBOX_IDLE_TIMEOUT_MS. */
  sessionIdleTimeoutMs: number;
  /** How often the idle watchdog runs. Default 2 min. */
  watchdogIntervalMs: number;
  /** Private hostnames/IPs the browser MAY reach (explicit opt-in; default none). Comma-separated in BROWSER_ALLOW_PRIVATE_HOSTS. */
  allowPrivateHosts: string[];
  /** Sandbox preview hostnames (`sandbox-<10 hex>`, see urlSafety.ts) — the one private name pattern the browser may reach. */
  previewHostPattern?: RegExp;
  /** Max chars of sanitised page text included in an observation (OBSERVATION_MAX_TEXT_CHARS, default 12000). */
  observationMaxTextChars: number;
  /** Max chars of one element label (OBSERVATION_LABEL_MAX_CHARS, default 100). */
  observationLabelMaxChars: number;
  /** Max interactive elements listed per observation (OBSERVATION_MAX_ELEMENTS, default 300). */
  observationMaxElements: number;
  /** Operator domain allowlist (BROWSER_DOMAIN_ALLOW, comma-separated globs; empty = any public domain). */
  domainAllow: string[];
  /** Operator domain denylist (BROWSER_DOMAIN_DENY, comma-separated globs). */
  domainDeny: string[];
  /** Operator JavaScript policy (BROWSER_JS_POLICY = disabled | review | allowed, default allowed). */
  jsPolicy: JsPolicy;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadConfig(): PlaywrightConfig {
  const apiKey = required('MCP_API_KEY');
  assertStrongSecret('MCP_API_KEY', apiKey);
  return {
    mcpPort: parseInt(process.env['MCP_PORT'] ?? '3003', 10),
    apiKey,
    navTimeoutMs: parseInt(process.env['NAV_TIMEOUT_MS'] ?? '30000', 10),
    maxSessions: parseInt(process.env['PLAYWRIGHT_MAX_SESSIONS'] ?? '4', 10),
    sessionIdleTimeoutMs: parseInt(process.env['PLAYWRIGHT_SESSION_IDLE_TIMEOUT_MS'] ?? '1800000', 10),
    watchdogIntervalMs: parseInt(process.env['PLAYWRIGHT_WATCHDOG_INTERVAL_MS'] ?? '120000', 10),
    allowPrivateHosts: (process.env['BROWSER_ALLOW_PRIVATE_HOSTS'] ?? '').split(',').map(h => h.trim()).filter(Boolean),
    previewHostPattern: /^sandbox-[0-9a-f]{10}$/,
    observationMaxTextChars: parseInt(process.env['OBSERVATION_MAX_TEXT_CHARS'] ?? '12000', 10),
    observationLabelMaxChars: parseInt(process.env['OBSERVATION_LABEL_MAX_CHARS'] ?? '100', 10),
    observationMaxElements: parseInt(process.env['OBSERVATION_MAX_ELEMENTS'] ?? '300', 10),
    domainAllow: parsePatternList(process.env['BROWSER_DOMAIN_ALLOW']),
    domainDeny: parsePatternList(process.env['BROWSER_DOMAIN_DENY']),
    jsPolicy: parseJsPolicy(process.env['BROWSER_JS_POLICY'], 'allowed'),
  };
}

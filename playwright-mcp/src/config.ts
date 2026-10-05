import 'dotenv/config';
import { parseJsPolicy, parsePatternList, type JsPolicy } from './policy.js';

export interface PlaywrightConfig {
  mcpPort: number;
  apiKey: string;
  /** Base URL of the local OpenAI-compatible model for quarantine extraction.
   * Example: http://192.168.1.100:11434/v1 (LM Studio / Ollama)
   */
  quarantineModelUrl: string;
  /** Model ID to use for quarantine extraction. Should be a fast, capable model.
   * Example: llama-3.1-8b-instruct, phi-3-medium, etc.
   */
  quarantineModel: string;
  /** Max characters of raw page text to pass to the quarantine model. Default 80000. */
  quarantineMaxInputChars: number;
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
  /** Max chars of the per-step structured observation passed to the quarantine model.
   * Smaller than quarantineMaxInputChars since observations are structured, not raw text. */
  observationMaxInputChars: number;
  /** Private hostnames/IPs the browser MAY reach (explicit opt-in; default none). Comma-separated in BROWSER_ALLOW_PRIVATE_HOSTS. */
  allowPrivateHosts: string[];
  /** Use the local quarantine model for browse_url extraction (QUARANTINE_EXTRACT_ENABLED, default true).
   * Its output is schema-validated; on failure the deterministic extract is returned instead. */
  quarantineExtractEnabled: boolean;
  /** Add an optional quarantine-model summary to browser observations (OBSERVATION_QUARANTINE_ENABLED,
   * default false). The element table and page text never depend on it. */
  observationQuarantineEnabled: boolean;
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
  return {
    mcpPort: parseInt(process.env['MCP_PORT'] ?? '3003', 10),
    apiKey: required('MCP_API_KEY'),
    quarantineModelUrl: process.env['QUARANTINE_MODEL_URL'] ?? 'http://host.docker.internal:11434/v1',
    quarantineModel: process.env['QUARANTINE_MODEL'] ?? 'llama-3.1-8b-instruct',
    quarantineMaxInputChars: parseInt(process.env['QUARANTINE_MAX_INPUT_CHARS'] ?? '80000', 10),
    navTimeoutMs: parseInt(process.env['NAV_TIMEOUT_MS'] ?? '30000', 10),
    maxSessions: parseInt(process.env['PLAYWRIGHT_MAX_SESSIONS'] ?? '4', 10),
    sessionIdleTimeoutMs: parseInt(process.env['PLAYWRIGHT_SESSION_IDLE_TIMEOUT_MS'] ?? '1800000', 10),
    watchdogIntervalMs: parseInt(process.env['PLAYWRIGHT_WATCHDOG_INTERVAL_MS'] ?? '120000', 10),
    observationMaxInputChars: parseInt(process.env['OBSERVATION_MAX_INPUT_CHARS'] ?? '40000', 10),
    allowPrivateHosts: (process.env['BROWSER_ALLOW_PRIVATE_HOSTS'] ?? '').split(',').map(h => h.trim()).filter(Boolean),
    quarantineExtractEnabled: bool(process.env['QUARANTINE_EXTRACT_ENABLED'], true),
    observationQuarantineEnabled: bool(process.env['OBSERVATION_QUARANTINE_ENABLED'], false),
    observationMaxTextChars: parseInt(process.env['OBSERVATION_MAX_TEXT_CHARS'] ?? '12000', 10),
    observationLabelMaxChars: parseInt(process.env['OBSERVATION_LABEL_MAX_CHARS'] ?? '100', 10),
    observationMaxElements: parseInt(process.env['OBSERVATION_MAX_ELEMENTS'] ?? '300', 10),
    domainAllow: parsePatternList(process.env['BROWSER_DOMAIN_ALLOW']),
    domainDeny: parsePatternList(process.env['BROWSER_DOMAIN_DENY']),
    jsPolicy: parseJsPolicy(process.env['BROWSER_JS_POLICY'], 'allowed'),
  };
}

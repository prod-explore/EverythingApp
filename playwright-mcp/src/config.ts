import 'dotenv/config';

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
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): PlaywrightConfig {
  return {
    mcpPort: parseInt(process.env['MCP_PORT'] ?? '3003', 10),
    apiKey: required('MCP_API_KEY'),
    quarantineModelUrl: process.env['QUARANTINE_MODEL_URL'] ?? 'http://host.docker.internal:11434/v1',
    quarantineModel: process.env['QUARANTINE_MODEL'] ?? 'llama-3.1-8b-instruct',
    quarantineMaxInputChars: parseInt(process.env['QUARANTINE_MAX_INPUT_CHARS'] ?? '80000', 10),
    navTimeoutMs: parseInt(process.env['NAV_TIMEOUT_MS'] ?? '30000', 10),
  };
}

import 'dotenv/config';
import { assertStrongSecret } from './secret-check.js';

export interface Config {
  supervisorUrl: string;
  mcpPort: number;
  sandboxTimeoutMs: number;
  autoApproveTools: string[];
  apiKey: string;
  /** Bearer token the sandbox-supervisor requires (SUPERVISOR_TOKEN). */
  supervisorToken?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  const apiKey = required('MCP_API_KEY');
  assertStrongSecret('MCP_API_KEY', apiKey);
  const supervisorToken = process.env['SUPERVISOR_TOKEN'] || undefined;
  assertStrongSecret('SUPERVISOR_TOKEN', supervisorToken);
  return {
    supervisorUrl: process.env['SUPERVISOR_URL'] ?? 'http://localhost:3001',
    mcpPort: parseInt(process.env['MCP_PORT'] ?? '3002', 10),
    sandboxTimeoutMs: parseInt(process.env['SANDBOX_TIMEOUT_MS'] ?? '30000', 10),
    autoApproveTools: (process.env['AUTO_APPROVE_TOOLS'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    apiKey,
    supervisorToken,
  };
}

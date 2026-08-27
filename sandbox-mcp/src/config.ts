import 'dotenv/config';

export interface Config {
  supervisorUrl: string;
  mcpPort: number;
  sandboxTimeoutMs: number;
  autoApproveTools: string[];
  apiKey: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    supervisorUrl: process.env['SUPERVISOR_URL'] ?? 'http://localhost:3001',
    mcpPort: parseInt(process.env['MCP_PORT'] ?? '3002', 10),
    sandboxTimeoutMs: parseInt(process.env['SANDBOX_TIMEOUT_MS'] ?? '30000', 10),
    autoApproveTools: (process.env['AUTO_APPROVE_TOOLS'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    apiKey: required('MCP_API_KEY'),
  };
}

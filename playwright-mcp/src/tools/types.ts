export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }], isError: true };
}

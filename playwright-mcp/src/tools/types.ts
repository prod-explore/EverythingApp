export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(text: string, structured?: Record<string, unknown>): ToolTextResult {
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

export function fail(text: string, structured?: Record<string, unknown>): ToolTextResult {
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured, isError: true }
    : { content: [{ type: 'text', text }], isError: true };
}

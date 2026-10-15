/** ~3k tokens. Head and tail are kept, the middle is dropped (the stored result is the truncated one); override with TOOL_OUTPUT_MAX_CHARS. */
const DEFAULT_MAX_LENGTH = Number(process.env['TOOL_OUTPUT_MAX_CHARS']) > 0 ? Number(process.env['TOOL_OUTPUT_MAX_CHARS']) : 12_000;

export interface TruncationResult {
  truncated: string;
  wasTruncated: boolean;
}

/**
 * Truncates tool output for the model context. Keeps the first and last
 * portions so the model sees both the beginning (command, headers) and the
 * end (result, summary line) of long outputs. Only this truncated text is
 * kept: it is what the model sees, what the database stores and what the UI shows.
 */
export function truncateToolOutput(
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): TruncationResult {
  if (text.length <= maxLength) {
    return { truncated: text, wasTruncated: false };
  }
  const keepEach = Math.floor((maxLength - 120) / 2);
  const head = text.slice(0, keepEach);
  const tail = text.slice(-keepEach);
  const removed = text.length - keepEach * 2;
  return {
    truncated: `${head}\n\n[…${removed.toLocaleString('en-US')} characters truncated from the middle…]\n\n${tail}`,
    wasTruncated: true,
  };
}

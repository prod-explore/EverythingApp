const DEFAULT_MAX_LENGTH = 30_000;

export interface TruncationResult {
  truncated: string;
  wasTruncated: boolean;
  originalLength: number;
}

/**
 * Truncates tool output for the model context. Keeps the first and last
 * portions so the model sees both the beginning (command, headers) and the
 * end (result, summary line) of long outputs. The full output is stored
 * separately by the server for the UI to display on demand.
 */
export function truncateToolOutput(
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): TruncationResult {
  if (text.length <= maxLength) {
    return { truncated: text, wasTruncated: false, originalLength: text.length };
  }
  const keepEach = Math.floor((maxLength - 120) / 2);
  const head = text.slice(0, keepEach);
  const tail = text.slice(-keepEach);
  const removed = text.length - keepEach * 2;
  return {
    truncated: `${head}\n\n[…truncated ${removed.toLocaleString()} characters from middle — full output available in the UI…]\n\n${tail}`,
    wasTruncated: true,
    originalLength: text.length,
  };
}

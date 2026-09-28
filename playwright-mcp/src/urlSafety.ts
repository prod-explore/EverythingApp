/** Allowlist of URL schemes. Only http(s) allowed — no file:, data:, javascript:, etc. */
export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

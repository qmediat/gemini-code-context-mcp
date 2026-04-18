/**
 * Safe partial-key preview for logging and UI.
 *
 * Never logs the full API key. Format: `AIza...xyz9` (first 4 + last 4 chars).
 * Keys shorter than 10 chars return `***` to avoid leaking weak values.
 */

export function fingerprint(apiKey: string | undefined | null): string {
  if (!apiKey || apiKey.length < 10) return '***';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

import { readFileSync } from 'node:fs';
import type { Credentials } from './types';

/**
 * Read and parse the Claude credentials file. Returns null on any failure
 * (missing file, invalid JSON from a partial mid-write read, or missing/wrong
 * fields) so the caller can skip the event and wait for the next write.
 */
export function readCredentials(path: string): Credentials | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;

  if (!oauth || typeof oauth.accessToken !== 'string' || typeof oauth.expiresAt !== 'number') {
    return null;
  }

  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
}

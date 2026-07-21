import { readFileSync } from 'node:fs';
import type { Credentials } from './types';
import { jwtExpMs } from '../jwt';

/**
 * Read and parse ~/.codex/auth.json into the source-agnostic Credentials shape. The
 * access token is a JWT whose `exp` claim carries expiry (no separate field like
 * Claude's expiresAt). Returns null on any failure — missing file, invalid JSON from
 * a partial mid-write read, missing tokens.access_token, or a JWT with no decodable
 * numeric `exp` — so the caller can skip the event and wait for the next write.
 */
export function readCodexCredentials(path: string): Credentials | null {
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

  // Scope guard: this channel handles ChatGPT-plan sign-in only. An api_key-mode file
  // has no chatgpt JWT to inject; treat it as unreadable so startup fails loudly rather
  // than silently mis-injecting.
  if ((parsed as { auth_mode?: unknown } | null)?.auth_mode !== 'chatgpt') return null;

  const tokens = (parsed as { tokens?: unknown } | null)?.tokens as
    | { access_token?: unknown }
    | undefined;
  if (!tokens || typeof tokens.access_token !== 'string') return null;

  const expiresAt = jwtExpMs(tokens.access_token);
  if (expiresAt === null) return null;

  return { accessToken: tokens.access_token, expiresAt };
}

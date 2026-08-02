import { execa } from 'execa';
import type { NudgeResult } from './types';

/** Minimal prompt whose only purpose is to make the CLI perform a token refresh. */
const NUDGE_PROMPT = 'Reply with the single word: ok';

/**
 * Nudge the official `claude` CLI to refresh the OAuth token. We never touch the
 * refresh token ourselves — the CLI stays the sole authority over credentials.json.
 * Success here means the process exited 0; whether the token actually advanced is
 * determined by the watcher observing a new expiresAt.
 */
export async function nudgeRefresh(): Promise<NudgeResult> {
  try {
    await execa('claude', ['-p', NUDGE_PROMPT, '--model', 'haiku']);
    return { ok: true, stderr: '' };
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    return { ok: false, stderr };
  }
}

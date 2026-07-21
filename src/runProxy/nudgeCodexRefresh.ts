import { execa } from 'execa';
import type { NudgeResult } from './types';

/** Minimal prompt whose only purpose is to make the CLI perform a token refresh. */
const NUDGE_PROMPT = 'Reply with the single word: ok';

/**
 * Nudge the official `codex` CLI to refresh its token by running a trivial headless
 * `codex exec` on the HOST (over the host's own network path — never the VM's proxied
 * traffic, which the placeholder-only gate would block). We never touch the refresh
 * token ourselves; the CLI stays the sole authority over auth.json. Success here means
 * the process exited 0; whether the token actually advanced is observed by the watcher
 * seeing a new JWT exp.
 *
 * `stdin: 'ignore'` is mandatory: `codex exec` peeks at stdin ("Reading additional
 * input from stdin...") even with a prompt argument, and run-proxy's own long-lived
 * stdin must never let a nudge hang waiting on it.
 */
export async function nudgeCodexRefresh(): Promise<NudgeResult> {
  try {
    await execa('codex', ['exec', NUDGE_PROMPT], { stdin: 'ignore' });
    return { ok: true, stderr: '' };
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    return { ok: false, stderr };
  }
}

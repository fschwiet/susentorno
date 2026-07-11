import { execa } from 'execa';

/**
 * Terminates a spawned process along with any processes it spawned.
 *
 * `child.kill(signal)` only ever reaches the immediate child. On Windows that's
 * a forceful TerminateProcess of just that one process — if the CLI it's running
 * (e.g. `docker.exe`) re-execs a plugin binary (e.g. `docker-compose.exe`) as its
 * own child, the plugin survives, keeps its inherited stdout pipe open, and the
 * parent process waiting on that pipe to close (`await child`) hangs forever.
 * `taskkill /t` walks the process tree by parent PID and kills every descendant.
 */
export async function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(pid), '/t', '/f'], { reject: false });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // Process group may already be gone.
  }
}

import { execa } from 'execa';
import { createInterface } from 'node:readline';
import net from 'node:net';

export interface McpChildHandle {
  pid: number;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
}

/**
 * Spawn `command` through a shell (its {ip}/{port}/etc. substitutions are already
 * baked in by the caller — see mcpServers.ts). `reject: false` means a non-zero exit
 * resolves rather than rejects the underlying promise, so both branches of `.then`
 * funnel into the same onExit callback.
 */
export function spawnMcpServer(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> },
  onLine: (line: string) => void,
): McpChildHandle {
  const child = execa(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    buffer: false,
    reject: false,
    // killProcessTree's non-Windows path signals the whole process group
    // (`process.kill(-pid, signal)`), which only reaches this child's own spawned
    // descendants (e.g. a shell-wrapped command re-execing the real server) if the
    // child is its own group leader — same requirement logStream.ts's execa call
    // already satisfies for the docker compose logs child.
    detached: process.platform !== 'win32',
  });

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', onLine);
  }

  if (child.pid === undefined) throw new Error(`failed to spawn MCP server: ${command}`);
  const pid = child.pid;

  return {
    pid,
    onExit: (cb) => {
      void child.then(
        (result) => cb(result.exitCode ?? null, result.signal ?? null),
        () => cb(null, null),
      );
    },
  };
}

/** Polls a TCP connect to 127.0.0.1:port every 250ms until it succeeds or timeoutMs elapses. */
export function probeMcpReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

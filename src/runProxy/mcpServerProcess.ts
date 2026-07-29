import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import type { McpServer } from '../mcpServers';
import { sleep } from './abortableSleep';
import { killProcessTree } from './killProcessTree';
import type { WaitResult } from './waitColorReady';

export interface McpServerHandle {
  readonly pid: number;
  readonly port: number;
  /** Resolves false once the process has exited, true while it is still running. */
  isAlive: () => Promise<boolean>;
  /** Registers a callback fired exactly once when the process exits, whether crashed or stopped. */
  onExit: (cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void) => void;
}

/** Substitutes the `{ip}`/`{port}` placeholders a declared server's `command` must contain. */
export function substituteIpPort(command: string, ip: string, port: number): string {
  return command.split('{ip}').join(ip).split('{port}').join(String(port));
}

/**
 * Launches a declared Host MCP server through the host's default shell (PowerShell on
 * Windows), with `{ip}`/`{port}` substituted so the server binds loopback on its
 * assigned port. Stdout and stderr are drained line-by-line into `onOutput` so a
 * verbose child can never block on an unread pipe (issue #60).
 */
export function launchMcpServer(
  server: McpServer,
  port: number,
  onOutput: (line: string) => void,
): McpServerHandle {
  const command = substituteIpPort(server.command, '127.0.0.1', port);
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
    cwd: server.workingDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (child.stdout) createInterface({ input: child.stdout }).on('line', onOutput);
  if (child.stderr) createInterface({ input: child.stderr }).on('line', onOutput);

  let exited = false;
  const exitCbs: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  child.on('exit', (code, signal) => {
    exited = true;
    for (const cb of exitCbs) cb({ code, signal });
  });

  return {
    pid: child.pid!,
    port,
    isAlive: async () => !exited,
    onExit: (cb) => {
      exitCbs.push(cb);
    },
  };
}

/** One probe of a loopback port; true iff a TCP connection is accepted. */
function tcpProbeOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll a Host MCP server's assigned loopback port until it accepts a TCP connection
 * (`{ ready: true }`), the process exits (`reason: 'exited'` — reported fast, no need
 * to wait out the timeout), the signal aborts, or the deadline passes
 * (`reason: 'timeout'`). Mirrors `waitColorReady`'s shape and polling strategy.
 */
export async function waitMcpServerReady(
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
  isAlive: () => Promise<boolean>,
  sleepMs = 250,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tcpProbeOnce(port)) return { ready: true };
    if (signal.aborted) return { ready: false, reason: 'timeout' };
    if (!(await isAlive())) return { ready: false, reason: 'exited' };
    if (Date.now() >= deadline) return { ready: false, reason: 'timeout' };
    await sleep(sleepMs, signal);
  }
}

/** Stop a launched Host MCP server via the existing process-tree termination. */
export async function stopMcpServer(handle: McpServerHandle): Promise<void> {
  await killProcessTree(handle.pid, 'SIGTERM');
}

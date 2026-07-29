import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  substituteIpPort,
  launchMcpServer,
  waitMcpServerReady,
  stopMcpServer,
  type McpServerHandle,
} from '../../src/runProxy/mcpServerProcess';
import { allocateLoopbackPort } from '../../src/runProxy/allocateColorPorts';
import type { McpServer } from '../../src/mcpServers';

const FIXTURES = fileURLToPath(new URL('../fixtures/mcpServer/', import.meta.url));

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeServer(scriptName: string, extraArgs: string[] = []): McpServer {
  const script = `${FIXTURES}${scriptName}`;
  return {
    name: 'fixture-server',
    url: 'https://fixture.mcp.internal/mcp',
    host: 'fixture.mcp.internal',
    command: `node "${script}" {ip} {port} ${extraArgs.join(' ')}`.trim(),
  };
}

describe('substituteIpPort', () => {
  it('replaces {ip} and {port} placeholders literally', () => {
    expect(substituteIpPort('node server.js {ip} {port}', '127.0.0.1', 5000)).toBe(
      'node server.js 127.0.0.1 5000',
    );
  });

  it('replaces every occurrence when a placeholder appears more than once', () => {
    expect(substituteIpPort('--host {ip} --advertise {ip}:{port}', '127.0.0.1', 5000)).toBe(
      '--host 127.0.0.1 --advertise 127.0.0.1:5000',
    );
  });
});

describe('Host MCP server process supervision', () => {
  const handles: McpServerHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop()!;
      await stopMcpServer(handle).catch(() => {});
    }
  });

  it('launches the command through the shell, binds the assigned port, and becomes ready', async () => {
    const port = await allocateLoopbackPort();
    const lines: string[] = [];
    const handle = launchMcpServer(makeServer('listener.mjs'), port, (line) => lines.push(line));
    handles.push(handle);

    const result = await waitMcpServerReady(
      port,
      5000,
      new AbortController().signal,
      handle.isAlive,
    );

    expect(result).toEqual({ ready: true });
    await waitFor(() => lines.some((l) => l.includes('listening on 127.0.0.1')), 2000);
  }, 10000);

  it('reports exited when the process exits before binding the port', async () => {
    const port = await allocateLoopbackPort();
    const handle = launchMcpServer(makeServer('exitImmediately.mjs'), port, () => {});
    handles.push(handle);

    const result = await waitMcpServerReady(
      port,
      5000,
      new AbortController().signal,
      handle.isAlive,
    );

    expect(result).toEqual({ ready: false, reason: 'exited' });
  }, 10000);

  it('reports timeout when the process never binds within the deadline', async () => {
    const port = await allocateLoopbackPort();
    const handle = launchMcpServer(makeServer('neverBinds.mjs'), port, () => {});
    handles.push(handle);

    const result = await waitMcpServerReady(
      port,
      300,
      new AbortController().signal,
      handle.isAlive,
    );

    expect(result).toEqual({ ready: false, reason: 'timeout' });
  }, 10000);

  it('stopMcpServer terminates the launched process', async () => {
    const port = await allocateLoopbackPort();
    const handle = launchMcpServer(makeServer('listener.mjs'), port, () => {});
    await waitMcpServerReady(port, 5000, new AbortController().signal, handle.isAlive);
    expect(isAlivePid(handle.pid)).toBe(true);

    await stopMcpServer(handle);
    await waitFor(() => !isAlivePid(handle.pid), 5000);

    expect(isAlivePid(handle.pid)).toBe(false);
  }, 10000);

  it('fires onExit exactly once with the exit info when the process exits', async () => {
    const port = await allocateLoopbackPort();
    const handle = launchMcpServer(makeServer('exitImmediately.mjs'), port, () => {});
    handles.push(handle);

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => handle.onExit(resolve),
    );

    expect(exitInfo.code).not.toBe(0);
  }, 10000);
});

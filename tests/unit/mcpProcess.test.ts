import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { spawnMcpServer, probeMcpReady } from '../../src/runHosting/mcpProcess';
import { killProcessTree } from '../../src/runHosting/killProcessTree';

describe('spawnMcpServer', () => {
  it('spawns the shell command and streams its stdout lines', async () => {
    const lines: string[] = [];
    const isWin = process.platform === 'win32';
    const command = isWin ? 'echo hello-mcp' : 'echo hello-mcp';
    const handle = spawnMcpServer(command, {}, (line) => lines.push(line));
    try {
      await new Promise<void>((resolve) => handle.onExit(() => resolve()));
      expect(lines.some((l) => l.includes('hello-mcp'))).toBe(true);
    } finally {
      await killProcessTree(handle.pid, 'SIGTERM').catch(() => {});
    }
  });

  it('applies cwd and env to the spawned process', async () => {
    const lines: string[] = [];
    const isWin = process.platform === 'win32';
    const command = isWin ? 'echo %MCP_TEST_VAR%' : 'echo $MCP_TEST_VAR';
    const handle = spawnMcpServer(command, { env: { MCP_TEST_VAR: 'from-env' } }, (line) =>
      lines.push(line),
    );
    try {
      await new Promise<void>((resolve) => handle.onExit(() => resolve()));
      expect(lines.some((l) => l.includes('from-env'))).toBe(true);
    } finally {
      await killProcessTree(handle.pid, 'SIGTERM').catch(() => {});
    }
  });

  it('reports exit via onExit', async () => {
    const handle = spawnMcpServer(process.platform === 'win32' ? 'exit 0' : 'exit 0', {}, () => {});
    const result = await new Promise<{ code: number | null }>((resolve) =>
      handle.onExit((code) => resolve({ code })),
    );
    expect(result.code).toBe(0);
  });
});

describe('probeMcpReady', () => {
  let server: net.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('resolves true once something is listening on the port', async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probeMcpReady(port, 2000, new AbortController().signal)).toBe(true);
  });

  it('resolves false when nothing is listening before the timeout', async () => {
    // 39217 is not bound by this test suite; a short timeout keeps this test fast.
    expect(await probeMcpReady(39217, 300, new AbortController().signal)).toBe(false);
  });

  it('gives up as soon as the signal aborts, instead of polling out its timeout', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    // 39218 is not bound by this test suite; the long timeout is what an un-aborted
    // probe would sit on, holding the whole process open after run-hosting shut down.
    const probe = probeMcpReady(39218, 60_000, controller.signal);
    controller.abort();

    expect(await probe).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

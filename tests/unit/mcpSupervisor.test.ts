import { describe, it, expect, vi } from 'vitest';
import { startMcpServers, type McpSupervisorDeps, type McpServerSpec } from '../../src/runProxy/mcpSupervisor';

function spec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return { name: 'fs', hostname: 'fs.internal', port: 1234, command: 'run-fs', ...overrides };
}

function makeDeps(overrides: Partial<McpSupervisorDeps> = {}): {
  deps: McpSupervisorDeps;
  exitCallbacks: Map<string, (code: number | null, signal: string | null) => void>;
  resolveProbe: Map<string, (ready: boolean) => void>;
  pids: Map<string, number>;
} {
  const exitCallbacks = new Map<string, (code: number | null, signal: string | null) => void>();
  const resolveProbe = new Map<string, (ready: boolean) => void>();
  const pids = new Map<string, number>();
  let nextPid = 1000;

  const deps: McpSupervisorDeps = {
    spawn: vi.fn((s: McpServerSpec) => {
      const pid = nextPid++;
      pids.set(s.name, pid);
      return { pid, onExit: (cb: (code: number | null, signal: string | null) => void) => exitCallbacks.set(s.name, cb) };
    }),
    probeReady: vi.fn(
      (port: number) =>
        new Promise<boolean>((resolve) => {
          resolveProbe.set(String(port), resolve);
        }),
    ),
    killProcessTree: vi.fn().mockResolvedValue(undefined),
    onLine: vi.fn(),
    onReady: vi.fn(),
    onFatal: vi.fn(),
    now: () => 0,
    readyTimeoutMs: 60_000,
    ...overrides,
  };
  return { deps, exitCallbacks, resolveProbe, pids };
}

describe('startMcpServers', () => {
  it('spawns every declared server and reports readiness once its probe succeeds', async () => {
    // Three now() calls in order: 'fs' spawn start, 'git' spawn start (both happen
    // synchronously in the launch loop before either probe resolves), then 'fs's
    // elapsed-time read when its probe resolves below.
    const { deps, resolveProbe } = makeDeps({
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(500),
    });
    startMcpServers(
      [spec({ name: 'fs', port: 1111 }), spec({ name: 'git', hostname: 'git.internal', port: 2222 })],
      deps,
    );

    expect(deps.spawn).toHaveBeenCalledTimes(2);
    resolveProbe.get('1111')!(true);
    await Promise.resolve(); // let probeReady's .then() microtask run
    expect(deps.onReady).toHaveBeenCalledWith('fs', 500);
  });

  it('calls onFatal exactly once when a server exits, regardless of other servers', () => {
    const { deps, exitCallbacks } = makeDeps();
    startMcpServers([spec({ name: 'fs' }), spec({ name: 'git', hostname: 'git.internal', port: 2 })], deps);

    exitCallbacks.get('fs')!(1, null);
    exitCallbacks.get('git')!(1, null);

    expect(deps.onFatal).toHaveBeenCalledTimes(1);
    expect(deps.onFatal).toHaveBeenCalledWith(expect.stringContaining("mcp server 'fs' exited"));
  });

  it('calls onFatal when a probe never succeeds and does not call onReady for it', async () => {
    const { deps, resolveProbe } = makeDeps();
    startMcpServers([spec({ port: 3333 })], deps);

    resolveProbe.get('3333')!(false);
    await Promise.resolve();

    expect(deps.onFatal).toHaveBeenCalledWith(expect.stringContaining('did not become ready within 60000ms'));
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('stopAll kills every spawned process via killProcessTree', async () => {
    const { deps, pids } = makeDeps();
    const handle = startMcpServers([spec({ name: 'fs' }), spec({ name: 'git', hostname: 'git.internal', port: 2 })], deps);

    await handle.stopAll();

    expect(deps.killProcessTree).toHaveBeenCalledWith(pids.get('fs'), 'SIGTERM');
    expect(deps.killProcessTree).toHaveBeenCalledWith(pids.get('git'), 'SIGTERM');
  });
});

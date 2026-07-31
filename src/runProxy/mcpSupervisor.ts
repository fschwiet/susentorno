export interface McpServerSpec {
  name: string;
  hostname: string;
  port: number;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpChildHandle {
  pid: number;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
}

export interface McpSupervisorDeps {
  spawn: (spec: McpServerSpec, onLine: (line: string) => void) => McpChildHandle;
  probeReady: (port: number, timeoutMs: number) => Promise<boolean>;
  killProcessTree: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  onLine: (name: string, line: string) => void;
  onReady: (name: string, elapsedMs: number) => void;
  /** Called at most once total, across every server, for the first readiness-timeout or exit. */
  onFatal: (message: string) => void;
  now: () => number;
  readyTimeoutMs: number;
}

export interface McpSupervisorHandle {
  stopAll: () => Promise<void>;
}

/**
 * Launches every declared server in parallel. Readiness (a TCP-connect probe) and
 * exit are both supervised for the process's entire remaining lifetime, not just
 * until the probe first succeeds — either signal, for any server, at any time,
 * fires onFatal exactly once.
 */
export function startMcpServers(specs: McpServerSpec[], deps: McpSupervisorDeps): McpSupervisorHandle {
  let fatalFired = false;
  const pids: number[] = [];

  const fireFatal = (message: string): void => {
    if (fatalFired) return;
    fatalFired = true;
    deps.onFatal(message);
  };

  for (const spec of specs) {
    // A synchronous spawn failure for an earlier spec already fired the one-shot
    // fatal and started teardown; don't launch further servers into a stack that's
    // already shutting down.
    if (fatalFired) break;
    const startedAt = deps.now();
    let handle: McpChildHandle;
    try {
      handle = deps.spawn(spec, (line) => deps.onLine(spec.name, line));
    } catch (err) {
      fireFatal(`mcp server '${spec.name}' failed to start: ${String(err)}`);
      continue;
    }
    pids.push(handle.pid);

    let exited = false;
    handle.onExit((code, signal) => {
      exited = true;
      fireFatal(`mcp server '${spec.name}' exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    });

    void deps.probeReady(spec.port, deps.readyTimeoutMs).then((ready) => {
      if (exited || fatalFired) return;
      if (ready) {
        deps.onReady(spec.name, deps.now() - startedAt);
      } else {
        fireFatal(`mcp server '${spec.name}' did not become ready within ${deps.readyTimeoutMs}ms`);
      }
    });
  }

  return {
    stopAll: async () => {
      await Promise.all(pids.map((pid) => deps.killProcessTree(pid, 'SIGTERM').catch(() => {})));
    },
  };
}

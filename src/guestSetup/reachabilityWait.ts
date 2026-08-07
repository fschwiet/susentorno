import type { TcpConnector } from './tcpConnect';

export interface ReachabilityWaitOptions {
  getCandidates: () => string[] | Promise<string[]>;
  connect: TcpConnector;
  port?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (elapsedMs: number) => void;
}

export type ReachabilityResult = { reachable: true; address: string } | { reachable: false };

/**
 * Address discovery and reachability checking are the same loop: each tick
 * asks getCandidates() for whatever's currently known (prompted address,
 * Hyper-V-discovered addresses, or both — the caller decides), and tries a
 * raw TCP connect against each in order, returning the first that answers.
 */
export async function waitForReachable(opts: ReachabilityWaitOptions): Promise<ReachabilityResult> {
  const port = opts.port ?? 22;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();

  for (;;) {
    const candidates = await opts.getCandidates();
    for (const address of candidates) {
      if (await opts.connect(address, port, connectTimeoutMs)) {
        return { reachable: true, address };
      }
    }
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) return { reachable: false };
    opts.onProgress?.(elapsed);
    await sleep(pollIntervalMs);
  }
}

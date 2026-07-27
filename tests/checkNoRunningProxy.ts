import net from 'node:net';

/** Resolve true if a TCP connect to 127.0.0.1:<port> is accepted. */
function loopbackPortAccepts(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Guard (host-side, not WSL): `run-proxy` and the proxy-stack/guest suites both
// manage the same docker-compose Envoy stack, and startProxyStack REPLACES any
// running proxy container. With run-proxy live the two clobber each other — the
// suite's Envoy is torn down underneath it, the Envoy-reachability guard in
// guest.test.ts then reports '000' and blames Docker WSL integration, and run-proxy
// is left serving :80/:443 with no backend (so the real VM silently loses egress
// too). The symptom lands a long way from the cause, so check it up front.
//
// run-proxy's gateway holds BOTH loopback ports; requiring both keeps an
// unrelated :80 listener (IIS, some dev server) from tripping this.
export async function checkNoRunningProxy(): Promise<void> {
  const [http, https] = await Promise.all([loopbackPortAccepts(80), loopbackPortAccepts(443)]);
  if (http && https) {
    throw new Error(
      `Something is already serving both 127.0.0.1:80 and 127.0.0.1:443 — almost certainly ` +
        `'configamatron run-proxy'. It manages the same Envoy containers this suite does, and ` +
        `the two will clobber each other. Stop run-proxy and re-run; start it again afterwards ` +
        `to restore the VM's proxy.`,
    );
  }
}

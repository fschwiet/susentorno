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

/**
 * The strict variant of checkNoRunningProxy, for the guest tier only.
 *
 * checkNoRunningProxy deliberately requires BOTH ports before failing, so an
 * unrelated :80 listener does not trip the proxy-stack suites — which run on
 * 18080/18443 and genuinely do not care. This tier binds the real :80/:443, so
 * that tolerance becomes a defect here: IIS holding :80 alone would sail past
 * the guard and fail inside startGateway as an opaque EADDRINUSE, which is the
 * "symptom lands a long way from the cause" failure the original comment says
 * it was written to prevent.
 *
 * Two messages, because the two causes have different fixes.
 */
export function describeHeldGatewayPorts(httpHeld: boolean, httpsHeld: boolean): string | null {
  if (httpHeld && httpsHeld) {
    return (
      'Something is already serving both 127.0.0.1:80 and 127.0.0.1:443 — almost certainly ' +
      "'susentorno run-hosting'. It manages the same Envoy containers this suite does, and the " +
      'two will clobber each other. Stop run-hosting and re-run; start it again afterwards to ' +
      "restore the guest's proxy."
    );
  }
  if (httpHeld || httpsHeld) {
    const port = httpHeld ? '127.0.0.1:80' : '127.0.0.1:443';
    return (
      `Something is already serving ${port}. The guest tier binds the real ` +
      ':80 and :443 (the guest resolves every name to the host and connects on the port from ' +
      'the URL), so it cannot start while that port is taken. This is usually IIS ("World Wide ' +
      'Web Publishing Service") or a local dev server — run ' +
      `\`Get-NetTCPConnection -LocalPort ${httpHeld ? 80 : 443} -State Listen\` to find the ` +
      'owning process, stop it, and re-run.'
    );
  }
  return null;
}

export async function checkGatewayPortsFree(): Promise<void> {
  const [http, https] = await Promise.all([loopbackPortAccepts(80), loopbackPortAccepts(443)]);
  const message = describeHeldGatewayPorts(http, https);
  if (message) throw new Error(message);
}

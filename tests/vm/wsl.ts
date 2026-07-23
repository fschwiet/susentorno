import { execa } from 'execa';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const harnessWinDir = fileURLToPath(new URL('./harness', import.meta.url));
let harnessDir: string | undefined;

const wslArgs = ['-u', 'root', '-e'];

// The harness manages bridges, taps, and QEMU, and WSL's default user cannot
// sudo non-interactively — so everything WSL-side runs as root.
export function wslExec(script: string, opts: { reject?: boolean } = {}) {
  return execa('wsl.exe', [...wslArgs, 'bash', '-c', script], {
    reject: opts.reject ?? true,
    all: true,
  });
}

// Guard: every call in this file invokes `wsl.exe` without `-d`, so it always
// runs whatever distro is currently the WSL default. On a machine with no
// real Linux distro registered, Docker Desktop's own minimal `docker-desktop`
// distro (BusyBox-based — no bash, no apt) can end up default simply by being
// the only one registered, and every harness call then fails with
// `execvpe(bash) failed: No such file or directory`. Probe with `sh`, not
// `bash`, since bash's absence is exactly what we're checking for.
export async function checkWslDistro(): Promise<void> {
  const probe = await execa(
    'wsl.exe',
    [
      '-u',
      'root',
      '-e',
      'sh',
      '-c',
      'command -v bash >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && echo ok',
    ],
    { reject: false, all: true },
  );
  if (probe.stdout.trim() !== 'ok') {
    throw new Error(
      'WSL default distro is missing bash and/or apt-get, so the VM test harness cannot run ' +
        `(wsl.exe said: ${(probe.all || probe.stdout || '<no output>').trim()}).\n` +
        "This usually means no real Linux distro is registered, so Docker Desktop's own minimal " +
        "'docker-desktop' distro (BusyBox-based) is the WSL default. Check with: wsl -l -v\n" +
        'Fix:\n' +
        '  wsl --install -d Ubuntu\n' +
        "(then 'exit' if it left you in wsl)\n" +
        '  wsl --set-default Ubuntu\n',
    );
  }
}

// Guard: mirrored networking is required (see README.md's Development
// Prerequisites). Under NAT mode WSL cannot reach run-proxy's gateway at all
// — it is a plain Windows process on loopback, and only mirrored mode shares
// the Windows localhost with WSL. See
// docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md.
export async function checkWslMirroredNetworking(): Promise<void> {
  const mode = await wslExec('wslinfo --networking-mode', { reject: false });
  if (mode.stdout.trim() !== 'mirrored') {
    throw new Error(
      `WSL networking mode is '${mode.stdout.trim()}', not 'mirrored'. ` +
        `In %USERPROFILE%\\.wslconfig using powershell run\n ` +
        `  echo "\`n[wsl2]\`nnetworkingMode=mirrored\`n" >> ~/.wslconfig\n ` +
        `  wsl --shutdown\n` +
        `(Docker will be forced to restart since it runs in WSL).`,
    );
  }
}

// Guard: mirrored mode pools WSL's ports with Windows', and Windows' own
// Hyper-V Default Switch DHCP holds port 67 — dnsmasq's wildcard DHCP bind
// fails unless .wslconfig exempts the port from sharing (see README.md's
// Development Prerequisites). Probe the actual bind instead of parsing
// .wslconfig: that also catches the setting being present but not applied
// yet, or dropped by a future WSL update.
// exit=124: bind ok, timeout expired waiting for a packet (the normal case).
// exit=0: bind ok, a stray packet arrived within the second.
export async function checkWslDhcpPortIgnored(): Promise<void> {
  const probe = await wslExec('timeout 1 socat -u UDP4-RECVFROM:67 /dev/null 2>&1; echo exit=$?', {
    reject: false,
  });
  if (!/exit=(124|0)\b/.test(probe.stdout)) {
    throw new Error(
      `WSL cannot bind UDP 0.0.0.0:67, so dnsmasq's DHCP bind will fail (got: ${probe.all}). ` +
        `In %USERPROFILE%\\.wslconfig using powershell run\n ` +
        `  echo "\`n[experimental]\`nignoredPorts=67\`n" >> ~/.wslconfig\n ` +
        `  wsl --shutdown\n` +
        `(Docker will be forced to restart since it runs in WSL).`,
    );
  }
}

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

// Guard (host-side, not WSL): `run-proxy` and this suite both manage the same
// docker-compose Envoy stack, and startProxyStack REPLACES any running proxy
// container. With run-proxy live the two clobber each other — the suite's Envoy
// is torn down underneath it, the Envoy-reachability guard in vm.test.ts then
// reports '000' and blames Docker WSL integration, and run-proxy is left serving
// :80/:443 with no backend (so the real VM silently loses egress too). The
// symptom lands a long way from the cause, so check it up front.
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

export async function wslPath(winPath: string): Promise<string> {
  const { stdout } = await execa('wsl.exe', [
    ...wslArgs,
    'wslpath',
    '-a',
    winPath.replace(/\\/g, '/'),
  ]);
  return stdout.trim();
}

// Passes args as real argv entries (execa → wsl.exe → bash), so no layer
// re-parses quotes. A guest command like `curl -w '%{http_code}' ...` arrives
// at guest.sh as a single $3 and is only ever parsed by the guest's shell.
export async function harness(script: string, ...args: string[]) {
  harnessDir ??= await wslPath(harnessWinDir);
  return execa('wsl.exe', [...wslArgs, 'bash', `${harnessDir}/${script}`, ...args], { all: true });
}

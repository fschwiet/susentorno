import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { listScripts } from '../../src/guestSetup/listScripts';
import { mountShare } from '../../src/guestSetup/mountShare';
import { runPreScripts } from '../../src/guestSetup/runPreScripts';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { envRoot } from '../testEnvRoot';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { GUEST_USERNAME } from './autoinstall';
import { createHarnessRemoteExec, guestCapture } from './guestExec';
import { ISOLATION_NAME } from './hyperv/imageCache';
import { createTestGuest, destroyTestGuest, type TestGuest } from './hyperv/testGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';

const exec = createRealPowerShellExec();
const sharePath = join(envRoot, 'vm-shared-linux');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

let stack: ProxyStack;
let share: TestShare;
let guest: TestGuest;
let target: SshTarget;
let internalHostIp: string;

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  share = await createTestShare(exec, sharePath);
  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`fresh: ${internal.adapterAlias} has no IPv4 address`);
  internalHostIp = internal.address;
  guest = await createTestGuest(exec, 'fresh', internalSwitchName, internal, artifactsDir);
  target = { address: guest.address, username: GUEST_USERNAME };
}, 1_800_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'fresh').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  if (share) await removeTestShare(exec, sharePath).catch(() => {});
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('a fresh guest starting in the isolated phase', () => {
  it('took its default route from the DHCP lease alone', async () => {
    const { stdout } = await guestCapture(target, 'ip -4 route show default');
    expect(stdout).toContain(`default via ${internalHostIp}`);
    expect(stdout).toContain('proto dhcp');
  });

  it('took the host as its resolver from the DHCP lease alone', async () => {
    const { stdout } = await guestCapture(target, 'getent ahostsv4 example.com');
    expect(stdout.trim().split(/\s+/)[0]).toBe(internalHostIp);
  });

  it('has no in-guest DNS or DHCP unit doing any of it', async () => {
    const { stdout } = await guestCapture(
      target,
      'systemctl is-enabled systemd-networkd || true; systemctl is-active NetworkManager',
    );
    expect(stdout).toContain('masked');
    expect(stdout).toContain('active');
  });

  it('installs cifs-utils through the proxy with no general network access', async () => {
    const before = await guestCapture(
      target,
      'dpkg -s cifs-utils >/dev/null 2>&1 && echo installed',
    );
    expect(before.stdout).not.toContain('installed');
    await mountShare(createHarnessRemoteExec(target), {
      shareName: share.shareName,
      accountName: share.account,
      password: share.password,
      hostIp: internalHostIp,
      onStep: (message) => console.log(`fresh: mountShare — ${message}`),
    });
    const after = await guestCapture(
      target,
      'dpkg -s cifs-utils >/dev/null 2>&1 && echo installed',
    );
    expect(after.stdout).toContain('installed');
    const mounted = await guestCapture(
      target,
      `test -f /mnt/${share.shareName}/cert.pem && findmnt -no SOURCE /mnt/${share.shareName}`,
    );
    expect(mounted.stdout).toContain(`//${internalHostIp}/${share.shareName}`);
  }, 900_000);

  it('configure-network leaves the DHCP-supplied networking untouched', async () => {
    const scripts = listScripts(join(sharePath, 'pre-scripts')).filter(
      (script) => script.slug === 'configure-network',
    );
    expect(scripts).toHaveLength(1);
    await runPreScripts(createHarnessRemoteExec(target), {
      scripts,
      shareName: share.shareName,
      internalSwitchHostIp: internalHostIp,
    });
    const route = await guestCapture(target, 'ip -4 route show default');
    expect(route.stdout).toContain(`default via ${internalHostIp}`);
    expect(route.stdout).toContain('proto dhcp');
    const nat = await guestCapture(target, 'sudo iptables -t nat -S OUTPUT');
    expect(nat.stdout).not.toContain('DNAT');
    const dns = await guestCapture(target, 'getent ahostsv4 example.com');
    expect(dns.stdout.trim().split(/\s+/)[0]).toBe(internalHostIp);
  }, 900_000);
});

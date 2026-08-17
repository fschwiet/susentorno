import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { listScripts } from '../../src/guestSetup/listScripts';
import { mountShare } from '../../src/guestSetup/mountShare';
import { runPreScripts } from '../../src/guestSetup/runPreScripts';
import { isolateVmToSwitch } from '../../src/guestSetup/vmReconcile';
import { getVmIpAddresses } from '../../src/guestSetup/hyperVQueries';
import { waitForReachable } from '../../src/guestSetup/reachabilityWait';
import { realTcpConnect } from '../../src/guestSetup/tcpConnect';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import {
  startProxyStack,
  stopProxyStack,
  PLACEHOLDER_AUTH,
  REAL_AUTH,
  type ProxyStack,
} from '../proxyStack';
import { envRoot } from '../testEnvRoot';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { GUEST_USERNAME } from './autoinstall';
import { createHarnessRemoteExec, guestCapture } from './guestExec';
import { ISOLATION_NAME } from './hyperv/imageCache';
import {
  createTestGuest,
  destroyTestGuest,
  filterCandidateAddresses,
  type TestGuest,
} from './hyperv/testGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';

const exec = createRealPowerShellExec();
const sharePath = join(envRoot, 'vm-shared-linux');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

let stack: ProxyStack;
let share: TestShare;
let guest: TestGuest;
let target: SshTarget;
let internalHostIp: string;
let defaultSwitchHostIp: string;

async function waitForIsolatedAddress(vmName: string): Promise<string> {
  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`phases: ${internal.adapterAlias} has no IPv4 address`);
  const reachability = await waitForReachable({
    getCandidates: async () =>
      filterCandidateAddresses(await getVmIpAddresses(exec, vmName), internal),
    connect: realTcpConnect,
    timeoutMs: 600_000,
    onProgress: (ms) =>
      console.log(`phases: waiting for the isolated guest... (${Math.round(ms / 1000)}s)`),
  });
  if (!reachability.reachable) {
    throw new Error(
      `phases: '${vmName}' never became reachable on the isolated network. ` +
        `Boot log: ${join(artifactsDir, 'phases', 'serial.log')}`,
    );
  }
  return reachability.address;
}

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  share = await createTestShare(exec, sharePath);

  const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
  if (!natNetwork) throw new Error(`phases: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
  defaultSwitchHostIp = natNetwork.address;
  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`phases: ${internal.adapterAlias} has no IPv4 address`);
  internalHostIp = internal.address;

  guest = await createTestGuest(exec, 'phases', 'Default Switch', natNetwork, artifactsDir);
  target = { address: guest.address, username: GUEST_USERNAME };
  const icsProbe = await guestCapture(target, 'getent ahostsv4 archive.ubuntu.com');
  if (icsProbe.exitCode !== 0 || icsProbe.stdout.trim() === '') {
    throw new Error(
      'phases: the guest cannot resolve names on the Default Switch, so Hyper-V ICS is not serving it. ' +
        `Check that the Default Switch exists and ICS is running.\n${icsProbe.stdout}`,
    );
  }
  const remoteExec = createHarnessRemoteExec(target);
  await mountShare(remoteExec, {
    shareName: share.shareName,
    accountName: share.account,
    password: share.password,
    hostIp: defaultSwitchHostIp,
    onStep: (message) => console.log(`phases: mountShare — ${message}`),
  });
  const scripts = listScripts(join(sharePath, 'pre-scripts')).filter(
    (script) => script.slug === 'configure-network',
  );
  expect(scripts).toHaveLength(1);
  await runPreScripts(remoteExec, {
    scripts,
    shareName: share.shareName,
    internalSwitchHostIp: internalHostIp,
  });
}, 1_800_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'phases').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  if (share) await removeTestShare(exec, sharePath).catch(() => {});
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('the SMB share against a real CIFS client', () => {
  it('installs the credentials file root-owned and mode 600', async () => {
    const { stdout } = await guestCapture(target, 'stat -c "%a %U %G" /etc/susentorno-share.cred');
    expect(stdout.trim()).toBe('600 root root');
  });

  it('creates a live systemd automount unit for the mount point', async () => {
    const { stdout } = await guestCapture(
      target,
      `systemctl is-active "$(systemd-escape -p --suffix=automount /mnt/${share.shareName})"`,
    );
    expect(stdout.trim()).toBe('active');
  });

  it('mounts the share read-only over cifs', async () => {
    const { stdout } = await guestCapture(
      target,
      `ls /mnt/${share.shareName} >/dev/null && findmnt -no FSTYPE,OPTIONS /mnt/${share.shareName}`,
    );
    expect(stdout).toContain('cifs');
    expect(stdout).toContain('ro');
  });

  it('serves the environment’s real generated files through it', async () => {
    const { stdout } = await guestCapture(
      target,
      `test -f /mnt/${share.shareName}/cert.pem && echo present`,
    );
    expect(stdout.trim()).toBe('present');
  });
});

describe('provisioning during the setup phase', () => {
  it('runPreScripts installs and trusts the proxy CA', async () => {
    const { stdout } = await guestCapture(
      target,
      'test -f /usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt && echo present',
    );
    expect(stdout.trim()).toBe('present');
  });

  it('runs 04-configure-network.sh directly from the VM share', async () => {
    const { stdout } = await guestCapture(
      target,
      `bash /mnt/${share.shareName}/pre-scripts/04-configure-network.sh ${internalHostIp}`,
    );
    expect(stdout).toContain('configure-network:');
  });

  it('installs no DNAT rules', async () => {
    const { stdout } = await guestCapture(target, 'sudo iptables -t nat -S OUTPUT');
    expect(stdout).not.toContain('DNAT');
  });

  it('leaves the DHCP default route untouched', async () => {
    const { stdout } = await guestCapture(target, 'ip -4 route show default');
    expect(stdout).toContain('proto dhcp');
  });

  it('configures NODE_EXTRA_CA_CERTS for login shells, pointing at the full system bundle', async () => {
    const { stdout } = await guestCapture(target, "bash -lc 'echo $NODE_EXTRA_CA_CERTS'");
    expect(stdout).toContain('/etc/ssl/certs/ca-certificates.crt');
  });
});

describe('transition to the isolated phase', () => {
  it('re-points the live automount at the internal-switch host IP', async () => {
    await isolateVmToSwitch({ exec, vmName: guest.vmName }, internalSwitchName);
    const address = await waitForIsolatedAddress(guest.vmName);
    guest = { ...guest, address };
    target = { address, username: GUEST_USERNAME };
    await mountShare(createHarnessRemoteExec(target), {
      shareName: share.shareName,
      accountName: share.account,
      password: share.password,
      hostIp: internalHostIp,
      onStep: (message) => console.log(`phases: re-mountShare — ${message}`),
    });
    const { stdout } = await guestCapture(
      target,
      `test -f /mnt/${share.shareName}/cert.pem && findmnt -no SOURCE /mnt/${share.shareName}`,
    );
    // findmnt reports the active autofs parent (`systemd-1`) and the CIFS
    // child after the first access; the latter is the remounted source.
    expect(stdout).toContain(`//${internalHostIp}/${share.shareName}`);
  }, 900_000);

  it('takes its default route from the real DHCP server', async () => {
    const { stdout } = await guestCapture(target, 'ip -4 route show default');
    expect(stdout).toContain(`default via ${internalHostIp}`);
    expect(stdout).toContain('proto dhcp');
  });

  it('takes the host as its resolver from the real DNS responder', async () => {
    const { stdout } = await guestCapture(target, 'getent ahostsv4 example.com');
    expect(stdout.trim().split(/\s+/)[0]).toBe(internalHostIp);
  });

  it('terminates :443 with a trusted CA and injects only the placeholder auth', async () => {
    const beforeWrong = stack.mockUpstream.receivedAuthorizationHeaders.length;
    const wrongAuth = await guestCapture(
      target,
      "curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/",
    );
    expect(wrongAuth.stdout.trim()).toBe('200');
    expect(stack.mockUpstream.receivedAuthorizationHeaders.slice(beforeWrong)).toEqual([
      'Bearer not-the-placeholder',
    ]);
    const beforePlaceholder = stack.mockUpstream.receivedAuthorizationHeaders.length;
    const withAuth = await guestCapture(
      target,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: ${PLACEHOLDER_AUTH}' https://api.anthropic.com/`,
    );
    expect(withAuth.stdout.trim()).toBe('200');
    expect(stack.mockUpstream.receivedAuthorizationHeaders.slice(beforePlaceholder)).toEqual([
      REAL_AUTH,
    ]);
  });

  it('passes through an allow-listed :443 host', async () => {
    const { stdout } = await guestCapture(
      target,
      "curl -sI -o /dev/null -w '%{http_code}' --max-time 30 https://pypi.org/simple/",
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('allows an allow-listed :80 host', async () => {
    const { stdout } = await guestCapture(
      target,
      "curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/",
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('drops a non-allow-listed :443 connection', async () => {
    const { stdout } = await guestCapture(
      target,
      'curl -s -o /dev/null --max-time 20 https://blocked.example.com/ ; echo exit=$?',
    );
    expect(stdout).toContain('exit=');
    expect(stdout.trim()).not.toBe('exit=0');
  });

  it('returns default-deny 403 for a non-allow-listed :80 host', async () => {
    const { stdout } = await guestCapture(
      target,
      "curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://blocked.example.com/",
    );
    expect(stdout.trim()).toBe('403');
  });
});

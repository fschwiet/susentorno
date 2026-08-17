import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { getVmIpAddresses } from '../../src/guestSetup/hyperVQueries';
import { waitForReachable } from '../../src/guestSetup/reachabilityWait';
import { realTcpConnect } from '../../src/guestSetup/tcpConnect';
import { isolateVmToSwitch, reconcileVmToSwitch } from '../../src/guestSetup/vmReconcile';
import { GITHUB_PLACEHOLDER_PAT } from '../../src/githubPlaceholder';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { envParent, envRoot, repoRoot } from '../testEnvRoot';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { GUEST_USERNAME } from './autoinstall';
import { installExtraCas } from './extraCas';
import { guestCapture } from './guestExec';
import { ensureHarnessKeys } from './harnessKeys';
import { ISOLATION_NAME, roleVmName } from './hyperv/imageCache';
import {
  createTestGuest,
  destroyTestGuest,
  filterCandidateAddresses,
  type ExpectedNetwork,
  type TestGuest,
} from './hyperv/testGuest';
import { trustGuestHostKey, untrustGuestHostKey } from './knownHosts';
import { createTestShare, removeTestShare, type TestShare } from './testShare';

const exec = createRealPowerShellExec();
const cliPath = join(repoRoot, 'dist', 'cli.js');
const sharePath = join(envRoot, 'vm-shared-linux');
const vmName = roleVmName('e2e');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

let stack: ProxyStack;
let share: TestShare;
let guest: TestGuest;
let setupAddress: string;
let isolatedAddress: string;
let target: SshTarget;
const trusted: string[] = [];

async function discoverAndTrust(expected: ExpectedNetwork, hostPublicKey: string): Promise<string> {
  const reachability = await waitForReachable({
    getCandidates: async () =>
      filterCandidateAddresses(await getVmIpAddresses(exec, vmName), expected),
    connect: realTcpConnect,
    timeoutMs: 600_000,
    onProgress: (ms) => console.log(`e2e: waiting for the guest... (${Math.round(ms / 1000)}s)`),
  });
  if (!reachability.reachable) {
    throw new Error(
      `e2e: '${vmName}' never became reachable in ${expected.address}/${expected.netmask}. ` +
        `Boot log: ${join(artifactsDir, 'e2e', 'serial.log')}`,
    );
  }
  await trustGuestHostKey(reachability.address, hostPublicKey);
  trusted.push(reachability.address);
  return reachability.address;
}

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  share = await createTestShare(exec, sharePath);
  const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
  if (!natNetwork) throw new Error(`e2e: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`e2e: ${internal.adapterAlias} has no IPv4 address`);
  const keys = await ensureHarnessKeys();

  writeFileSync(
    join(sharePath, 'github-config.txt'),
    [
      'GITHUB_USERNAME="susentorno-test-user"',
      'GITHUB_EMAIL="susentorno-test@example.com"',
      `GITHUB_TOKEN="${GITHUB_PLACEHOLDER_PAT}"`,
      '',
    ].join('\n'),
  );

  guest = await createTestGuest(exec, 'e2e', 'Default Switch', natNetwork, artifactsDir);
  setupAddress = guest.address;
  await trustGuestHostKey(setupAddress, keys.guestHostPublicKey);
  trusted.push(setupAddress);
  target = { address: setupAddress, username: GUEST_USERNAME };

  const stage = [
    `printf '#!/bin/sh\\nexit 0\\n' | sudo tee /usr/local/bin/gh >/dev/null`,
    'sudo chmod +x /usr/local/bin/gh',
    `printf '#!/bin/sh\\n' | sudo tee /usr/local/bin/firefox >/dev/null`,
    'sudo chmod +x /usr/local/bin/firefox',
    'sudo mkdir -p /etc/firefox/policies',
    `printf '%s' '{"policies":{"SomeOther":true,"Certificates":{"Install":["/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt"]}}}' | sudo tee /etc/firefox/policies/policies.json >/dev/null`,
  ].join(' && ');
  const staged = await guestCapture(target, stage);
  expect(staged.exitCode, staged.stdout).toBe(0);

  // Only meaningful when this machine is behind a TLS-intercepting proxy, in
  // which case the guest inherits the interception but not the trust and the
  // pre-scripts' agent installers fail certificate verification. A no-op
  // otherwise. See tests/guest/extraCas.ts.
  await installExtraCas(target, 'e2e');

  // Both DHCP addresses must be trusted before production's StrictHostKeyChecking=ask
  // command reaches either one, since its only stdin is reserved for the SMB password.
  await isolateVmToSwitch({ exec, vmName }, internalSwitchName);
  isolatedAddress = await discoverAndTrust(internal, keys.guestHostPublicKey);
  await reconcileVmToSwitch({ exec, vmName }, 'Default Switch');
  setupAddress = await discoverAndTrust(natNetwork, keys.guestHostPublicKey);
  target = { address: setupAddress, username: GUEST_USERNAME };

  const result = await execa(
    'node',
    [
      cliPath,
      'setup-guest-unix',
      '--isolation-name',
      ISOLATION_NAME,
      '--vm-name',
      vmName,
      '--guest-address',
      setupAddress,
      '--guest-username',
      GUEST_USERNAME,
      '--share-name',
      share.shareName,
      '--share-account',
      share.account,
    ],
    { cwd: envParent, input: `${share.password}\n`, reject: false, all: true },
  );
  console.log(`setup-guest-unix|\n${result.all ?? ''}`);
  expect(result.exitCode, 'setup-guest-unix must succeed end to end').toBe(0);
  target = { address: isolatedAddress, username: GUEST_USERNAME };
}, 3_600_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'e2e').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  for (const address of trusted) await untrustGuestHostKey(address).catch(() => {});
  if (share) await removeTestShare(exec, sharePath).catch(() => {});
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('setup-guest-unix end to end on a bare Ubuntu guest', () => {
  it('re-mounted the share against the internal-switch host IP', async () => {
    const internal = resolveIsolationNetwork(ISOLATION_NAME);
    expect(internal.found).toBe(true);
    const { stdout } = await guestCapture(
      target,
      `test -f /mnt/${share.shareName}/cert.pem && findmnt -no SOURCE /mnt/${share.shareName}`,
    );
    expect(stdout).toContain(`//${internal.found ? internal.address : ''}/${share.shareName}`);
  });

  it('really installed the toolchain the golden image deliberately omits', async () => {
    const { stdout } = await guestCapture(
      target,
      `bash -lc 'command -v node >/dev/null && echo node-ok; command -v pnpm >/dev/null && echo pnpm-ok; dpkg -s cifs-utils >/dev/null 2>&1 && echo cifs-ok'`,
    );
    expect(stdout).toContain('node-ok');
    expect(stdout).toContain('pnpm-ok');
    expect(stdout).toContain('cifs-ok');
  });

  it('01-auth-config symlinked the placeholder claude credential into place', async () => {
    const link = await guestCapture(target, 'readlink "$HOME/.claude/.credentials.json"');
    expect(link.stdout.trim()).toBe(`/mnt/${share.shareName}/credentials.json`);
    const body = await guestCapture(target, 'cat "$HOME/.claude/.credentials.json"');
    expect(body.stdout).toContain('sk-ant-oat-susentorno-PLACEHOLDER');
  });

  it('01-auth-config symlinked the placeholder codex credential into place', async () => {
    const link = await guestCapture(target, 'readlink "$HOME/.codex/auth.json"');
    expect(link.stdout.trim()).toBe(`/mnt/${share.shareName}/auth.json`);
  });

  it('01-auth-config set the git identity from github-config.txt', async () => {
    const name = await guestCapture(target, 'git config --global user.name');
    const email = await guestCapture(target, 'git config --global user.email');
    expect(name.stdout.trim()).toBe('susentorno-test-user');
    expect(email.stdout.trim()).toBe('susentorno-test@example.com');
  });

  it('the home settings transform set hasCompletedOnboarding', async () => {
    const { stdout } = await guestCapture(
      target,
      `python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['hasCompletedOnboarding'])"`,
    );
    expect(stdout.trim()).toBe('True');
  });

  it('the home settings transform merges into an existing ~/.claude.json without clobbering', async () => {
    const rerun = await guestCapture(
      target,
      `printf '%s' '{"someExisting": 123}' > "$HOME/.claude.json" && bash /mnt/${share.shareName}/post-scripts/02-apply-home-jq-transforms.sh`,
    );
    expect(rerun.exitCode, rerun.stdout).toBe(0);
    const { stdout } = await guestCapture(
      target,
      `python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));print(d['hasCompletedOnboarding'], d['someExisting'])"`,
    );
    expect(stdout.trim()).toBe('True 123');
  });

  it('configure-network merged the CA into existing firefox policies without clobbering', async () => {
    const { stdout } = await guestCapture(
      target,
      `python3 -c "import json;d=json.load(open('/etc/firefox/policies/policies.json'));i=d['policies']['Certificates']['Install'];print(d['policies']['SomeOther'], '/etc/firefox/policies/susentorno-proxy-certificate-authority.pem' in i, '/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt' in i)"`,
    );
    expect(stdout.trim()).toBe('True True False');
  });

  it('ensureKvpDaemon succeeds against its already-installed package', async () => {
    const { stdout } = await guestCapture(target, 'systemctl is-active hv-kvp-daemon.service');
    expect(stdout.trim()).toBe('active');
  });
});

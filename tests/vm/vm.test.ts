import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, wslExec, wslPath } from './wsl';
import {
  startProxyStack,
  stopProxyStack,
  HTTP_PORT,
  HTTPS_PORT,
  type ProxyStack,
} from '../proxyStack';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const BRIDGE_IP = '10.213.87.1';
// Docker Desktop's WSL integration republishes container ports on localhost
// inside integrated distros. If that is off, point this at the Windows host
// IP as seen from WSL instead.
const ENVOY_HOST = process.env.CFGM_VMTEST_ENVOY_HOST ?? '127.0.0.1';
const artifactsDir = join(
  repoRoot,
  'test-results',
  'vm',
  new Date().toISOString().replace(/[:.]/g, '-'),
);

let stack: ProxyStack;
let shareDir: string;

function guest(name: string, cmd: string) {
  return harness('guest.sh', 'exec', name, cmd);
}

beforeAll(async () => {
  await harness('cleanup.sh'); // stale bridges/guests from a killed run
  stack = await startProxyStack();

  await harness('net.sh', 'up');
  await harness('net.sh', 'dhcp', 'gateway');
  await harness('forward.sh', 'up', ENVOY_HOST, String(HTTP_PORT), String(HTTPS_PORT));

  // Guard: the bridge IP must reach Envoy through the forwarders before we
  // involve a guest. 403 = Envoy's port-80 default deny answered us.
  const guard = await wslExec(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: not-allow-listed.example.com' http://${BRIDGE_IP}:80/`,
    { reject: false },
  );
  if (guard.stdout.trim() !== '403') {
    throw new Error(
      `WSL cannot reach Envoy at ${ENVOY_HOST}:${HTTP_PORT} via ${BRIDGE_IP}:80 (got '${guard.all}'). ` +
        `Enable Docker Desktop WSL integration, or set CFGM_VMTEST_ENVOY_HOST to the Windows host IP.`,
    );
  }

  // Stage the environment's real vm-shared folder (numbered scripts + the
  // generate-ca cert.pem) as the guest's read-only share, mimicking hgfs.
  const wslVmShared = await wslPath(join(repoRoot, '.configamatron', 'vm-shared'));
  shareDir = (await harness('share.sh', wslVmShared)).stdout.trim();

  await harness('guest.sh', 'start', 'g1', '--share', shareDir);
  await harness('guest.sh', 'wait-ssh', 'g1');
}, 1_200_000);

afterAll(async () => {
  mkdirSync(artifactsDir, { recursive: true });
  const wslArtifacts = await wslPath(artifactsDir);
  for (const name of ['g1', 'g2']) {
    await harness('guest.sh', 'diag', name, `${wslArtifacts}/${name}`).catch(() => {});
  }
  console.log(`vm-e2e: diagnostics collected in ${artifactsDir}`);
  await harness('cleanup.sh').catch(() => {});
  if (stack) await stopProxyStack(stack);
}, 600_000);

describe('S1: setup during NAT phase', () => {
  it('runs 06-trust-ca.sh and 07-setup-persistence.sh from the read-only share', async () => {
    await guest('g1', 'bash /mnt/vm-shared/06-trust-ca.sh');
    const { stdout } = await guest(
      'g1',
      `bash /mnt/vm-shared/07-setup-persistence.sh ${BRIDGE_IP}`,
    );
    expect(stdout).toContain('07-setup-persistence:');
  });

  it('dnsmasq stub answers every name with the placeholder IP', async () => {
    const { stdout } = await guest('g1', 'dig +short example.com @127.0.0.1');
    expect(stdout.trim()).toBe('203.0.113.1');
  });

  it('netplan override registered the stub as the interface resolver', async () => {
    // In gateway mode the DHCP DNS is still present too, so assert
    // containment; host-only S2 asserts the stub is the effective resolver.
    const { stdout } = await guest('g1', 'resolvectl dns');
    expect(stdout).toContain('127.0.0.1');
  });

  it('installed both DNAT rules', async () => {
    const { stdout } = await guest('g1', 'sudo iptables -t nat -S OUTPUT');
    expect(stdout).toContain(`--dport 443 -j DNAT --to-destination ${BRIDGE_IP}:443`);
    expect(stdout).toContain(`--dport 80 -j DNAT --to-destination ${BRIDGE_IP}:80`);
  });

  it('left the DHCP default route untouched', async () => {
    const { stdout } = await guest('g1', 'ip -4 route show default');
    // Still DHCP's route — the guarded `ip route replace` must not have fired.
    expect(stdout).toContain('proto dhcp');
  });
});

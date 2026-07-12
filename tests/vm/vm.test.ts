import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, wslExec, wslPath } from './wsl';
import {
  startProxyStack,
  stopProxyStack,
  waitForProxyLine,
  countProxyLines,
  writeStackCredentials,
  HTTP_PORT,
  HTTPS_PORT,
  PLACEHOLDER_AUTH,
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

/**
 * Single passthrough-:443 curl from the guest, capturing both the HTTP status
 * and curl's own exit code (via `; echo exit=$?`, so guest.sh exec itself
 * always succeeds and we parse curl's result out of stdout). Deliberately
 * unretried: the S2c cold-cache probe must observe the FIRST contact to a
 * host — a retry would warm the DNS cache and erase the signal.
 */
async function guestProbe(name: string, host: string): Promise<{ http: string; exit: string }> {
  const { stdout } = await guest(
    name,
    `curl -s -o /dev/null -w 'http=%{http_code} ' --max-time 30 https://${host}/ ; echo exit=$?`,
  );
  return {
    http: /http=(\d+)/.exec(stdout)?.[1] ?? '?',
    exit: /exit=(\d+)/.exec(stdout)?.[1] ?? '?',
  };
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

describe('S1b: claude config (08) and firefox policy merge (06), offline', () => {
  it('08 sets hasCompletedOnboarding on a fresh ~/.claude.json', async () => {
    await guest('g1', 'rm -f "$HOME/.claude.json" && bash /mnt/vm-shared/08-claude-config.sh');
    const { stdout } = await guest(
      'g1',
      `python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['hasCompletedOnboarding'])"`,
    );
    expect(stdout.trim()).toBe('True');
  });

  it('08 merges into an existing ~/.claude.json without clobbering, idempotently', async () => {
    await guest(
      'g1',
      `printf '%s' '{"someExisting": 123}' > "$HOME/.claude.json" && bash /mnt/vm-shared/08-claude-config.sh && bash /mnt/vm-shared/08-claude-config.sh`,
    );
    const { stdout } = await guest(
      'g1',
      `python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));print(d['hasCompletedOnboarding'], d['someExisting'])"`,
    );
    expect(stdout.trim()).toBe('True 123');
  });

  it('08 symlinks the placeholder credential into place', async () => {
    const link = await guest('g1', 'readlink "$HOME/.claude/.credentials.json"');
    expect(link.stdout.trim()).toBe('/mnt/vm-shared/credentials.json');
    const body = await guest('g1', 'cat "$HOME/.claude/.credentials.json"');
    expect(body.stdout).toContain('sk-ant-oat-SANDBOX-PLACEHOLDER');
  });

  it('06 merges the CA into an existing firefox policies.json, preserving other keys', async () => {
    await guest(
      'g1',
      `printf '#!/bin/sh\\n' | sudo tee /usr/local/bin/firefox >/dev/null && sudo chmod +x /usr/local/bin/firefox && sudo mkdir -p /etc/firefox/policies && printf '%s' '{"policies":{"SomeOther":true,"Certificates":{"Install":["/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt"]}}}' | sudo tee /etc/firefox/policies/policies.json >/dev/null && bash /mnt/vm-shared/06-trust-ca.sh`,
    );
    const { stdout } = await guest(
      'g1',
      `python3 -c "import json;d=json.load(open('/etc/firefox/policies/policies.json'));i=d['policies']['Certificates']['Install'];print(d['policies']['SomeOther'], '/etc/firefox/policies/configamatron-proxy-certificate-authority.pem' in i, '/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt' in i)"`,
    );
    expect(stdout.trim()).toBe('True True False');
  });
});

describe('S2: switch to host-only and reboot', () => {
  it('reboots into host-only mode with both units active', async () => {
    await harness('net.sh', 'dhcp', 'hostonly');
    await harness('guest.sh', 'reboot', 'g1');

    expect((await guest('g1', 'systemctl is-active dnsmasq')).stdout.trim()).toBe('active');
    expect(
      (await guest('g1', 'systemctl is-active configamatron-egress.service')).stdout.trim(),
    ).toBe('active');
  }, 600_000);

  it('installed the guarded host-only default route', async () => {
    const { stdout } = await guest('g1', 'ip -4 route show default');
    expect(stdout).toContain(`default via ${BRIDGE_IP}`);
    expect(stdout).not.toContain('proto dhcp'); // static, installed by the unit
  });

  it('stub is the effective resolver after reboot', async () => {
    const { stdout } = await guest('g1', 'dig +short example.com');
    expect(stdout.trim()).toBe('203.0.113.1');
  });

  it('terminated :443 host works and the CA is trusted', async () => {
    // Either response arriving at all proves the TLS handshake succeeded, i.e.
    // 06 installed and trusted the proxy CA. The gate (gate.lua) then rejects an
    // *unexpected* credential — a present, non-placeholder Authorization header —
    // with 403, and passes the placeholder, which the credential injector swaps
    // for the real token → 200. (A request with no Authorization header is
    // deliberately not rejected: the injector supplies the credential. That
    // matches the integration suite's auth cases, which likewise never assert on
    // a missing header.)
    const wrongAuth = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/`,
    );
    expect(wrongAuth.stdout.trim()).toBe('403');

    const withAuth = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: ${PLACEHOLDER_AUTH}' https://api.anthropic.com/`,
    );
    expect(withAuth.stdout.trim()).toBe('200');
  });

  it('passthrough :443 host works end-to-end', async () => {
    // HEAD, not GET: pypi.org/simple/ is a ~44 MB index whose full download can
    // exceed the timeout over this nested VM link (the doc's exit-28 flakiness).
    // A HEAD proves the passthrough TLS handshake to real pypi.org succeeds and
    // returns 200 without transferring the body. See
    // docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt.
    const { stdout } = await guest(
      'g1',
      `curl -sI -o /dev/null -w '%{http_code}' --max-time 30 https://pypi.org/simple/`,
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('allow-listed :80 host works', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/`,
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('non-allow-listed :443 connection is dropped', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null --max-time 20 https://blocked.example.com/ ; echo exit=$?`,
    );
    expect(stdout).toContain('exit=');
    expect(stdout.trim()).not.toBe('exit=0');
  });

  it('non-allow-listed :80 gets the default-deny 403', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://blocked.example.com/`,
    );
    expect(stdout.trim()).toBe('403');
  });

  it('06 configured NODE_EXTRA_CA_CERTS for login shells', async () => {
    const { stdout } = await guest('g1', `bash -lc 'echo $NODE_EXTRA_CA_CERTS'`);
    expect(stdout).toContain('configamatron-proxy-certificate-authority.crt');
  });
});

describe('S2c: cold DNS cache vs. restart-warmup discrimination (docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt)', () => {
  // The doc's deterministic exit-35 failures were only ever seen immediately
  // after a container restart, always coinciding with pypi.org being
  // un-resolved. That conflates two variables: container age (fresh-restart
  // vs. long-warm) and host freshness (un-resolved vs. already-cached). This
  // probes the cell that disentangles them — hosts allow-listed since startup
  // but never contacted, hit now while the Envoy container has been up since
  // beforeAll with no recent restart (S2b's restarts run *after* this block).
  //
  //   - restart-warmup theory   → first contact SUCCEEDS (exit 0): the cold
  //     "DNS cache" framing is a red herring; a fresh restart is required to
  //     reproduce, so the fix belongs in post-restart readiness, not the cache.
  //   - first-resolution theory → first contact fails with exit 35 (SSL
  //     connect error) even on a long-warm container: any un-resolved host is
  //     vulnerable, so pre-resolving well-known hosts is the real fix.
  //
  // Envoy resolves passthrough DNS lazily, so these hosts stay un-resolved
  // until the single curl below. Each host is curled exactly once — no retry —
  // since a retry would warm the cache and destroy the measurement.
  it('first contact to warm-but-never-resolved passthrough hosts does not hit exit 35', async () => {
    const freshHosts = ['files.pythonhosted.org', 'github.com', 'www.google.com'];
    const results: Record<string, { http: string; exit: string }> = {};
    for (const host of freshHosts) results[host] = await guestProbe('g1', host);
    console.log('S2c cold-cache probe (long-warm container, first contact):', results);

    // Exit 28 (timeout) is the doc's separate, orthogonal real-network
    // flakiness — it neither confirms nor refutes the cache theory, so we
    // tolerate it. Exit 35 is the signature under test: its ABSENCE on a
    // long-warm container refutes the first-resolution theory (the cache being
    // cold is not sufficient to fail) and points at restart-specific warmup.
    for (const host of freshHosts) {
      expect(results[host].exit, `${host} => ${JSON.stringify(results[host])}`).not.toBe('35');
    }
  }, 120_000);
});

describe('S2b: run-proxy inline logging', () => {
  it('streamed unique tagged lines for the traffic S2 generated', async () => {
    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 30_000);
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 30_000);
    await waitForProxyLine(stack, 'ALLOW HTTP  archive.ubuntu.com', 30_000);
    await waitForProxyLine(stack, 'BLOCK HTTP  blocked.example.com', 30_000);
  });

  it('an allowlist edit restarts the proxy, re-attaches the follow, and resets unique tracking', async () => {
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');
    expect(pypiBefore).toBeGreaterThan(0);
    const mark = stack.stdoutLines.length;

    // The staged fixture ends with the '# terminate' section, so appending
    // adds a terminate host — the terminate-host set changes and the
    // leaf-reissue path runs too, not just the config rebuild.
    appendFileSync(stack.allowlistPath, 'example.org:443\n');

    await waitForProxyLine(stack, 'restarting proxy — allowlist changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);

    // HEAD, and no retry: the new-container gate above makes the passthrough
    // path reliably serving, so a single un-retried request suffices.
    await guest('g1', `curl -sI -o /dev/null --max-time 30 https://pypi.org/simple/`);

    // The same host+handling prints again only because unique tracking was
    // cleared — and the line only reaches us because the follow re-attached
    // to the freshly recreated container.
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 60_000, mark);
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore + 1);
  }, 300_000);

  it('a credential rotation restarts the proxy and preserves unique tracking', async () => {
    const mark = stack.stdoutLines.length;
    writeStackCredentials(stack, 'rotated-vm-test-token');

    await waitForProxyLine(stack, 'restarting proxy — credentials changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');

    // pypi.org was re-logged after the allowlist restart above, so it is in
    // the preserved unique map: this request must NOT produce a new line.
    await guest('g1', `curl -sI -o /dev/null --max-time 30 https://pypi.org/simple/`);
    // api.anthropic.com has NOT been logged since that allowlist reset, so it
    // does print — proving the follow re-attached after this restart too.
    await guest(
      'g1',
      `curl -s -o /dev/null --max-time 30 -H 'Authorization: ${PLACEHOLDER_AUTH}' https://api.anthropic.com/`,
    );

    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 60_000, mark);
    // Envoy logs in request order: the api.anthropic.com line arriving means
    // any pypi line would already be here. It is not: unique was preserved.
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore);
  }, 300_000);
});

describe('S3: fresh setup with no default route', () => {
  it('07 discovers the interface via the fallback and installs the route', async () => {
    // DHCP is still in host-only mode (S2), so g2 boots gateway-less: the
    // interface-discovery fallback branch in 07 is the only path that works.
    await harness('guest.sh', 'start', 'g2', '--share', shareDir);
    await harness('guest.sh', 'wait-ssh', 'g2');

    const before = await guest('g2', 'ip -4 route show default');
    expect(before.stdout.trim()).toBe(''); // precondition: no default route

    const run = await guest('g2', `bash /mnt/vm-shared/07-setup-persistence.sh ${BRIDGE_IP}`);
    expect(run.stdout).toContain('07-setup-persistence:');

    const after = await guest('g2', 'ip -4 route show default');
    expect(after.stdout).toContain(`default via ${BRIDGE_IP}`);

    const nat = await guest('g2', 'sudo iptables -t nat -S OUTPUT');
    expect(nat.stdout).toContain(`--dport 443 -j DNAT --to-destination ${BRIDGE_IP}:443`);
    expect(nat.stdout).toContain(`--dport 80 -j DNAT --to-destination ${BRIDGE_IP}:80`);

    const dns = await guest('g2', 'dig +short example.com @127.0.0.1');
    expect(dns.stdout.trim()).toBe('203.0.113.1');
  }, 900_000);
});

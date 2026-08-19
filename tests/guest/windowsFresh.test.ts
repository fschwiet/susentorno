import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { envRoot } from '../testEnvRoot';
import { artifactsDir } from './diagnostics';
import { ISOLATION_NAME, windowsIsoPath, WINDOWS_ISO_ENV_VAR } from './hyperv/imageCache';
import { ensureWindowsCredential } from './hyperv/windowsCredential';
import {
  createWindowsTestGuest,
  destroyWindowsTestGuest,
  type WindowsTestGuest,
} from './hyperv/windowsTestGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';
import { collectWindowsDiagnostics } from './windowsDiagnostics';
import { propagateAmbientTrustToWindows } from './windowsAmbientTrust';
import {
  assertGuestElevated,
  createWindowsGuestExec,
  waitForPowerShellDirect,
  type WindowsGuestExec,
} from './windowsGuestExec';

const exec = createRealPowerShellExec();
const sharePath = join(envRoot, 'vm-shared-windows');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);
const isoConfigured = windowsIsoPath() !== null;

if (!isoConfigured) {
  console.log(
    `guest: skipping windowsFresh — ${WINDOWS_ISO_ENV_VAR} is not set. Point it at an x64 en-us ` +
      'Windows 11 Enterprise evaluation ISO to enable this role (see testing.md).',
  );
}

let stack: ProxyStack;
let share: TestShare;
let guest: WindowsTestGuest;
let session: WindowsGuestExec;
let internalHostIp: string;
/** The guest's DHCP interface index; every network assertion is scoped to it. */
let interfaceIndex: string;

describe.skipIf(!isoConfigured)('a fresh Windows guest starting in the isolated phase', () => {
  beforeAll(async () => {
    stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
    share = await createTestShare(exec, sharePath);
    const internal = resolveIsolationNetwork(ISOLATION_NAME);
    if (!internal.found)
      throw new Error(`windowsFresh: ${internal.adapterAlias} has no IPv4 address`);
    internalHostIp = internal.address;

    guest = await createWindowsTestGuest(exec, 'windowsFresh', internalSwitchName, artifactsDir);
    session = createWindowsGuestExec(exec, guest.vmName, ensureWindowsCredential());
    await waitForPowerShellDirect(session, {
      onProgress: (ms) =>
        console.log(`windowsFresh: waiting for PowerShell Direct... (${Math.round(ms / 1000)}s)`),
    });
    await assertGuestElevated(session);

    const route = await session.capture(
      "(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | " +
        'Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex',
    );
    expect(route.exitCode, route.stdout).toBe(0);
    interfaceIndex = route.stdout.trim();
    expect(interfaceIndex, 'the guest must have a default route').toMatch(/^\d+$/);

    // Before any TLS assertion: on a host that is itself behind a terminating
    // proxy, a passthrough destination here is terminated upstream.
    await propagateAmbientTrustToWindows(exec, session, (message) =>
      console.log(`windowsFresh: ambientTrust — ${message}`),
    );

    // cmdkey entries are per-address; the share is reached by UNC with no drive letter.
    const mounted = await session.capture(
      `cmdkey /add:${internalHostIp} /user:${share.account} /pass:${share.password}; ` +
        `Get-ChildItem -LiteralPath '\\\\${internalHostIp}\\${share.shareName}' | Out-Null; ` +
        `Test-Path '\\\\${internalHostIp}\\${share.shareName}\\cert.pem'`,
    );
    expect(mounted.exitCode, mounted.stdout).toBe(0);
    expect(mounted.stdout).toMatch(/True/i);

    // -ExecutionPolicy per invocation rather than mutating machine policy: a
    // .ps1 fetched over UNC lands in the Internet zone, but the test should
    // leave behind no state the manual flow would not.
    const configured = await session.capture(
      `powershell.exe -ExecutionPolicy Bypass -File ` +
        `'\\\\${internalHostIp}\\${share.shareName}\\pre-scripts\\04-configure-network.ps1' ` +
        `-HostIp ${internalHostIp} 2>&1 | Out-String`,
    );
    console.log(`windowsFresh: 04-configure-network |\n${configured.stdout}`);
    expect(configured.exitCode, configured.stdout).toBe(0);
  }, 1_800_000);

  afterAll(async () => {
    if (session) await collectWindowsDiagnostics(session, 'windowsFresh').catch(() => {});
    if (guest) await destroyWindowsTestGuest(exec, guest).catch(() => {});
    if (share) await removeTestShare(exec, sharePath).catch(() => {});
    if (stack) await stopProxyStack(stack).catch(() => {});
  }, 600_000);

  describe('configuration arrived entirely from the host', () => {
    it('took its address from the real DHCP server', async () => {
      const { stdout } = await session.capture(
        `Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex ${interfaceIndex} | ` +
          'ForEach-Object { "$($_.IPAddress) $($_.PrefixOrigin) $($_.SuffixOrigin)" }',
      );
      expect(stdout).toContain('Dhcp');
      const [address] = stdout.trim().split(/\s+/);
      expect(address.split('.').slice(0, 3).join('.')).toBe(
        internalHostIp.split('.').slice(0, 3).join('.'),
      );
    });

    it('took its default route from the DHCP lease alone', async () => {
      const { stdout } = await session.capture(
        `(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -InterfaceIndex ${interfaceIndex}).NextHop`,
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('took the host as its resolver from the DHCP lease alone', async () => {
      const { stdout } = await session.capture(
        `(Get-DnsClientServerAddress -AddressFamily IPv4 -InterfaceIndex ${interfaceIndex}).ServerAddresses`,
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('resolves names through the real DNS responder', async () => {
      const { stdout } = await session.capture(
        "(Resolve-DnsName -Name example.com -Type A -DnsOnly | Where-Object Type -eq 'A' | " +
          'Select-Object -First 1).IPAddress',
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('has no in-guest DNS responder doing any of it', async () => {
      const { stdout } = await session.capture(
        "if (Get-ScheduledTask -TaskName 'SusentornoDnsResponder' -ErrorAction SilentlyContinue) " +
          "{ 'present' } else { 'absent' }",
      );
      expect(stdout.trim()).toBe('absent');
    });
  });

  describe('the shipped configure-network script did its job', () => {
    it('imported the proxy CA into the machine root store', async () => {
      const { stdout } = await session.capture(
        "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine'); " +
          "$s.Open('ReadOnly'); " +
          "$found = @($s.Certificates | Where-Object { $_.Subject -like '*susentorno-proxy-certificate-authority*' }).Count; " +
          '$s.Close(); $found',
      );
      expect(Number(stdout.trim())).toBeGreaterThan(0);
    });

    it('pointed NODE_EXTRA_CA_CERTS at a file that exists', async () => {
      const { stdout } = await session.capture(
        "$p = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','Machine'); " +
          'if ($p -and (Test-Path $p)) { "ok $p" } else { "missing $p" }',
      );
      expect(stdout.trim()).toMatch(/^ok /);
    });

    it('set git to validate through schannel', async () => {
      const { stdout } = await session.capture('git config --global http.sslBackend');
      expect(stdout.trim()).toBe('schannel');
    });
  });

  describe('the network boundary behaves', () => {
    it('allows an allow-listed :80 host', async () => {
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/",
      );
      expect(Number(stdout.trim())).toBeLessThan(400);
    });

    it('passes through an allow-listed :443 host, validated against public roots', async () => {
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 30 https://pypi.org/",
      );
      expect(Number(stdout.trim())).toBeLessThan(400);
    });

    it('terminates a TLS-intercepted :443 host with the trusted proxy CA', async () => {
      // --ssl-no-revoke: src/ca.ts issues leaves with no CRL or OCSP endpoint,
      // and Schannel fails closed on unknown revocation status. Chain
      // validation stays active; only revocation is waived, and only where
      // susentorno itself is the issuer. verify-config.ps1 documents the same.
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --ssl-no-revoke --max-time 20 https://api.anthropic.com/",
      );
      expect(stdout.trim()).toBe('200');
    });

    it('lets git speak TLS through the proxy on schannel', async () => {
      const { stdout } = await session.capture(
        'git -c http.schannelCheckRevoke=false ls-remote https://github.com/git/git HEAD 2>&1 | ' +
          'Out-String; "exit=$LASTEXITCODE"',
      );
      expect(stdout, stdout).toContain('exit=0');
      expect(stdout).toMatch(/[0-9a-f]{40}\s+HEAD/);
    });

    it('drops a non-allow-listed :443 connection', async () => {
      const { stdout } = await session.capture(
        '& curl.exe -s -o NUL --max-time 20 https://blocked.example.com/ 2>&1 | Out-Null; ' +
          '"exit=$LASTEXITCODE"',
      );
      expect(stdout.trim()).not.toBe('exit=0');
    });

    it('returns default-deny 403 for a non-allow-listed :80 host', async () => {
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 http://blocked.example.com/",
      );
      expect(stdout.trim()).toBe('403');
    });
  });
});

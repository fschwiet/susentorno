import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { X509Certificate, createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { GITHUB_PLACEHOLDER_PAT } from '../../src/githubPlaceholder';
import { reconcileVmToSwitch } from '../../src/guestSetup/vmReconcile';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import {
  createWindowsGuestExecutor,
  waitForPowerShellDirect as waitForProductionPowerShellDirect,
  type WindowsGuestExecutor,
} from '../../src/guestSetup/windows/guestExecutor';
import { probePendingReboot } from '../../src/guestSetup/windows/guestChecks';
import {
  GUEST_TRUST_BUNDLE_PATH,
  GUEST_TRUST_DIR,
} from '../../src/guestSetup/windows/trustReconciler';
import {
  HOST_CODEX_ACCOUNT_ID,
  startProxyStack,
  stopProxyStack,
  type ProxyStack,
} from '../proxyStack';
import { envParent, envRoot, repoRoot } from '../testEnvRoot';
import { artifactsDir } from './diagnostics';
import { ISOLATION_NAME } from './hyperv/imageCache';
import { ensureWindowsCredential, type WindowsCredential } from './hyperv/windowsCredential';
import {
  createWindowsTestGuest,
  destroyWindowsTestGuest,
  type WindowsTestGuest,
} from './hyperv/windowsTestGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';
import { collectWindowsDiagnostics } from './windowsDiagnostics';
import {
  buildGhShimStagingScript,
  formatRebootEvidence,
  GH_SHIM_DIRECTORY,
  scanArtifactsForSecrets,
  type RebootProbeEvidence,
} from './windowsE2eSupport';
import {
  assertGuestElevated,
  createWindowsGuestExec,
  waitForPowerShellDirect,
  type WindowsGuestExec,
} from './windowsGuestExec';

const ROLE = 'windowsE2e';
const exec = createRealPowerShellExec();
const cliPath = join(repoRoot, 'dist', 'cli.js');
const sharePath = join(envRoot, 'vm-shared-windows');
const failStepName = '99-fail.ps1';
const failStepInShare = join(sharePath, 'post-scripts', failStepName);
const roleArtifacts = join(artifactsDir, ROLE);
const rebootEvidencePath = join(roleArtifacts, 'reboot-evidence.txt');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

interface SetupRun {
  run: number;
  exitCode: number | undefined;
  output: string;
  logPath: string;
}

let stack: ProxyStack;
let share: TestShare;
let guest: WindowsTestGuest;
let credential: WindowsCredential;
let executor: WindowsGuestExecutor;
let session: WindowsGuestExec;
let internalHostIp: string;
let defaultSwitchHostIp: string;
/** DER SHA-256 of the environment proxy CA the share carries. */
let proxyFingerprint: string;
/** The guest's DHCP interface index; every network assertion is scoped to it. */
let interfaceIndex: string;
let executionPolicyBefore: string;
/** Whether the clean golden image lacked the VC++ runtime pnpm 12 needs, so step 02 must install it. */
let vcRuntimeAbsentBefore: boolean;
let run1: SetupRun;
let run2: SetupRun;
let diagnosticsCollected = false;
let artifactsScanned = false;

function secretsUnderTest() {
  return [
    { name: 'guest password', value: credential.password },
    { name: 'VM share password', value: share.password },
  ];
}

/**
 * Both secrets go in on stdin, but not in one write: each masked prompt consumes
 * the whole chunk it is handed, so the second answer is written only once its
 * prompt has appeared, which is also how a human would type it.
 */
async function runSetupGuestWindows(run: number): Promise<SetupRun> {
  mkdirSync(roleArtifacts, { recursive: true });
  const child = execa(
    'node',
    [
      cliPath,
      'setup-guest-windows',
      '--isolation-name',
      ISOLATION_NAME,
      '--vm-name',
      guest.vmName,
      '--guest-username',
      credential.username,
      '--share-name',
      share.shareName,
      '--share-account',
      share.account,
    ],
    { cwd: envParent, reject: false, all: true, stdin: 'pipe' },
  );
  let seen = '';
  let shareAnswered = false;
  child.all?.on('data', (chunk: Buffer) => {
    seen += chunk.toString();
    if (!shareAnswered && seen.includes('VM share password')) {
      shareAnswered = true;
      child.stdin?.write(`${share.password}\n`);
      child.stdin?.end();
    }
  });
  if (child.all) {
    createInterface({ input: child.all }).on('line', (line) =>
      console.log(`setup-guest-windows run ${run}| ${line}`),
    );
  }
  child.stdin?.write(`${credential.password}\n`);
  const result = await child;
  const output = result.all ?? '';
  const logPath = join(roleArtifacts, `setup-guest-windows.run-${run}.log`);
  writeFileSync(logPath, output);
  return { run, exitCode: result.exitCode, output, logPath };
}

async function recordRebootEvidence(result: SetupRun): Promise<void> {
  let pendingReboot: RebootProbeEvidence;
  try {
    const probe = await probePendingReboot({ executor });
    pendingReboot = { pending: probe.pending, markers: probe.markers };
  } catch (error) {
    pendingReboot = { error: error instanceof Error ? error.message : String(error) };
  }
  appendFileSync(
    rebootEvidencePath,
    formatRebootEvidence({
      run: result.run,
      exitCode: result.exitCode ?? -1,
      log: result.output,
      pendingReboot,
    }),
  );
}

async function capture(script: string): Promise<string> {
  const { stdout } = await session.capture(script);
  return stdout;
}

function footerOf(output: string): string {
  const start = output.indexOf('setup-guest-windows: residual state');
  return start === -1 ? '' : output.slice(start);
}

async function collectDiagnosticsOnce(): Promise<void> {
  if (diagnosticsCollected || !session) return;
  diagnosticsCollected = true;
  await collectWindowsDiagnostics(session, ROLE, {
    exec,
    files: [run1, run2]
      .filter((result): result is SetupRun => result !== undefined && existsSync(result.logPath))
      .map((result) => ({ path: result.logPath, name: `diagnostics-${result.run}.log` })),
  });
}

function assertNoSecretsInArtifacts(): void {
  artifactsScanned = true;
  const findings = scanArtifactsForSecrets(roleArtifacts, secretsUnderTest());
  expect(findings, 'a password leaked into output or a collected artifact').toEqual([]);
}

describe('setup-guest-windows against a disposable Windows 11 guest', () => {
  beforeAll(async () => {
    mkdirSync(roleArtifacts, { recursive: true });
    credential = ensureWindowsCredential();
    stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
    share = await createTestShare(exec, sharePath);
    const internal = resolveIsolationNetwork(ISOLATION_NAME);
    if (!internal.found) throw new Error(`${ROLE}: ${internal.adapterAlias} has no IPv4 address`);
    internalHostIp = internal.address;
    const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
    if (!natNetwork) throw new Error(`${ROLE}: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
    defaultSwitchHostIp = natNetwork.address;
    proxyFingerprint = createHash('sha256')
      .update(new X509Certificate(readFileSync(join(sharePath, 'cert.pem'), 'utf8')).raw)
      .digest('hex');

    // Staging on the host: the failing post-isolation step goes straight into the
    // generated share. update-shares would renumber a customization (99-fail.ps1
    // becomes 03-fail.ps1), and the step's name is part of what the footer must show.
    writeFileSync(
      failStepInShare,
      "throw 'windowsE2e: deliberate failure to prove the residual-state footer and replay'\n",
    );
    writeFileSync(
      join(sharePath, 'github-config.txt'),
      [
        'GITHUB_USERNAME="susentorno-test-user"',
        'GITHUB_EMAIL="susentorno-test@example.com"',
        `GITHUB_TOKEN="${GITHUB_PLACEHOLDER_PAT}"`,
        '',
      ].join('\n'),
    );

    // Staging in the guest: it boots on the Default Switch, exactly the state the
    // command's contract starts from, with nothing installed but WinGet.
    guest = await createWindowsTestGuest(exec, ROLE, 'Default Switch', artifactsDir);
    executor = createWindowsGuestExecutor({ vmName: guest.vmName, credential });
    session = createWindowsGuestExec(executor);
    await waitForPowerShellDirect(executor, {
      onProgress: (ms) =>
        console.log(`${ROLE}: waiting for PowerShell Direct... (${Math.round(ms / 1000)}s)`),
    });
    await assertGuestElevated(session);
    executionPolicyBefore = (await capture('Get-ExecutionPolicy -List | Out-String')).trim();
    vcRuntimeAbsentBefore = /False/i.test(
      await capture(
        "Test-Path -LiteralPath (Join-Path ([Environment]::SystemDirectory) 'vcruntime140.dll')",
      ),
    );
    console.log(`${ROLE}: vcruntime140.dll absent from the clean image: ${vcRuntimeAbsentBefore}`);
    const staged = await session.capture(buildGhShimStagingScript());
    expect(staged.exitCode, staged.stdout).toBe(0);

    // Run 1: a real failure at the last post-isolation step.
    run1 = await runSetupGuestWindows(1);
    await recordRebootEvidence(run1);
    if (run1.exitCode !== 1 || !run1.output.includes(`at step ${failStepName}`)) {
      throw new Error(
        `${ROLE}: run 1 was expected to fail at G13 on ${failStepName} but exited ${run1.exitCode}. ` +
          `See ${run1.logPath}. Footer:\n${footerOf(run1.output)}`,
      );
    }

    // Run 2: remove the failing step and replay everything from the isolated guest.
    rmSync(failStepInShare, { force: true });
    run2 = await runSetupGuestWindows(2);
    await recordRebootEvidence(run2);
    if (run2.exitCode !== 0) {
      throw new Error(
        `${ROLE}: run 2 (the replay) must exit 0 but exited ${run2.exitCode}. See ${run2.logPath}. ` +
          `Footer:\n${footerOf(run2.output)}`,
      );
    }

    await waitForPowerShellDirect(executor, { timeoutMs: 5 * 60_000 });
    const route = await session.capture(
      "(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | " +
        'Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex',
    );
    expect(route.exitCode, route.stdout).toBe(0);
    interfaceIndex = route.stdout.trim();
    expect(interfaceIndex, 'the isolated guest must have a default route').toMatch(/^\d+$/);
  }, 7_200_000);

  afterAll(async () => {
    let leak: unknown;
    try {
      await collectDiagnosticsOnce().catch(() => {});
      if (roleArtifacts && credential && share && !artifactsScanned) assertNoSecretsInArtifacts();
    } catch (error) {
      leak = error;
    }
    if (executor) await executor.dispose().catch(() => {});
    if (guest) await destroyWindowsTestGuest(exec, guest).catch(() => {});
    if (share) await removeTestShare(exec, sharePath).catch(() => {});
    if (stack) await stopProxyStack(stack).catch(() => {});
    if (leak) throw leak;
  }, 900_000);

  describe('run 1: a deliberate failure in the isolated phase', () => {
    it('exits 1 at G13 on the failing post-isolation step, after every real step ran', () => {
      expect(run1.exitCode).toBe(1);
      expect(run1.output).toContain('failed in phase G13');
      expect(run1.output).toContain(`at step ${failStepName}`);
      for (const step of [
        '01-install-packages.ps1',
        '02-install-pnpm.ps1',
        '03-install-tools.ps1',
        '04-configure-network.ps1',
      ]) {
        expect(run1.output).toContain(`running step pre-scripts/${step}`);
      }
      for (const step of ['01-auth-config.ps1', '02-apply-home-jq-transforms.ps1', failStepName]) {
        expect(run1.output).toContain(`running step post-scripts/${step}`);
      }
    });

    it('prints the real residual-state footer from queried Hyper-V state', () => {
      const footer = footerOf(run1.output);
      expect(footer).toContain('Failed in phase: G13');
      expect(footer).toContain(`Failed step: ${failStepName}`);
      expect(footer).toContain(
        `VM '${guest.vmName}': Running, attached to '${internalSwitchName}'`,
      );
      expect(footer).toContain(
        `VM share credential for Default Switch host address ${defaultSwitchHostIp}: verified, kept`,
      );
      expect(footer).toContain(
        `VM share credential for Internal switch host address ${internalHostIp}: verified, kept`,
      );
      expect(footer).toContain("Rerun 'susentorno setup-guest-windows'");
    });
  });

  describe('run 2: the replay', () => {
    it('exits 0 after the failing step is removed', () => {
      expect(run2.exitCode).toBe(0);
      expect(run2.output).toContain(`is set up and isolated on '${internalSwitchName}'`);
      expect(run2.output).not.toContain(failStepName);
    });

    it('replayed from the isolated guest, back through the Default Switch', () => {
      expect(run2.output).toMatch(/G1 reconciling '.*' to 'Default Switch'/);
      expect(run2.output).toMatch(/G9 isolating/);
    });
  });

  describe('reboot evidence', () => {
    it('is written for every run, with the production probe and the installer step outcomes', () => {
      const evidence = readFileSync(rebootEvidencePath, 'utf8');
      for (const run of [1, 2]) expect(evidence).toContain(`setup-guest-windows run ${run}:`);
      expect(evidence).toContain('pending-reboot probe: none');
      expect(evidence).not.toContain('PENDING');
      expect(evidence).toContain('01-install-packages.ps1: completed');
      expect(evidence).toContain('02-install-pnpm.ps1: completed');
      expect(evidence).toContain('03-install-tools.ps1: completed');
    });

    it('shows no installer asked for a reboot', () => {
      const evidence = readFileSync(rebootEvidencePath, 'utf8');
      expect(evidence).not.toContain('reboot-related output');
    });
  });

  describe('the isolated guest took its configuration entirely from the host', () => {
    it('took its address from the real DHCP server', async () => {
      const stdout = await capture(
        `Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex ${interfaceIndex} | ` +
          'ForEach-Object { "$($_.IPAddress) $($_.PrefixOrigin) $($_.SuffixOrigin)" }',
      );
      expect(stdout).toContain('Dhcp');
      const [address] = stdout.trim().split(/\s+/);
      expect(address.split('.').slice(0, 3).join('.')).toBe(
        internalHostIp.split('.').slice(0, 3).join('.'),
      );
    });

    it('has one default route, from the DHCP lease, and no direct Internet route', async () => {
      const stdout = await capture(
        "(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0').NextHop",
      );
      expect(stdout.trim().split(/\s+/)).toEqual([internalHostIp]);
      const adapters = await capture('@(Get-NetAdapter | Where-Object Status -eq Up).Count');
      expect(adapters.trim()).toBe('1');
    });

    it('took the host as its only resolver from the DHCP lease', async () => {
      const stdout = await capture(
        `(Get-DnsClientServerAddress -AddressFamily IPv4 -InterfaceIndex ${interfaceIndex}).ServerAddresses`,
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('resolves names through the real DNS responder', async () => {
      const stdout = await capture(
        "(Resolve-DnsName -Name example.com -Type A -DnsOnly | Where-Object Type -eq 'A' | " +
          'Select-Object -First 1).IPAddress',
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('has no in-guest DNS responder doing any of it', async () => {
      const stdout = await capture(
        "if (Get-ScheduledTask -TaskName 'SusentornoDnsResponder' -ErrorAction SilentlyContinue) " +
          "{ 'present' } else { 'absent' }",
      );
      expect(stdout.trim()).toBe('absent');
    });
  });

  describe('the network boundary behaves', () => {
    it('allows an allow-listed :80 host', async () => {
      const stdout = await capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/",
      );
      expect(Number(stdout.trim())).toBeLessThan(400);
    });

    it('passes through an allow-listed :443 host, validated against public roots', async () => {
      const stdout = await capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 30 https://pypi.org/",
      );
      expect(Number(stdout.trim())).toBeLessThan(400);
    });

    it('terminates a TLS-intercepted :443 host with the trusted proxy CA', async () => {
      // --ssl-no-revoke: src/ca.ts issues leaves with no CRL or OCSP endpoint,
      // and Schannel fails closed on unknown revocation status. Chain
      // validation stays active; only revocation is waived, and only where
      // susentorno itself is the issuer. verify-config.ps1 documents the same.
      const stdout = await capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --ssl-no-revoke --max-time 20 https://api.anthropic.com/",
      );
      expect(stdout.trim()).toBe('200');
    });

    it('lets git speak TLS through the proxy on schannel', async () => {
      const stdout = await capture(
        'git -c http.schannelCheckRevoke=false ls-remote https://github.com/git/git HEAD 2>&1 | ' +
          'Out-String; "exit=$LASTEXITCODE"',
      );
      expect(stdout, stdout).toContain('exit=0');
      expect(stdout).toMatch(/[0-9a-f]{40}\s+HEAD/);
    });

    it('drops a non-allow-listed :443 connection', async () => {
      const stdout = await capture(
        '& curl.exe -s -o NUL --max-time 20 https://blocked.example.com/ 2>&1 | Out-Null; ' +
          '"exit=$LASTEXITCODE"',
      );
      expect(stdout.trim()).not.toBe('exit=0');
    });

    it('returns default-deny 403 for a non-allow-listed :80 host', async () => {
      const stdout = await capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 http://blocked.example.com/",
      );
      expect(stdout.trim()).toBe('403');
    });
  });

  describe('trust was reconciled by the production reconciler and verified by configure-network', () => {
    it('has the proxy CA fingerprint in the machine root store', async () => {
      const stdout = await capture(
        "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine'); " +
          "$s.Open('ReadOnly'); $sha = [System.Security.Cryptography.SHA256]::Create(); " +
          '$s.Certificates | ForEach-Object { ($sha.ComputeHash($_.RawData) | ForEach-Object { $_.ToString("x2") }) -join "" }; ' +
          '$s.Close()',
      );
      expect(stdout.split(/\r?\n/).map((line) => line.trim())).toContain(proxyFingerprint);
    });

    it('records the proxy CA fingerprint in the manifest', async () => {
      const stdout = await capture(
        `(Get-Content -Raw -LiteralPath '${GUEST_TRUST_DIR}\\manifest.json' | ConvertFrom-Json).proxy`,
      );
      expect(stdout.trim()).toBe(proxyFingerprint);
    });

    it('points machine NODE_EXTRA_CA_CERTS at the combined bundle, which exists', async () => {
      const stdout = await capture(
        "$p = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','Machine'); " +
          'if ($p -and (Test-Path -LiteralPath $p)) { "ok $p" } else { "missing $p" }',
      );
      expect(stdout.trim()).toBe(`ok ${GUEST_TRUST_BUNDLE_PATH}`);
    });

    it('set git to validate through schannel', async () => {
      const stdout = await capture('git config --global http.sslBackend');
      expect(stdout.trim()).toBe('schannel');
    });
  });

  describe('the shipped tools installed for real and resolve in a fresh process', () => {
    for (const tool of ['jq', 'git', 'node', 'pnpm', 'pi', 'claude', 'codex']) {
      it(`${tool} reports a version`, async () => {
        const stdout = await capture(
          `$out = & ${tool} --version 2>&1 | Out-String; "exit=$LASTEXITCODE"; $out`,
        );
        expect(stdout, stdout).toContain('exit=0');
        expect(stdout.replace(/exit=0/, '').trim(), stdout).not.toBe('');
      });
    }

    it('installed the VC++ runtime through WinGet when the clean image lacked it, and only then', async () => {
      const installMessage = 'installing Microsoft.VCRedist.2015+.x64';
      const present = await capture(
        "Test-Path -LiteralPath (Join-Path ([Environment]::SystemDirectory) 'vcruntime140.dll')",
      );
      expect(present, present).toMatch(/True/i);
      if (vcRuntimeAbsentBefore) expect(run1.output).toContain(installMessage);
      expect(run2.output, 'a replay must skip the already-installed runtime').not.toContain(
        installMessage,
      );
    });

    it('installed the real GitHub.cli package even though the shim shadows gh', async () => {
      const real = await capture(
        "$exe = Join-Path $env:ProgramFiles 'GitHub CLI\\gh.exe'; " +
          'if (Test-Path -LiteralPath $exe) { (& $exe --version 2>&1 | Out-String); "exit=$LASTEXITCODE" } else { "missing $exe" }',
      );
      expect(real, real).toContain('gh version');
      expect(real).toContain('exit=0');
      const resolved = await capture('(Get-Command gh).Source');
      expect(resolved.trim().toLowerCase()).toBe(`${GH_SHIM_DIRECTORY}\\gh.cmd`.toLowerCase());
    });
  });

  describe('post-isolation configuration was applied', () => {
    it('01-auth-config set the git identity from github-config.txt', async () => {
      expect((await capture('git config --global user.name')).trim()).toBe('susentorno-test-user');
      expect((await capture('git config --global user.email')).trim()).toBe(
        'susentorno-test@example.com',
      );
    });

    it('01-auth-config installed the placeholder claude credential', async () => {
      const stdout = await capture(
        "Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.claude\\.credentials.json')",
      );
      expect(stdout).toContain('sk-ant-oat-susentorno-PLACEHOLDER');
    });

    it('01-auth-config exposes the host real codex account id through ~/.codex/auth.json', async () => {
      const stdout = await capture(
        "(Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.codex\\auth.json') | ConvertFrom-Json).tokens.account_id",
      );
      expect(stdout.trim()).toBe(HOST_CODEX_ACCOUNT_ID);
    });

    it('the home settings transform set hasCompletedOnboarding', async () => {
      const stdout = await capture(
        "(Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.claude.json') | ConvertFrom-Json).hasCompletedOnboarding",
      );
      expect(stdout.trim()).toBe('True');
    });

    it('left the persistent execution policy exactly as the golden image had it', async () => {
      const after = (await capture('Get-ExecutionPolicy -List | Out-String')).trim();
      expect(after).toBe(executionPolicyBefore);
    });
  });

  describe('the VM share', () => {
    it('is reachable by UNC on the Internal-switch address with no drive mapping', async () => {
      const stdout = await capture(
        `Get-ChildItem -LiteralPath '\\\\${internalHostIp}\\${share.shareName}' | Out-Null; ` +
          `Test-Path -LiteralPath '\\\\${internalHostIp}\\${share.shareName}\\cert.pem'; ` +
          '"mappings=" + @(Get-SmbMapping -ErrorAction SilentlyContinue).Count; ' +
          '"drives=" + @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.DisplayRoot }).Count',
      );
      expect(stdout).toMatch(/True/i);
      expect(stdout).toContain('mappings=0');
      expect(stdout).toContain('drives=0');
    });

    it('holds a credential target for both host addresses', async () => {
      const stdout = await capture('cmdkey /list');
      expect(stdout).toContain(`target=${defaultSwitchHostIp}`);
      expect(stdout).toContain(`target=${internalHostIp}`);
    });
  });

  describe('operations', () => {
    it('collects the Windows diagnostics', async () => {
      await collectDiagnosticsOnce();
      for (const name of [
        'network.txt',
        'trust-managed.txt',
        'cmdkey-targets.txt',
        'pending-reboot.txt',
        'winget-logs.txt',
        'diagnostics-1.log',
        'diagnostics-2.log',
      ]) {
        expect(existsSync(join(roleArtifacts, name)), name).toBe(true);
      }
      expect(readFileSync(join(roleArtifacts, 'cmdkey-targets.txt'), 'utf8')).toContain(
        internalHostIp,
      );
    }, 300_000);

    it('keeps both passwords out of every run log and collected artifact', () => {
      assertNoSecretsInArtifacts();
    });
  });

  describe('the retained Default-Switch credential', () => {
    // Last, because it moves the VM: back on the Default Switch, the address that is
    // unreachable while isolated proves the credential setup kept for it still works.
    it('reads the share by UNC on the Default-Switch address', async () => {
      await reconcileVmToSwitch(
        { exec, vmName: guest.vmName, offConfirmTimeoutMs: 60_000 },
        'Default Switch',
      );
      await waitForPowerShellDirect(executor, { timeoutMs: 10 * 60_000 });
      const readiness = await waitForProductionPowerShellDirect(executor, { deadlineMs: 120_000 });
      expect(readiness).toBe('ready');
      const stdout = await capture(
        `Get-ChildItem -LiteralPath '\\\\${defaultSwitchHostIp}\\${share.shareName}' | Out-Null; ` +
          `Test-Path -LiteralPath '\\\\${defaultSwitchHostIp}\\${share.shareName}\\cert.pem'`,
      );
      expect(stdout, stdout).toMatch(/True/i);
    }, 1_200_000);

    it('classifies a wrong guest password as an authentication rejection, from the real bridge', async () => {
      // The bridge decides this from PowerShell Direct's exception, not from its
      // localized message; the running guest is the only place that can be proven.
      const wrong = createWindowsGuestExecutor({
        vmName: guest.vmName,
        credential: { username: credential.username, password: 'not-the-guest-password-9!' },
      });
      try {
        expect(await waitForProductionPowerShellDirect(wrong, { deadlineMs: 120_000 })).toBe(
          'auth-rejected',
        );
      } finally {
        await wrong.dispose();
      }
    }, 300_000);
  });
});

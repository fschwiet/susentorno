import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { generateRootCa, generateLeaf } from '../../src/ca';
import { propagateAmbientTrust, ambientCaFileName } from '../../src/guestSetup/ambientTrust';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { GUEST_USERNAME } from './autoinstall';
import { createHarnessRemoteExec, guestCapture } from './guestExec';
import { ISOLATION_NAME } from './hyperv/imageCache';
import { createTestGuest, destroyTestGuest, type TestGuest } from './hyperv/testGuest';
import {
  buildImportLocalMachineRootCertCommand,
  parseImportedThumbprint,
  buildRemoveLocalMachineRootCertCommand,
} from './hyperv/localMachineRoot';

const exec = createRealPowerShellExec();

let stack: ProxyStack;
let guest: TestGuest;
let target: SshTarget;
let throwawayThumbprint: string | undefined;
let throwawayCertPath: string | undefined;

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
  if (!natNetwork) throw new Error(`ambientTrust: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
  guest = await createTestGuest(exec, 'ambientTrust', 'Default Switch', natNetwork, artifactsDir);
  target = { address: guest.address, username: GUEST_USERNAME };
}, 1_800_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'ambientTrust').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('propagateAmbientTrust against a throwaway host CA', () => {
  afterEach(async () => {
    // Guaranteed regardless of assertion outcome: a lingering throwaway root in
    // Cert:\LocalMachine\Root is at worst inert (its private key is never
    // written anywhere), but it must not survive the test either way.
    if (throwawayThumbprint) {
      await exec.run(buildRemoveLocalMachineRootCertCommand(throwawayThumbprint));
      throwawayThumbprint = undefined;
    }
    if (throwawayCertPath) {
      rmSync(throwawayCertPath, { force: true });
      throwawayCertPath = undefined;
    }
  });

  it('detects a throwaway CA, installs it, chains a real leaf, and is idempotent on rerun', async () => {
    const { caCertPem, caKeyPem } = generateRootCa();
    // The leaf is minted now, while caKeyPem is still in scope — it is never
    // used again after this line, never written to disk, never passed to
    // PowerShell.
    const { leafCertPem } = generateLeaf(caCertPem, caKeyPem, ['ambient-test.invalid']);

    throwawayCertPath = join(
      tmpdir(),
      `susentorno-ambient-test-${randomBytes(8).toString('hex')}.crt`,
    );
    writeFileSync(throwawayCertPath, caCertPem);
    const imported = await exec.run(buildImportLocalMachineRootCertCommand(throwawayCertPath));
    expect(imported.exitCode, imported.stdout).toBe(0);
    throwawayThumbprint = parseImportedThumbprint(imported.stdout);

    // This host's LocalMachine\Root store may already diverge from the
    // guest's default ca-certificates bundle for reasons unrelated to this
    // throwaway CA — Windows' Automatic Root Certificates Update populates
    // Cert:\LocalMachine\Root lazily, per-cert, only as apps on this specific
    // machine encounter them, whereas Ubuntu's ca-certificates package ships
    // the full Mozilla bundle proactively. So >= 1 (not === 1) is the correct
    // assertion; what matters is that the throwaway CA specifically is among
    // them, which is what expectedFileName pins down.
    const expectedFileName = ambientCaFileName(
      createHash('sha256').update(new X509Certificate(caCertPem).raw).digest('hex'),
    );
    const remoteExec = createHarnessRemoteExec(target);
    const installedFirstRun = await propagateAmbientTrust(exec, remoteExec);
    expect(installedFirstRun.length).toBeGreaterThanOrEqual(1);
    expect(installedFirstRun).toContain(expectedFileName);

    const present = await guestCapture(
      target,
      `test -f /usr/local/share/ca-certificates/${expectedFileName} && echo present`,
    );
    expect(present.stdout.trim()).toBe('present');

    const encodedLeaf = Buffer.from(leafCertPem, 'utf8').toString('base64');
    const remoteLeafPath = '~/susentorno-ambient-test-leaf.pem';
    const writeLeaf = await guestCapture(
      target,
      `printf %s '${encodedLeaf}' | base64 -d > ${remoteLeafPath}`,
    );
    expect(writeLeaf.exitCode, writeLeaf.stdout).toBe(0);
    const verify = await guestCapture(
      target,
      `openssl verify -purpose sslserver -CAfile /etc/ssl/certs/ca-certificates.crt ${remoteLeafPath}`,
    );
    expect(verify.stdout).toContain('OK');

    // Idempotent rerun: nothing new to install, and the first run's file is
    // still there — this is the concrete check for "this trust persists."
    const installedSecondRun = await propagateAmbientTrust(exec, remoteExec);
    expect(installedSecondRun).toEqual([]);
    const stillPresent = await guestCapture(
      target,
      `test -f /usr/local/share/ca-certificates/${expectedFileName} && echo present`,
    );
    expect(stillPresent.stdout.trim()).toBe('present');
  }, 900_000);
});

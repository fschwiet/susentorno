import { homedir } from 'node:os';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { createHostNetwork } from '../../src/hostNetwork/createHostNetwork';
import { deleteHostNetwork } from '../../src/hostNetwork/deleteHostNetwork';
import { detectTakenRanges, findFreeSubnet } from '../../src/hostNetwork/subnetSelection';
import { DEFAULT_NAT_ADAPTER } from '../../src/runHosting/forwarder';
import { checkDockerRunning } from '../checkDockerRunning';
import { checkElevated } from '../checkElevated';
import { checkGatewayPortsFree } from '../checkGatewayPortsFree';
import { ensureSshAgentIdentity, removeSshAgentIdentity } from '../sshAgentIdentity';
import { ensureHarnessKeys } from './harnessKeys';
import { ensureGoldenImage } from './hyperv/goldenImage';
import { harnessKeyPath, ISOLATION_NAME, windowsIsoPath } from './hyperv/imageCache';
import { sweepIsolationResidue } from './hyperv/sweep';
import { ensureWindowsCredential } from './hyperv/windowsCredential';
import { ensureWindowsGoldenImage } from './hyperv/windowsGoldenImage';

const exec = createRealPowerShellExec();

export async function setup(): Promise<void> {
  await checkElevated();
  await checkDockerRunning();
  await checkGatewayPortsFree();

  const keys = await ensureHarnessKeys();
  await ensureSshAgentIdentity(harnessKeyPath);
  await sweepIsolationResidue(exec);
  await ensureGoldenImage(exec, keys);

  // Optional by design: the Windows evaluation ISO cannot be fetched
  // unattended, so its absence skips the windowsFresh role rather than
  // failing the tier. See testing.md.
  if (windowsIsoPath() !== null) {
    console.log('guest: building/validating the Windows golden image...');
    await ensureWindowsGoldenImage(exec, ensureWindowsCredential());
  } else {
    console.log(
      'guest: SUSENTORNO_WINDOWS_ISO is not set — skipping the windowsFresh role. ' +
        'Set it to an x64 en-us Windows 11 Enterprise evaluation ISO to enable it (see testing.md).',
    );
  }

  await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() });
  const subnet = findFreeSubnet(detectTakenRanges());
  if (subnet === null) {
    throw new Error(
      'guest: no free 192.168.x.0/24 subnet is available for the test host network. ' +
        'Free one up, or delete a stale susentorno Internal switch, and re-run.',
    );
  }
  const { hostIp } = await createHostNetwork({
    exec,
    isolationName: ISOLATION_NAME,
    subnet,
    natAdapterAlias: DEFAULT_NAT_ADAPTER,
    homedir: homedir(),
    promptSubnet: async () => subnet,
  });
  console.log(`guest: host network ready — susentorno-test-internal at ${hostIp}`);
}

/** Named so Vitest can tear down resources even when setup itself rejects. */
export async function teardown(): Promise<void> {
  await sweepIsolationResidue(exec).catch((error) =>
    console.error(`guest teardown: sweep failed: ${String(error)}`),
  );
  await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() }).catch(
    (error) => console.error(`guest teardown: delete-host-network failed: ${String(error)}`),
  );
  await removeSshAgentIdentity(harnessKeyPath).catch(() => {});
}

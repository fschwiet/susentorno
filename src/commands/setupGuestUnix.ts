import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import {
  resolveForwardListenAddress,
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
  DEFAULT_NAT_ADAPTER,
} from '../runHosting/forwarder';
import { promptText, promptMasked } from '../cliPrompt';
import { listScripts } from '../guestSetup/listScripts';
import { createSshRemoteExec } from '../guestSetup/remoteExec';
import { mountShare, MountShareError } from '../guestSetup/mountShare';
import { runPreScripts, RunPreScriptsError } from '../guestSetup/runPreScripts';
import { runPostScripts, RunPostScriptsError } from '../guestSetup/runPostScripts';
import { ensureKvpDaemon, EnsureKvpDaemonError } from '../guestSetup/kvpDaemon';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import { isElevated } from '../guestSetup/elevationCheck';
import { runPreflightChecks } from '../guestSetup/preflightChecks';
import { checkRunHostingReady } from '../guestSetup/runHostingReadiness';
import {
  reconcileVmToSwitch,
  isolateVmToSwitch,
  VmReconcileError,
  type VmReconcileDeps,
} from '../guestSetup/vmReconcile';
import { getVmIpAddresses } from '../guestSetup/hyperVQueries';
import { waitForReachable } from '../guestSetup/reachabilityWait';
import { realTcpConnect } from '../guestSetup/tcpConnect';

interface SetupGuestUnixOptions {
  adapterAlias: string;
  natAdapterAlias: string;
}

export interface ResolvedGuestNetwork {
  internalSwitchHostIp: string;
  defaultSwitchHostIp: string;
}

export interface GuestNetworkResolutionFailure {
  adapterAlias: string;
  hint: string;
}

export function resolveGuestNetwork(
  adapterAlias: string,
  natAdapterAlias: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): ResolvedGuestNetwork | GuestNetworkResolutionFailure {
  const internalSwitchHostIp = resolveForwardListenAddress(adapterAlias, interfaces);
  if (!internalSwitchHostIp) {
    return { adapterAlias, hint: 'Pass --adapter-alias, or complete setup-machine.md first.' };
  }
  const defaultSwitchHostIp = resolveForwardListenAddress(natAdapterAlias, interfaces);
  if (!defaultSwitchHostIp) {
    return {
      adapterAlias: natAdapterAlias,
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    };
  }
  return { internalSwitchHostIp, defaultSwitchHostIp };
}

function isResolutionFailure(
  result: ResolvedGuestNetwork | GuestNetworkResolutionFailure,
): result is GuestNetworkResolutionFailure {
  return 'hint' in result;
}

const REACHABILITY_TROUBLESHOOTING_HINT =
  'See setup-guest.md\'s troubleshooting section (the host firewall "allow node.exe on public networks?" dialog, etc.).';

export function registerSetupGuestUnix(program: Command): void {
  program
    .command('setup-guest-unix')
    .description(
      "Run the entire Ubuntu guest setup path over SSH and PowerShell: mount this environment's SMB " +
        'share, run pre-scripts/, isolate the guest onto the Internal switch, re-mount the share there, ' +
        'and run post-scripts/. Requires an elevated (Administrator) PowerShell/terminal. A failed run is ' +
        'safe to retry — every step reruns from the top — but a woven-in custom pre-/post-script must be ' +
        'idempotent itself for that retry to be safe.',
    )
    .option('--adapter-alias <name>', 'Internal-switch adapter', DEFAULT_INTERNAL_SWITCH_ADAPTER)
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .action(async (options: SetupGuestUnixOptions) => {
      const exec = createRealPowerShellExec();
      if (!(await isElevated(exec))) {
        console.error(
          'setup-guest-unix: this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
        );
        process.exitCode = 1;
        return;
      }

      const paths = requireEnvPathsOrExit('setup-guest-unix');
      if (!paths) return;

      const resolved = resolveGuestNetwork(options.adapterAlias, options.natAdapterAlias);
      if (isResolutionFailure(resolved)) {
        console.error(
          `setup-guest-unix: could not find an IPv4 address on adapter '${resolved.adapterAlias}'. ${resolved.hint}`,
        );
        process.exitCode = 1;
        return;
      }
      const { internalSwitchHostIp, defaultSwitchHostIp } = resolved;

      const vmName = await promptText('Hyper-V VM name');

      const preflight = await runPreflightChecks({
        exec,
        vmName,
        adapterAlias: options.adapterAlias,
        natAdapterAlias: options.natAdapterAlias,
        internalSwitchHostIp,
      });
      if (!preflight.ok) {
        console.error(`setup-guest-unix: ${preflight.message}`);
        process.exitCode = 1;
        return;
      }
      const { defaultSwitchName, internalSwitchName } = preflight;

      const address = await promptText('Guest address (hostname or IP)');
      const username = await promptText('Guest username');
      const shareName = await promptText('SMB share name', 'vm-shared-linux');
      const accountName = await promptText('Share account name', 'susentorno-share');
      const password = await promptMasked('SMB share password');

      const preScripts = listScripts(join(paths.vmShared, 'pre-scripts'));
      const postScripts = listScripts(join(paths.vmShared, 'post-scripts'));
      const onStep = (message: string) => console.log(`\nsetup-guest-unix: ${message}...\n`);
      const onProgress = (elapsedMs: number) =>
        console.log(
          `setup-guest-unix: waiting for guest to become reachable... (${Math.round(elapsedMs / 1000)}s elapsed)`,
        );
      const vmReconcileDeps: VmReconcileDeps = { exec, vmName };

      try {
        console.log(`setup-guest-unix: reconciling '${vmName}' to '${defaultSwitchName}'...`);
        const reconcileOutcome = await reconcileVmToSwitch(vmReconcileDeps, defaultSwitchName);

        let setupAddress: string;
        if (reconcileOutcome.started) {
          const setupReachability = await waitForReachable({
            getCandidates: async () => [address, ...(await getVmIpAddresses(exec, vmName))],
            connect: realTcpConnect,
            onProgress,
          });
          if (!setupReachability.reachable) {
            console.error(
              `setup-guest-unix: guest did not become reachable on port 22. ${REACHABILITY_TROUBLESHOOTING_HINT}`,
            );
            process.exitCode = 1;
            return;
          }
          setupAddress = setupReachability.address;
        } else {
          // No power/network event happened — the guest was already Running
          // on the target switch, so the address the user just typed is
          // still assumed valid; no reachability wait is needed.
          setupAddress = address;
        }

        const remoteExec = createSshRemoteExec({ address: setupAddress, username });

        await ensureKvpDaemon(remoteExec, onStep);

        await mountShare(remoteExec, {
          shareName,
          accountName,
          password,
          hostIp: defaultSwitchHostIp,
          onStep,
        });
        await runPreScripts(remoteExec, {
          scripts: preScripts,
          shareName,
          internalSwitchHostIp,
          onStep,
        });

        const readiness = await checkRunHostingReady(exec, internalSwitchHostIp);
        if (!readiness.dhcpBound || !readiness.dnsBound) {
          console.error(
            `setup-guest-unix: run-hosting is no longer listening on ${internalSwitchHostIp} — ` +
              `start 'susentorno run-hosting' and rerun.`,
          );
          process.exitCode = 1;
          return;
        }

        console.log(`setup-guest-unix: isolating '${vmName}' to '${internalSwitchName}'...`);
        await isolateVmToSwitch(vmReconcileDeps, internalSwitchName);

        const isolatedReachability = await waitForReachable({
          getCandidates: () => getVmIpAddresses(exec, vmName),
          connect: realTcpConnect,
          onProgress,
        });
        if (!isolatedReachability.reachable) {
          console.error(
            `setup-guest-unix: guest did not become reachable on port 22 after isolation. ${REACHABILITY_TROUBLESHOOTING_HINT}`,
          );
          process.exitCode = 1;
          return;
        }

        const isolatedRemoteExec = createSshRemoteExec({
          address: isolatedReachability.address,
          username,
        });

        await mountShare(isolatedRemoteExec, {
          shareName,
          accountName,
          password,
          hostIp: internalSwitchHostIp,
          onStep,
        });
        await runPostScripts(isolatedRemoteExec, { scripts: postScripts, shareName, onStep });
      } catch (error) {
        if (
          error instanceof MountShareError ||
          error instanceof RunPreScriptsError ||
          error instanceof RunPostScriptsError ||
          error instanceof EnsureKvpDaemonError ||
          error instanceof VmReconcileError
        ) {
          console.error(`setup-guest-unix: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      console.log('setup-guest-unix: isolation and post-scripts/ completed on the guest.');
    });
}

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { resolveForwardListenAddress, DEFAULT_NAT_ADAPTER } from '../runHosting/forwarder';
import {
  createHostNetworkHint,
  resolveHostNetworkNames,
  HostNetworkError,
} from '../hostNetwork/hostNetworkNames';
import { promptText, promptMasked } from '../cliPrompt';
import {
  resolveVmNameAnswer,
  resolveConnectionAnswers,
  type SetupAnswerPrompts,
} from '../guestSetup/setupAnswers';
import { listScripts } from '../guestSetup/listScripts';
import { createSshRemoteExec } from '../guestSetup/remoteExec';
import { mountShare, MountShareError } from '../guestSetup/mountShare';
import { propagateAmbientTrust, AmbientTrustError } from '../guestSetup/ambientTrust';
import { HostTrustStoreError } from '../guestSetup/hostTrustStore';
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
  isolationName?: string;
  natAdapterAlias: string;
  vmName?: string;
  guestAddress?: string;
  guestUsername?: string;
  shareName?: string;
  shareAccount?: string;
}

export interface ResolvedGuestNetwork {
  internalAdapterAlias: string;
  internalSwitchName: string;
  internalSwitchHostIp: string;
  defaultSwitchHostIp: string;
}

export interface GuestNetworkResolutionFailure {
  adapterAlias: string;
  hint: string;
}

export function resolveGuestNetwork(
  isolationName: string | undefined,
  natAdapterAlias: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): ResolvedGuestNetwork | GuestNetworkResolutionFailure {
  const names = resolveHostNetworkNames(isolationName);
  const internalSwitchHostIp = resolveForwardListenAddress(names.adapterAlias, interfaces);
  if (!internalSwitchHostIp) {
    return { adapterAlias: names.adapterAlias, hint: createHostNetworkHint(isolationName) };
  }
  const defaultSwitchHostIp = resolveForwardListenAddress(natAdapterAlias, interfaces);
  if (!defaultSwitchHostIp) {
    return {
      adapterAlias: natAdapterAlias,
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    };
  }
  return {
    internalAdapterAlias: names.adapterAlias,
    internalSwitchName: names.switchName,
    internalSwitchHostIp,
    defaultSwitchHostIp,
  };
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
    .option(
      '--isolation-name <name>',
      'Host network to attach the guest to, as passed to create-host-network ' +
        '(letters, digits, and hyphens only); omit for the default one',
    )
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .option('--vm-name <name>', 'Hyper-V VM name, skipping its prompt')
    .option('--guest-address <host>', 'Guest hostname or IP, skipping its prompt')
    .option('--guest-username <user>', 'Guest username, skipping its prompt')
    .option(
      '--share-name <name>',
      'SMB share name, skipping its prompt (prompt default: vm-shared-linux)',
    )
    .option(
      '--share-account <name>',
      'Share account name, skipping its prompt (prompt default: susentorno)',
    )
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

      const prompts: SetupAnswerPrompts = {
        text: (question, defaultValue) => promptText(question, defaultValue),
        masked: (question) => promptMasked(question),
      };

      let resolved: ResolvedGuestNetwork | GuestNetworkResolutionFailure;
      try {
        resolved = resolveGuestNetwork(options.isolationName, options.natAdapterAlias);
      } catch (error) {
        // Caught here rather than left to escape: an escaping throw would leave
        // the action handler entirely and print a stack trace for a typo'd flag.
        if (error instanceof HostNetworkError) {
          console.error(`setup-guest-unix: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      if (isResolutionFailure(resolved)) {
        console.error(
          `setup-guest-unix: could not find an IPv4 address on adapter '${resolved.adapterAlias}'. ${resolved.hint}`,
        );
        process.exitCode = 1;
        return;
      }
      const {
        internalAdapterAlias,
        internalSwitchName,
        internalSwitchHostIp,
        defaultSwitchHostIp,
      } = resolved;

      // Two stages either side of preflight, deliberately: a bad VM name or a
      // missing switch fails before the user types five more answers.
      const vmName = await resolveVmNameAnswer(options, prompts);

      const preflight = await runPreflightChecks({
        exec,
        vmName,
        internalAdapterAlias,
        internalSwitchName,
        natAdapterAlias: options.natAdapterAlias,
        internalSwitchHostIp,
      });
      if (!preflight.ok) {
        console.error(`setup-guest-unix: ${preflight.message}`);
        process.exitCode = 1;
        return;
      }
      const { defaultSwitchName } = preflight;

      const { address, username, shareName, accountName, password } =
        await resolveConnectionAnswers(options, prompts);

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

        await propagateAmbientTrust(exec, remoteExec, onStep);

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
          error instanceof VmReconcileError ||
          error instanceof HostTrustStoreError ||
          error instanceof AmbientTrustError
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

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import {
  resolveForwardListenAddress,
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
} from '../runHosting/forwarder';
import { promptText, promptMasked } from '../cliPrompt';
import { listPreScripts } from '../guestSetup/listPreScripts';
import { createSshRemoteExec } from '../guestSetup/remoteExec';
import { mountShare, MountShareError } from '../guestSetup/mountShare';
import { runPreScripts, RunPreScriptsError } from '../guestSetup/runPreScripts';

const DEFAULT_NAT_ADAPTER = 'vEthernet (Default Switch)';

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

export function registerSetupGuestUnix(program: Command): void {
  program
    .command('setup-guest-unix')
    .description(
      "Mount this environment's SMB share and run every pre-scripts/ script on an Ubuntu guest over SSH. " +
        'A failed run is safe to retry for the built-in scripts; a woven-in custom pre-script must be ' +
        'idempotent itself for a retry to be safe, the same responsibility you already have when authoring one.',
    )
    .option('--adapter-alias <name>', 'Internal-switch adapter', DEFAULT_INTERNAL_SWITCH_ADAPTER)
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .action(async (options: SetupGuestUnixOptions) => {
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

      const address = await promptText('Guest address (hostname or IP)');
      const username = await promptText('Guest username');
      const shareName = await promptText('SMB share name', 'vm-shared-linux');
      const accountName = await promptText('Share account name', 'susentorno-share');
      const password = await promptMasked('SMB share password');

      const scripts = listPreScripts(join(paths.vmShared, 'pre-scripts'));
      const remoteExec = createSshRemoteExec({ address, username });
      const onStep = (message: string) => console.log(`setup-guest-unix: ${message}...`);

      try {
        await mountShare(remoteExec, {
          shareName,
          accountName,
          password,
          defaultSwitchHostIp,
          onStep,
        });
        await runPreScripts(remoteExec, { scripts, shareName, internalSwitchHostIp, onStep });
      } catch (error) {
        if (error instanceof MountShareError || error instanceof RunPreScriptsError) {
          console.error(`setup-guest-unix: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      console.log('setup-guest-unix: mount and pre-scripts/ completed on the guest.');
    });
}

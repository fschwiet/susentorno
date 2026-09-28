import { existsSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { envPaths } from '../../envPaths';
import { HostNetworkError } from '../../hostNetwork/hostNetworkNames';
import { isElevated } from '../elevationCheck';
import {
  isGuestNetworkResolutionFailure,
  resolveGuestNetwork,
  type ResolvedGuestNetwork,
} from '../guestNetwork';
import type { PowerShellExec } from '../powerShellExec';
import { deriveSwitchName } from '../switchName';

export interface HostPrerequisiteDeps {
  exec: PowerShellExec;
  cwd: string;
  exists?: (path: string) => boolean;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface HostPrerequisiteOptions {
  isolationName?: string;
  natAdapterAlias: string;
}

/** Everything phase H1 resolves, handed to the phase machine. */
export interface WindowsHostContext extends ResolvedGuestNetwork {
  /** This environment's generated Windows VM-share directory. */
  vmSharedWindowsPath: string;
  natAdapterAlias: string;
  defaultSwitchName: string;
}

export type HostPrerequisiteResult =
  { ok: true; context: WindowsHostContext } | { ok: false; message: string };

/**
 * Phase H1's checks, run before any prompt: host elevation first, then the
 * environment and its Windows VM share, then the isolation name, the adapter
 * alias, both switches, and both host IPv4 addresses. A failure is a message
 * for the command to print; nothing here throws for a bad flag.
 */
export async function resolveHostPrerequisites(
  deps: HostPrerequisiteDeps,
  options: HostPrerequisiteOptions,
): Promise<HostPrerequisiteResult> {
  const exists = deps.exists ?? existsSync;

  if (!(await isElevated(deps.exec))) {
    return {
      ok: false,
      message:
        'this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
    };
  }

  const paths = envPaths(deps.cwd);
  if (!exists(paths.root)) {
    return {
      ok: false,
      message: `no .susentorno in ${deps.cwd} — run 'susentorno init' first`,
    };
  }
  if (!exists(paths.vmSharedWindows)) {
    return {
      ok: false,
      message:
        `this environment has no Windows VM share at ${paths.vmSharedWindows} — ` +
        `run 'susentorno update-shares' to generate it.`,
    };
  }

  const defaultSwitchName = deriveSwitchName(options.natAdapterAlias);
  if (!defaultSwitchName) {
    return {
      ok: false,
      message:
        `--nat-adapter-alias '${options.natAdapterAlias}' does not look like a Hyper-V adapter alias ` +
        `(expected 'vEthernet (<switch name>)').`,
    };
  }

  let network: ResolvedGuestNetwork | ReturnType<typeof resolveGuestNetwork>;
  try {
    network = resolveGuestNetwork(
      options.isolationName,
      options.natAdapterAlias,
      deps.interfaces ?? networkInterfaces(),
    );
  } catch (error) {
    // A typo'd isolation name is a message, not a stack trace.
    if (error instanceof HostNetworkError) return { ok: false, message: error.message };
    throw error;
  }
  if (isGuestNetworkResolutionFailure(network)) {
    return {
      ok: false,
      message: `could not find an IPv4 address on adapter '${network.adapterAlias}'. ${network.hint}`,
    };
  }

  return {
    ok: true,
    context: {
      ...network,
      vmSharedWindowsPath: paths.vmSharedWindows,
      natAdapterAlias: options.natAdapterAlias,
      defaultSwitchName,
    },
  };
}

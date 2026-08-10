import { homedir } from 'node:os';
import type { Command } from 'commander';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import { isElevated } from '../guestSetup/elevationCheck';
import { promptText } from '../cliPrompt';
import { DEFAULT_NAT_ADAPTER } from '../runHosting/forwarder';
import { validateSubnet, type TakenRange } from '../hostNetwork/subnetSelection';
import { createHostNetwork } from '../hostNetwork/createHostNetwork';
import { HostNetworkError } from '../hostNetwork/hostNetworkError';

interface CreateHostNetworkCommandOptions {
  isolationName?: string;
  subnet?: number;
  natAdapterAlias: string;
}

/** Retries until a valid, free subnet octet is given — exported for its own unit test. */
export async function promptSubnetForCreateHostNetwork(
  taken: TakenRange[],
  defaultN: number,
): Promise<number> {
  for (;;) {
    const answer = await promptText('Subnet (192.168.<n>.x)', String(defaultN));
    const n = Number(answer);
    try {
      validateSubnet(n, taken);
      return n;
    } catch (error) {
      console.error(`create-host-network: ${(error as Error).message}`);
    }
  }
}

export function registerCreateHostNetwork(program: Command): void {
  program
    .command('create-host-network')
    .description(
      'Create the Hyper-V Internal switch, assign it a static host IP, and open the host firewall for VM ' +
        'traffic. Requires an elevated (Administrator) PowerShell/terminal. Safe to rerun against an existing ' +
        "switch — refreshes its firewall rules only, without recreating the switch or weakening any rule's scoping.",
    )
    .option(
      '--isolation-name <name>',
      'Suffix distinguishing this host network from the default (letters, digits, hyphens only) — for test sandboxing',
    )
    .option(
      '--subnet <n>',
      'Third octet of the 192.168.<n>.x subnet to use, skipping the interactive prompt',
      (v: string) => Number(v),
    )
    .option(
      '--nat-adapter-alias <alias>',
      "Default-Switch (NAT) adapter, needed for the SMB rule's NAT-side half",
      DEFAULT_NAT_ADAPTER,
    )
    .action(async (options: CreateHostNetworkCommandOptions) => {
      const exec = createRealPowerShellExec();
      if (!(await isElevated(exec))) {
        console.error(
          'create-host-network: this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
        );
        process.exitCode = 1;
        return;
      }

      if (options.subnet !== undefined && !Number.isInteger(options.subnet)) {
        console.error(
          `create-host-network: --subnet '${String(options.subnet)}' is not a valid integer.`,
        );
        process.exitCode = 1;
        return;
      }

      try {
        const result = await createHostNetwork({
          exec,
          isolationName: options.isolationName,
          subnet: options.subnet,
          natAdapterAlias: options.natAdapterAlias,
          homedir: homedir(),
          promptSubnet: promptSubnetForCreateHostNetwork,
        });

        if (result.refreshedOnly) {
          if (options.subnet !== undefined) {
            console.log(
              'create-host-network: switch already exists — the --subnet value was ignored (it only applies when creating a new switch).',
            );
          }
          console.log(
            `create-host-network: switch already existed at ${result.hostIp} — refreshed its firewall rules only.`,
          );
        } else {
          console.log(`create-host-network: created the host network at ${result.hostIp}.`);
          console.log(`  Use ${result.hostIp} as the host IP in guest setup (see setup-guest.md).`);
        }
      } catch (error) {
        if (error instanceof HostNetworkError) {
          console.error(`create-host-network: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}

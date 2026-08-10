import { homedir } from 'node:os';
import type { Command } from 'commander';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import { isElevated } from '../guestSetup/elevationCheck';
import { deleteHostNetwork } from '../hostNetwork/deleteHostNetwork';
import { HostNetworkError } from '../hostNetwork/hostNetworkError';

interface DeleteHostNetworkCommandOptions {
  isolationName?: string;
}

export function registerDeleteHostNetwork(program: Command): void {
  program
    .command('delete-host-network')
    .description(
      "Return the host network to a pristine state: remove every firewall rule scoped to the Internal switch's " +
        "adapter (regardless of who created it), remove the SMB rule's Default-Switch/NAT-adapter half, and " +
        'remove the switch itself. Requires an elevated (Administrator) PowerShell/terminal. Safe to rerun ' +
        'against an already-clean or partially-broken host.',
    )
    .option(
      '--isolation-name <name>',
      'Suffix identifying which host network to delete (letters, digits, hyphens only) — for test sandboxing',
    )
    .action(async (options: DeleteHostNetworkCommandOptions) => {
      const exec = createRealPowerShellExec();
      if (!(await isElevated(exec))) {
        console.error(
          'delete-host-network: this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
        );
        process.exitCode = 1;
        return;
      }

      try {
        const result = await deleteHostNetwork({
          exec,
          isolationName: options.isolationName,
          homedir: homedir(),
        });

        // deleteHostNetwork only ever returns once every sweep and the switch
        // removal fully succeeded (0 failures each) — a nonzero failed count
        // anywhere makes it throw instead, caught below. So the success-path
        // summary only needs to report what was removed.
        const ruleTotal =
          result.interfaceSweep.removed + result.queryUserSweep.removed + result.namedSweep.removed;
        console.log(
          `delete-host-network: removed ${ruleTotal} firewall rule(s) ` +
            `(${result.interfaceSweep.removed} interface-scoped, ${result.queryUserSweep.removed} stale Query User, ` +
            `${result.namedSweep.removed} named SMB); switch ${result.switchRemoved ? 'removed' : 'not found'}.`,
        );
      } catch (error) {
        if (error instanceof HostNetworkError) {
          console.error(`delete-host-network: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}

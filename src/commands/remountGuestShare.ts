import { networkInterfaces } from 'node:os';
import type { Command } from 'commander';
import { resolveForwardListenAddress, DEFAULT_INTERNAL_SWITCH_ADAPTER } from '../runHosting/forwarder';
import { promptText } from '../cliPrompt';
import { createSshRemoteExec } from '../guestSetup/remoteExec';
import { remountShare, RemountShareError } from '../guestSetup/remountShare';

interface RemountGuestShareOptions {
  adapterAlias: string;
}

export function registerRemountGuestShare(program: Command): void {
  program
    .command('remount-guest-share')
    .description(
      "Re-point an Ubuntu guest's already-mounted SMB share at this host's current IP on the " +
        'given adapter, without reinstalling credentials. Run this after isolating a guest onto ' +
        'susentorno-internal — its /etc/fstab entry still points at whichever host IP ' +
        'setup-guest-unix used (the Default Switch), which the guest can no longer reach.',
    )
    .option(
      '--adapter-alias <name>',
      "adapter whose IP the guest's share should mount from",
      DEFAULT_INTERNAL_SWITCH_ADAPTER,
    )
    .action(async (options: RemountGuestShareOptions) => {
      const hostIp = resolveForwardListenAddress(options.adapterAlias, networkInterfaces());
      if (!hostIp) {
        console.error(
          `remount-guest-share: could not find an IPv4 address on adapter '${options.adapterAlias}'. ` +
            'Pass --adapter-alias, or complete setup-machine.md first.',
        );
        process.exitCode = 1;
        return;
      }

      const address = await promptText('Guest address (hostname or IP)');
      const username = await promptText('Guest username');
      const shareName = await promptText('SMB share name', 'vm-shared-linux');

      const remoteExec = createSshRemoteExec({ address, username });
      const onStep = (message: string) => console.log(`remount-guest-share: ${message}...`);

      try {
        await remountShare(remoteExec, { shareName, hostIp, onStep });
      } catch (error) {
        if (error instanceof RemountShareError) {
          console.error(`remount-guest-share: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      console.log('remount-guest-share: fstab updated and share confirmed reachable.');
    });
}

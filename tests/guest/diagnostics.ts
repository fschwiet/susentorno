import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { repoRoot } from '../testEnvRoot';
import { guestCapture } from './guestExec';
import type { GuestRole } from './hyperv/imageCache';

/** Per-run guest diagnostics, retained after teardown for failed boots and assertions. */
export const artifactsDir = join(
  repoRoot,
  'test-results',
  'guest',
  new Date().toISOString().replace(/[:.]/g, '-'),
);

/** Collect each useful diagnostic independently so one broken command cannot hide the others. */
export async function collectDiagnostics(target: SshTarget, role: GuestRole): Promise<void> {
  const dir = join(artifactsDir, role);
  mkdirSync(dir, { recursive: true });
  const dumps: [string, string][] = [
    ['journal.txt', 'sudo journalctl -u NetworkManager -u systemd-resolved --no-pager'],
    [
      'network.txt',
      'ip addr; echo; ip -4 route; echo; sudo iptables -t nat -S; echo; resolvectl status; echo; mount | grep cifs',
    ],
  ];
  for (const [filename, command] of dumps) {
    try {
      const { stdout } = await guestCapture(target, command);
      writeFileSync(join(dir, filename), stdout);
    } catch (error) {
      writeFileSync(join(dir, filename), `diagnostics: '${command}' failed: ${String(error)}\n`);
    }
  }
  console.log(`guest(${role}): diagnostics in ${dir}`);
}

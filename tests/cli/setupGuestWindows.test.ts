import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTakenRanges, findFreeSubnet } from '../../src/hostNetwork/subnetSelection';
import { checkElevated } from '../checkElevated';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

// setup-guest-windows itself requires an elevated host
beforeAll(checkElevated);

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'susentorno-setup-guest-windows-'));
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: dir },
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setupGuestWindows(args: string[], input = '', cwd = dir) {
  return execa('node', [cliPath, 'setup-guest-windows', ...args], {
    cwd,
    reject: false,
    input,
  });
}

describe('susentorno setup-guest-windows: command surface', () => {
  it('describes PowerShell Direct, the switch move, both phases, elevation, and run-hosting in --help', async () => {
    const { exitCode, stdout } = await execa('node', [cliPath, 'setup-guest-windows', '--help']);
    expect(exitCode).toBe(0);
    const help = stdout.replace(/\s+/g, ' ');
    for (const phrase of [
      'PowerShell Direct',
      'from the Default Switch to the selected Internal switch',
      'pre-isolation',
      'post-isolation',
      'elevated (Administrator)',
      "'susentorno run-hosting'",
    ]) {
      expect(help, phrase).toContain(phrase);
    }
  });

  it('lists every non-secret option', async () => {
    const { stdout } = await execa('node', [cliPath, 'setup-guest-windows', '--help']);
    for (const flag of [
      '--isolation-name',
      '--nat-adapter-alias',
      '--vm-name',
      '--guest-username',
      '--share-name',
      '--share-account',
    ]) {
      expect(stdout, flag).toContain(flag);
    }
    expect(stdout).not.toMatch(/password/i);
    expect(stdout).not.toContain('--guest-address');
  });

  it.each(['--guest-password', '--share-password'])(
    'rejects %s as an unknown option, without prompting',
    async (flag) => {
      const { exitCode, stderr, stdout } = await setupGuestWindows([flag, 'hunter2']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`unknown option '${flag}'`);
      expect(stdout).not.toContain('Hyper-V VM name');
    },
  );
});

describe('susentorno setup-guest-windows: failures before any prompt', () => {
  it('reports an invalid isolation name as a message, not a stack trace', async () => {
    const { exitCode, stderr, stdout } = await setupGuestWindows(['--isolation-name', 'bad name!']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('only letters, digits, and hyphens are allowed');
    expect(stderr).not.toContain('HostNetworkError:');
    expect(stdout).not.toContain('Hyper-V VM name');
  });

  it('fails an isolation name that resolves to no adapter, naming the remedy', async () => {
    const { exitCode, stderr, stdout } = await setupGuestWindows([
      '--isolation-name',
      'does-not-exist',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "could not find an IPv4 address on adapter 'vEthernet (susentorno-does-not-exist-internal)'",
    );
    expect(stderr).toContain(
      "Run 'susentorno create-host-network --isolation-name does-not-exist' first.",
    );
    expect(stdout).not.toContain('Hyper-V VM name');
  });

  it('fails a directory with no environment', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'susentorno-setup-guest-windows-empty-'));
    try {
      const { exitCode, stderr, stdout } = await setupGuestWindows([], '', empty);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('no .susentorno in');
      expect(stderr).toContain("run 'susentorno init' first");
      expect(stdout).not.toContain('Hyper-V VM name');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('fails an environment with no Windows VM share, naming the remedy', async () => {
    const share = join(dir, '.susentorno', 'vm-shared-windows');
    expect(existsSync(share)).toBe(true);
    rmSync(share, { recursive: true, force: true });
    const { exitCode, stderr, stdout } = await setupGuestWindows([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('has no Windows VM share');
    expect(stderr).toContain('update-shares');
    expect(stdout).not.toContain('Hyper-V VM name');
  });
});

// The remaining checks get past phase H1, which needs a resolvable host network.
// It is created (and torn down) through the packaged CLI under its own isolation
// name, so it never touches a developer's real susentorno-internal switch.
describe('susentorno setup-guest-windows: with a host network', () => {
  const isolationName = 'cli-windows-setup';

  beforeAll(async () => {
    const subnet = findFreeSubnet(detectTakenRanges());
    if (subnet === null) throw new Error('no free 192.168.x.0/24 subnet for the test host network');
    const created = await execa(
      'node',
      [
        cliPath,
        'create-host-network',
        '--isolation-name',
        isolationName,
        '--subnet',
        String(subnet),
      ],
      { reject: false },
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `could not create the test host network: ${created.stderr || created.stdout}`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await execa('node', [cliPath, 'delete-host-network', '--isolation-name', isolationName], {
      reject: false,
    });
  }, 120_000);

  it('fails a nonexistent VM before asking for the guest password', async () => {
    const { exitCode, stderr, stdout } = await setupGuestWindows([
      '--isolation-name',
      isolationName,
      '--vm-name',
      'susentorno-no-such-vm',
      '--share-name',
      'vm-shared-windows',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no VM named exactly 'susentorno-no-such-vm'");
    expect(stderr).toContain('failed in phase H2');
    expect(stdout).not.toContain('Guest username');
    expect(stdout).not.toContain('Guest password');
  });

  it('exits cleanly, as a cancellation, on EOF at the Hyper-V VM name prompt', async () => {
    const { exitCode, stderr, stdout } = await setupGuestWindows([
      '--isolation-name',
      isolationName,
    ]);
    expect(stdout).toContain('Hyper-V VM name');
    expect(exitCode).toBe(130);
    expect(stderr).toContain("input ended at the 'Hyper-V VM name' prompt");
    expect(stderr).toContain('No VM was chosen, so nothing was changed.');
    expect(stderr).not.toMatch(/\n\s+at /); // no stack trace
    expect(stdout).not.toContain('Guest password');
  });
});

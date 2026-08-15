import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'susentorno-setup-guest-unix-'));
  await execa('node', [cliPath, 'init'], { cwd: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('susentorno setup-guest-unix', () => {
  it('fails fast with no prompts when the isolation name resolves to no adapter', async () => {
    const { exitCode, stderr, stdout } = await execa(
      'node',
      [cliPath, 'setup-guest-unix', '--isolation-name', 'does-not-exist'],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "could not find an IPv4 address on adapter 'vEthernet (susentorno-does-not-exist-internal)'",
    );
    expect(stderr).toContain(
      "Run 'susentorno create-host-network --isolation-name does-not-exist' first.",
    );
    expect(stdout).not.toContain('Guest address'); // never reached the prompts
  });

  it('reports an invalid isolation name as a message, not a stack trace', async () => {
    const { exitCode, stderr } = await execa(
      'node',
      [cliPath, 'setup-guest-unix', '--isolation-name', 'bad name!'],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('only letters, digits, and hyphens are allowed');
    expect(stderr).not.toContain('HostNetworkError:'); // caught at the command boundary
  });
});

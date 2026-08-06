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
  it('fails fast with no prompts when the internal-switch adapter does not exist', async () => {
    const { exitCode, stderr, stdout } = await execa(
      'node',
      [cliPath, 'setup-guest-unix', '--adapter-alias', 'does-not-exist-adapter'],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not find an IPv4 address on adapter 'does-not-exist-adapter'");
    expect(stdout).not.toContain('Guest address'); // never reached the prompts
  });
});

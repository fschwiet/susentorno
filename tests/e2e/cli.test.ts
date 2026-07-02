import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('configamatron CLI', () => {
  it('prints the version with --version', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe('0.0.1');
    expect(exitCode).toBe(0);
  });
});

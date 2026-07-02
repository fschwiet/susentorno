import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('configamatron CLI', () => {
  it('prints the version with --version', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe('0.0.1');
    expect(exitCode).toBe(0);
  });

  it('parses a policy file into allowlist.txt with import-sbx-network-policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const outputPath = join(dir, 'allowlist.txt');
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode } = await execa('node', [
        cliPath,
        'import-sbx-network-policy',
        fixturePath,
        '-o',
        outputPath,
      ]);

      expect(exitCode).toBe(0);
      expect(readFileSync(outputPath, 'utf8')).toBe(
        [
          '# passthrough',
          '**.chatgpt.com:443',
          'archive.ubuntu.com:80',
          '',
          '# terminate',
          'api.anthropic.com:443',
          'claude.com:443',
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates envoy.yaml from allowlist.txt with build-envoy-config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const outputPath = join(dir, 'envoy.yaml');
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-allowlist.txt', import.meta.url));

    try {
      const { exitCode } = await execa('node', [
        cliPath,
        'build-envoy-config',
        fixturePath,
        '-o',
        outputPath,
        '--upstream-override',
        'api.anthropic.com=127.0.0.1:9443',
      ]);

      expect(exitCode).toBe(0);
      const config = parse(readFileSync(outputPath, 'utf8')) as any;
      const cluster = config.static_resources.clusters.find(
        (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(
        cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

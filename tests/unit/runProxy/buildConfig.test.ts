import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { writeEnvoyConfig } from '../../../src/runProxy/buildConfig';
import { parseAllowlist } from '../../../src/allowlist';

const ALLOWLIST = [
  '#pragma passthrough',
  'pypi.org:443',
  '',
  '#pragma claude authenticated',
  'api.anthropic.com:443',
  '',
].join('\n');

describe('writeEnvoyConfig', () => {
  it('writes envoy.yaml with upstream overrides applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(parseAllowlist(ALLOWLIST), outputPath, [
        { sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' },
      ]);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { clusters: Array<{ name: string; load_assignment: any }> };
      };
      const cluster = config.static_resources.clusters.find(
        (c) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(cluster).toBeDefined();
      expect(
        cluster!.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

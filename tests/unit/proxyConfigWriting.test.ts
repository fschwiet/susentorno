import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { writeEnvoyConfig } from '../../src/runHosting/buildConfig';
import { combinePolicy, parseAllowListFile, parseAuthListFile } from '../../src/allowlist';
import { parseBlockListFile } from '../../src/blockList';

const ALLOWLIST = [
  'pypi.org:443',
  '',
].join('\n');
const AUTH_LIST = ['#pragma claude authenticated', 'api.anthropic.com:443', ''].join('\n');
const policy = () => combinePolicy(parseAllowListFile(ALLOWLIST), parseAuthListFile(AUTH_LIST), parseBlockListFile(''));

describe('proxy configuration writing', () => {
  it('writes envoy.yaml with upstream overrides applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(policy(), outputPath, [
        { sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' },
      ]);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { clusters: Array<{ name: string; load_assignment: any }> };
      };
      const cluster = config.static_resources.clusters.find(
        (c) => c.name === 'cluster_claude_api_anthropic_com',
      );
      expect(cluster).toBeDefined();
      expect(
        cluster!.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads mcpServers through to the generated config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(policy(), outputPath, [], undefined, [
        { hostname: 'fs.internal', port: 9999 },
      ]);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { listeners: Array<{ name: string; filter_chains: any[] }> };
      };
      const listener443 = config.static_resources.listeners.find((l) => l.name === 'listener_443');
      expect(
        listener443!.filter_chains.some((fc: any) =>
          fc.filter_chain_match?.server_names?.includes('fs.internal'),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads skipAllowList through to the generated config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(policy(), outputPath, [], undefined, undefined, true);
      const config = parse(readFileSync(outputPath, 'utf8')) as any;
      const listener443 = config.static_resources.listeners.find((l: any) => l.name === 'listener_443');
      expect(listener443.default_filter_chain.filters[1].typed_config.cluster).toBe('dynamic_forward_proxy_cluster');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

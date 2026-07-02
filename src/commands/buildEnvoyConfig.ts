import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { stringify } from 'yaml';
import { parseAllowlist } from '../allowlist';
import { generateEnvoyConfig, type UpstreamOverride } from '../envoyConfig';

function collectOverride(value: string, previous: UpstreamOverride[]): UpstreamOverride[] {
  const [sniHost, target] = value.split('=');
  return [...previous, { sniHost, target }];
}

export function registerBuildEnvoyConfig(program: Command): void {
  program
    .command('build-envoy-config')
    .description('Generate envoy.yaml from allowlist.txt')
    .argument('[allowlistFile]', 'path to allowlist.txt', 'allowlist.txt')
    .option('-o, --output <path>', 'output envoy.yaml path', 'envoy/envoy.yaml')
    .option(
      '--upstream-override <sniHost=host:port>',
      'redirect a terminate cluster to a different upstream (test use only)',
      collectOverride,
      [] as UpstreamOverride[],
    )
    .action(
      (
        allowlistFile: string,
        options: { output: string; upstreamOverride: UpstreamOverride[] },
      ) => {
        const content = readFileSync(allowlistFile, 'utf8');
        const allowlist = parseAllowlist(content);
        const config = generateEnvoyConfig(allowlist, { overrides: options.upstreamOverride });
        writeFileSync(options.output, stringify(config));
      },
    );
}

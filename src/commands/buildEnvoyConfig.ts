import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { stringify } from 'yaml';
import { parseAllowlist } from '../allowlist';
import { generateEnvoyConfig, type UpstreamOverride } from '../envoyConfig';
import { requireEnvPathsOrExit } from '../envPaths';

function collectOverride(value: string, previous: UpstreamOverride[]): UpstreamOverride[] {
  const [sniHost, target] = value.split('=');
  return [...previous, { sniHost, target }];
}

export function registerBuildEnvoyConfig(program: Command): void {
  program
    .command('build-envoy-config')
    .description("Generate the environment's envoy.yaml from its allowlist")
    .argument('[allowlistFile]', 'allowlist path (default: .configamatron/proxy/allowlist.txt)')
    .option('-o, --output <path>', 'output path (default: .configamatron/proxy/envoy.yaml)')
    .option(
      '--upstream-override <sniHost=host:port>',
      'redirect a terminate cluster to a different upstream (test use only)',
      collectOverride,
      [] as UpstreamOverride[],
    )
    .action(
      (
        allowlistFile: string | undefined,
        options: { output?: string; upstreamOverride: UpstreamOverride[] },
      ) => {
        const paths = requireEnvPathsOrExit('build-envoy-config');
        if (!paths) return;

        const inputPath = allowlistFile ?? paths.allowlist;
        const outputPath = options.output ?? paths.envoyConfig;
        if (!existsSync(inputPath)) {
          console.error(
            `build-envoy-config: ${inputPath} not found — 'configamatron init' creates the default allowlist`,
          );
          process.exitCode = 1;
          return;
        }
        const content = readFileSync(inputPath, 'utf8');
        const allowlist = parseAllowlist(content);
        const config = generateEnvoyConfig(allowlist, { overrides: options.upstreamOverride });
        writeFileSync(outputPath, stringify(config));
        console.log(`build-envoy-config: wrote ${outputPath} from ${inputPath}`);
      },
    );
}

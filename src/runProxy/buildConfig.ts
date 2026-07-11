import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { generateEnvoyConfig, type UpstreamOverride } from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist
 * and write it to outputPath. Validation of `allowlist.invalid` is the
 * caller's job: run-proxy treats invalid entries as fatal at startup but as
 * keep-previous-config on a live edit.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
): void {
  writeFileSync(outputPath, stringify(generateEnvoyConfig(allowlist, { overrides })));
}

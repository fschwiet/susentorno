import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import {
  generateEnvoyConfig,
  type UpstreamOverride,
  type InjectFault,
  type McpServerUpstream,
} from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist and
 * write it to outputPath. Surfacing `allowlist.warnings` is the caller's job.
 * `fault` is a test-only render mutation; when omitted the output is unchanged.
 * `verifyUpstreamOverrides` is likewise test-only: it opts override clusters
 * into the production validation context instead of ACCEPT_UNTRUSTED.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
  fault?: InjectFault,
  mcpServers?: McpServerUpstream[],
  skipAllowList?: boolean,
  verifyUpstreamOverrides?: boolean,
): void {
  writeFileSync(
    outputPath,
    stringify(
      generateEnvoyConfig(allowlist, {
        overrides,
        fault,
        mcpServers,
        skipAllowList,
        verifyUpstreamOverrides,
      }),
    ),
  );
}

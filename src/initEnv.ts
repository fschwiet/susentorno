import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envPaths } from './envPaths';
import { sanitizeCredentials } from './sanitizeCredentials';
import { sanitizeCodexCredentials } from './sanitizeCodexCredentials';
import { planAllPhases, executePlans } from './weaveShares';

const PRE_SCRIPTS_README = `# pre-scripts

Your own VM setup scripts go here. Name runnable steps \`NN-name.sh\` or
\`NN-name.ps1\`. They run before network isolation. Reference sibling resources
relative to the script, then run \`configamatron update-shares\` after editing.
`;

const POST_SCRIPTS_README = `# post-scripts

Your own VM setup scripts go here. Name runnable steps \`NN-name.sh\` or
\`NN-name.ps1\`. They run after network isolation and reboot. Reference sibling
resources relative to the script, then run \`configamatron update-shares\` after editing.
`;

const MCP_SERVERS_STUB = `# mcp-servers.yaml — Host-run MCP servers reachable from guests through the proxy.
#
# Empty by default: run-proxy launches nothing and Envoy routes nothing extra
# until you add entries here. See docs/adr/0016-host-run-mcp-servers.md for the
# full design rationale.
#
# Each entry is a mapping with these fields:
#
#   name        Required. A short identifier for the server. Must be unique
#               across all entries.
#
#   url         Required. The https:// URL guests use to reach this server,
#               e.g. https://filesystem.mcp.internal/mcp. The hostname drives
#               SNI routing and the certificate SAN, and must be unique across
#               all entries and not collide with an allowlist entry.
#
#               Recommended: invent a hostname under .internal for this
#               purpose (e.g. filesystem.mcp.internal).
#               WARNING: choosing a real public hostname (e.g. github.com)
#               will shadow that name inside the guest — every guest request
#               to that hostname is routed to this MCP server instead of the
#               real internet host.
#
#   command     Required. The shell command Configamatron uses to launch the
#               server on the host. Must contain both the {ip} and {port}
#               placeholders; Configamatron substitutes {ip} with 127.0.0.1
#               and {port} with a free loopback port before launch:
#                 command: "my-mcp-server --bind {ip} --port {port}"
#
#   workingDir  Optional. Working directory the command runs in. Relative
#               paths resolve against this environment's root. Must resolve
#               to an existing directory.
#
# Trust model (read before adding a server):
#   A host MCP server declared here is trusted host code: it runs with
#   run-proxy's ambient host identity, environment, and filesystem
#   permissions, the same as any other process you would launch on the host
#   yourself. The tools it exposes become callable by the untrusted guest.
#   Any guest that can reach the running proxy over the internal switch can
#   invoke it, selected by SNI (hostname), with no per-guest authentication.
#   No credential is injected into the server by the proxy; whatever it
#   needs, it draws from the host environment it already runs in. Only add
#   a server here if you are comfortable with any guest calling any of its
#   exposed tools.
#
# Example (uncomment and adapt):
# - name: filesystem
#   url: https://filesystem.mcp.internal/mcp
#   command: "my-mcp-server --bind {ip} --port {port}"
#   workingDir: .
`;

export interface InitOptions {
  cwd: string;
  credentialsPath: string;
  codexCredentialsPath: string;
  templatesDir: string;
  allowlistSource: string;
}

/**
 * Scaffold <cwd>/.configamatron. Validates all inputs before writing anything so a
 * failed init leaves no partial environment behind. Throws on any failure.
 */
export function initEnvironment(options: InitOptions): void {
  const paths = envPaths(options.cwd);
  if (existsSync(paths.root)) {
    throw new Error(
      `${paths.root} already exists — delete it to rebuild the environment from scratch`,
    );
  }

  let rawCredentials: string;
  try {
    rawCredentials = readFileSync(options.credentialsPath, 'utf8');
  } catch {
    throw new Error(
      `could not read credentials at ${options.credentialsPath} — log in with the claude CLI first, or pass --credentials`,
    );
  }

  let sanitized: string;
  try {
    sanitized = sanitizeCredentials(rawCredentials);
  } catch (error) {
    throw new Error(
      `invalid credentials file at ${options.credentialsPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let rawCodex: string;
  try {
    rawCodex = readFileSync(options.codexCredentialsPath, 'utf8');
  } catch {
    throw new Error(
      `could not read codex credentials at ${options.codexCredentialsPath} — log in with the codex CLI first, or pass --codex-credentials`,
    );
  }

  let sanitizedCodex: string;
  try {
    sanitizedCodex = sanitizeCodexCredentials(rawCodex);
  } catch (error) {
    throw new Error(
      `invalid codex auth file at ${options.codexCredentialsPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  mkdirSync(paths.preScripts, { recursive: true });
  writeFileSync(join(paths.preScripts, 'README.md'), PRE_SCRIPTS_README);
  mkdirSync(paths.postScripts, { recursive: true });
  writeFileSync(join(paths.postScripts, 'README.md'), POST_SCRIPTS_README);
  const plans = planAllPhases({ templatesDir: options.templatesDir, paths });

  cpSync(join(options.templatesDir, 'vm-shared'), paths.vmShared, { recursive: true });
  cpSync(join(options.templatesDir, 'vm-shared-windows'), paths.vmSharedWindows, {
    recursive: true,
    filter: () => true,
  });
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowlistSource, paths.allowlist);
  for (const target of paths.vmSharedTargets) {
    writeFileSync(target.credentials, sanitized);
    writeFileSync(target.authJson, sanitizedCodex);
  }

  const templateTransforms = join(options.templatesDir, 'home-jq-transforms');
  cpSync(templateTransforms, paths.homeJqTransforms, { recursive: true });
  for (const target of paths.vmSharedTargets) {
    cpSync(templateTransforms, target.homeJqTransforms, { recursive: true });
  }
  copyFileSync(join(options.templatesDir, 'configamatron.gitignore'), paths.gitignore);
  writeFileSync(paths.mcpServers, MCP_SERVERS_STUB);
  executePlans(plans);
}

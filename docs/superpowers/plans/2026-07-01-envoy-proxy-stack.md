# Envoy Proxy Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Envoy sandbox proxy stack itself — `build-envoy-config`, the generated Envoy config, `gate.lua`, the self-signed CA, `docker-compose.yml` — and prove it works with automated tests that bring the whole stack up as a transient resource, drive it with real requests, and tear it down. VM-side wiring (iptables, CA trust) and the host credential-sync hook are also delivered here, but — since they require the actual Ubuntu VM or the host's real Claude session — are verified manually rather than by an automated test.

**Architecture:** `src/envoyConfig.ts` is a pure function, `generateEnvoyConfig(allowlist, options)`, that turns an `Allowlist` (from the prior `configamatron-cli` plan) into a plain JS object matching Envoy's v3 static-resources schema; `src/commands/buildEnvoyConfig.ts` serializes that to YAML via the `yaml` package. The generated config: terminates TLS only for the six Anthropic/Claude hostnames (Lua gate + `credential_injector`, sourced from an SDS file), uses Envoy's SNI dynamic-forward-proxy for all other TLS passthrough traffic (this is required because several allow-list entries are wildcard domains — a static per-host cluster can't represent "any subdomain"), and uses HTTP `Host`-header routing for plain port 80. Automated integration tests (`tests/integration/proxy.test.ts`) run `docker compose up`, redirect the Anthropic/Claude cluster to a local mock HTTPS server via `--upstream-override` (so no real credential or API call is needed), hit the stack with real requests, then `docker compose down`.

**Tech Stack:** Everything from the `configamatron-cli` plan, plus: `yaml` (Envoy config serialization), `selfsigned` (mock upstream TLS cert, test-only), Docker + Docker Compose, the `envoyproxy/envoy` image, OpenSSL (CA generation), Bash (VM/host scripts — matches the design spec's existing choice for those).

## Global Constraints

- Depends on `docs/superpowers/plans/2026-07-01-configamatron-cli.md` being implemented first: this plan imports `Allowlist`, `parseAllowlist`, `formatAllowlist` from `src/allowlist.ts` and registers `build-envoy-config` alongside the existing `import-sbx-network-policy` command in `src/cli.ts`.
- The `build-envoy-config` subcommand: `configamatron build-envoy-config [allowlistFile=allowlist.txt] [-o envoy/envoy.yaml] [--upstream-override <sniHost>=<host:port>]` (repeatable flag). Production runs never pass `--upstream-override`; it exists solely for the automated integration tests.
- Generated artifacts (`allowlist.txt`, `envoy/envoy.yaml`) and locally-generated secrets (`envoy/ca/*.pem`, `envoy/secrets/*.yaml`) are gitignored — never committed.
- The terminate domain family is fixed (matches `src/policyFile.ts`'s `TERMINATE_HOSTS` from the prior plan): `api.anthropic.com`, `claude.com`, `platform.claude.com`, `statsig.anthropic.com`, `mcp-proxy.anthropic.com`, `downloads.claude.ai`.
- Integration tests require Docker and outbound internet access on the machine running them (they make real requests to public allow-listed hosts like `pypi.org` and `archive.ubuntu.com` to prove passthrough works, without needing any Anthropic credential).
- `pnpm test` must remain green end-to-end and, by the end of this plan, also runs `pnpm test:integration`.

---

## Task 1: Envoy config generator — `generateEnvoyConfig`

**Files:**
- Create: `src/envoyConfig.ts`
- Test: `tests/unit/envoyConfig.test.ts`
- Modify: `package.json` (add `yaml` dependency)

**Interfaces:**
- Consumes: `Allowlist` from `./allowlist` (prior plan).
- Produces:
  - `export interface UpstreamOverride { sniHost: string; target: string; }`
  - `export interface BuildEnvoyConfigOptions { overrides?: UpstreamOverride[]; }`
  - `export function generateEnvoyConfig(allowlist: Allowlist, options?: BuildEnvoyConfigOptions): Record<string, unknown>`
  - Task 2's `buildEnvoyConfig.ts` imports `generateEnvoyConfig` and `UpstreamOverride` with these exact names.

- [ ] **Step 1: Add the `yaml` dependency**

Edit `package.json`'s `dependencies`:

```json
  "dependencies": {
    "commander": "^15.0.0",
    "yaml": "^2.6.0"
  },
```

Run: `pnpm install`
Expected: `yaml` added to `pnpm-lock.yaml`.

- [ ] **Step 2: Write the failing unit test**

```ts
// tests/unit/envoyConfig.test.ts
import { describe, it, expect } from 'vitest';
import { generateEnvoyConfig } from '../../src/envoyConfig';
import type { Allowlist } from '../../src/allowlist';

const allowlist: Allowlist = {
  passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
  terminate: ['api.anthropic.com:443'],
};

describe('generateEnvoyConfig', () => {
  it('builds a terminate filter chain and cluster for each terminate host', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const terminateChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );

    expect(terminateChain).toBeDefined();
    const hcm = terminateChain.filters[0].typed_config;
    expect(hcm['@type']).toBe(
      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_terminate_api_anthropic_com',
    );
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
    );
    expect(cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address).toEqual(
      { address: 'api.anthropic.com', port_value: 443 },
    );
    expect(cluster.transport_socket.typed_config['@type']).toBe(
      'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
    );
  });

  it('redirects a terminate cluster to the override target and disables upstream cert validation', () => {
    const config = generateEnvoyConfig(allowlist, {
      overrides: [{ sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' }],
    }) as any;

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
    );
    expect(cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address).toEqual(
      { address: '127.0.0.1', port_value: 9443 },
    );
    expect(
      cluster.transport_socket.typed_config.common_tls_context.validation_context
        .trust_chain_verification,
    ).toBe('ACCEPT_UNTRUSTED');
  });

  it('routes all passthrough 443 entries through a single SNI dynamic-forward-proxy filter chain', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const passthroughChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('*.chatgpt.com'),
    );

    expect(passthroughChain).toBeDefined();
    expect(passthroughChain.filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.network.sni_dynamic_forward_proxy',
      'envoy.filters.network.tcp_proxy',
    ]);

    const dfpCluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'dynamic_forward_proxy_cluster',
    );
    expect(dfpCluster.cluster_type.name).toBe('envoy.clusters.dynamic_forward_proxy');
  });

  it('routes each passthrough port-80 host by Host header to its own cluster, with a 403 default', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');
    const hcm = listener80.filter_chains[0].filters[0].typed_config;
    const vhosts = hcm.route_config.virtual_hosts;

    const ubuntuVhost = vhosts.find((v: any) => v.domains.includes('archive.ubuntu.com'));
    expect(ubuntuVhost.routes[0].route.cluster).toBe('cluster_http_archive_ubuntu_com');

    const defaultVhost = vhosts.find((v: any) => v.domains.includes('*'));
    expect(defaultVhost.routes[0].direct_response.status).toBe(403);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_http_archive_ubuntu_com',
    );
    expect(cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address).toEqual(
      { address: 'archive.ubuntu.com', port_value: 80 },
    );
  });

  it('exposes an admin endpoint for readiness checks', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    expect(config.admin.address.socket_address.port_value).toBe(9901);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — `src/envoyConfig.ts` does not exist yet.

- [ ] **Step 4: Implement `src/envoyConfig.ts`**

```ts
import type { Allowlist } from './allowlist';

export interface UpstreamOverride {
  sniHost: string;
  target: string;
}

export interface BuildEnvoyConfigOptions {
  overrides?: UpstreamOverride[];
}

function sanitizeName(host: string): string {
  return host.replace(/[^a-zA-Z0-9]/g, '_');
}

function toEnvoyWildcard(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}

function buildTerminateEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const [upstreamHost, upstreamPortStr] = override
    ? override.target.split(':')
    : [sniHost, portStr];
  const clusterName = `cluster_terminate_${sanitizeName(sniHost)}`;

  const filterChain = {
    filter_chain_match: { server_names: [sniHost] },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext',
        common_tls_context: {
          tls_certificates: [
            {
              certificate_chain: { filename: '/etc/envoy/ca/cert.pem' },
              private_key: { filename: '/etc/envoy/ca/key.pem' },
            },
          ],
        },
      },
    },
    filters: [
      {
        name: 'envoy.filters.network.http_connection_manager',
        typed_config: {
          '@type':
            'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          stat_prefix: `terminate_${sanitizeName(sniHost)}`,
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'terminate',
                domains: ['*'],
                routes: [{ match: { prefix: '/' }, route: { cluster: clusterName } }],
              },
            ],
          },
          http_filters: [
            {
              name: 'envoy.filters.http.lua',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { filename: '/etc/envoy/gate.lua' },
              },
            },
            {
              name: 'envoy.filters.http.credential_injector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector',
                overwrite: true,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'Authorization',
                    credential: {
                      name: 'sandbox_bearer_token',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/sds-secret.yaml',
                          watched_directory: { path: '/etc/envoy/secrets' },
                        },
                        resource_api_version: 'V3',
                      },
                    },
                  },
                },
              },
            },
            {
              name: 'envoy.filters.http.router',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
              },
            },
          ],
        },
      },
    ],
  };

  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: {
                  socket_address: { address: upstreamHost, port_value: Number(upstreamPortStr) },
                },
              },
            },
          ],
        },
      ],
    },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
        sni: sniHost,
        common_tls_context: override
          ? { validation_context: { trust_chain_verification: 'ACCEPT_UNTRUSTED' } }
          : {},
      },
    },
  };

  return { filterChain, cluster };
}

function buildHttp80Entry(entry: string) {
  const [host, portStr] = entry.split(':');
  const clusterName = `cluster_http_${sanitizeName(host)}`;

  const virtualHost = {
    name: sanitizeName(host),
    domains: [host],
    routes: [{ match: { prefix: '/' }, route: { cluster: clusterName } }],
  };

  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: { socket_address: { address: host, port_value: Number(portStr) } },
              },
            },
          ],
        },
      ],
    },
  };

  return { virtualHost, cluster };
}

export function generateEnvoyConfig(
  allowlist: Allowlist,
  options: BuildEnvoyConfigOptions = {},
): Record<string, unknown> {
  const overrides = options.overrides ?? [];

  const terminateBuilt = allowlist.terminate
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildTerminateEntry(e, overrides));
  const passthroughServerNames = allowlist.passthrough
    .filter((e) => e.endsWith(':443'))
    .map((e) => toEnvoyWildcard(e.split(':')[0]));
  const http80Built = allowlist.passthrough.filter((e) => e.endsWith(':80')).map(buildHttp80Entry);

  return {
    admin: {
      address: { socket_address: { address: '0.0.0.0', port_value: 9901 } },
    },
    static_resources: {
      listeners: [
        {
          name: 'listener_443',
          address: { socket_address: { address: '0.0.0.0', port_value: 443 } },
          listener_filters: [
            {
              name: 'envoy.filters.listener.tls_inspector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector',
              },
            },
          ],
          filter_chains: [
            ...terminateBuilt.map((b) => b.filterChain),
            {
              filter_chain_match: { server_names: passthroughServerNames },
              filters: [
                {
                  name: 'envoy.filters.network.sni_dynamic_forward_proxy',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                    port_value: 443,
                    dns_cache_config: {
                      name: 'dynamic_forward_proxy_cache_config',
                      dns_lookup_family: 'V4_ONLY',
                    },
                  },
                },
                {
                  name: 'envoy.filters.network.tcp_proxy',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                    stat_prefix: 'passthrough_443',
                    cluster: 'dynamic_forward_proxy_cluster',
                  },
                },
              ],
            },
          ],
        },
        {
          name: 'listener_80',
          address: { socket_address: { address: '0.0.0.0', port_value: 80 } },
          filter_chains: [
            {
              filters: [
                {
                  name: 'envoy.filters.network.http_connection_manager',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                    stat_prefix: 'passthrough_80',
                    route_config: {
                      name: 'local_route_80',
                      virtual_hosts: [
                        ...http80Built.map((b) => b.virtualHost),
                        {
                          name: 'default_deny',
                          domains: ['*'],
                          routes: [
                            {
                              match: { prefix: '/' },
                              direct_response: {
                                status: 403,
                                body: { inline_string: 'sandbox: host not allow-listed' },
                              },
                            },
                          ],
                        },
                      ],
                    },
                    http_filters: [
                      {
                        name: 'envoy.filters.http.router',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      clusters: [
        ...terminateBuilt.map((b) => b.cluster),
        ...http80Built.map((b) => b.cluster),
        {
          name: 'dynamic_forward_proxy_cluster',
          lb_policy: 'CLUSTER_PROVIDED',
          cluster_type: {
            name: 'envoy.clusters.dynamic_forward_proxy',
            typed_config: {
              '@type':
                'type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig',
              dns_cache_config: {
                name: 'dynamic_forward_proxy_cache_config',
                dns_lookup_family: 'V4_ONLY',
              },
            },
          },
        },
      ],
    },
  };
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `pnpm test:unit`
Expected: PASS (10 tests total, 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts package.json pnpm-lock.yaml
git commit -m "Add generateEnvoyConfig: terminate/passthrough/port-80 Envoy config generation"
```

---

## Task 2: `build-envoy-config` command

**Files:**
- Create: `src/commands/buildEnvoyConfig.ts`
- Modify: `src/cli.ts` (register the command)
- Create: `tests/fixtures/sample-allowlist.txt`
- Modify: `tests/e2e/cli.test.ts` (add the new e2e test)
- Modify: `.gitignore` (ignore generated artifacts)

**Interfaces:**
- Consumes: `parseAllowlist` from `../allowlist`, `generateEnvoyConfig`/`UpstreamOverride` from `../envoyConfig`.
- Produces: `export function registerBuildEnvoyConfig(program: Command): void`.

- [ ] **Step 1: Ignore generated artifacts**

Append to `.gitignore`:

```
allowlist.txt
envoy/envoy.yaml
```

- [ ] **Step 2: Create the fixture allowlist**

```
# tests/fixtures/sample-allowlist.txt
# passthrough
**.chatgpt.com:443
archive.ubuntu.com:80

# terminate
api.anthropic.com:443
```

- [ ] **Step 3: Write the failing e2e test**

```ts
// tests/e2e/cli.test.ts (add to the existing describe block)
import { parse } from 'yaml';

// ... inside describe('configamatron CLI', () => { ... }), add:
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
    expect(cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address).toEqual(
      { address: '127.0.0.1', port_value: 9443 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the e2e test and verify it fails**

Run: `pnpm build && pnpm test:e2e`
Expected: FAIL — `error: unknown command 'build-envoy-config'`.

- [ ] **Step 5: Implement `src/commands/buildEnvoyConfig.ts`**

```ts
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
```

- [ ] **Step 6: Register the command in `src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerBuildEnvoyConfig } from './commands/buildEnvoyConfig';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerImportSbxNetworkPolicy(program);
registerBuildEnvoyConfig(program);

program.parse();
```

- [ ] **Step 7: Run the full pipeline and verify it passes**

Run: `pnpm test`
Expected: all steps PASS, including the 3 e2e tests (`--version`, `import-sbx-network-policy`, `build-envoy-config`).

- [ ] **Step 8: Commit**

```bash
git add src/commands/buildEnvoyConfig.ts src/cli.ts tests/fixtures/sample-allowlist.txt tests/e2e/cli.test.ts .gitignore
git commit -m "Add build-envoy-config command with --upstream-override"
```

---

## Task 3: `gate.lua` and the self-signed CA

**Files:**
- Create: `envoy/gate.lua`
- Create: `scripts/generate-ca.sh`
- Test: `tests/integration/generateCa.test.ts`
- Modify: `.gitignore` (ignore generated CA material)

**Interfaces:**
- Consumes: nothing.
- Produces: `envoy/ca/cert.pem` and `envoy/ca/key.pem` on disk when `scripts/generate-ca.sh` is run (consumed by Task 4's `docker-compose.yml` bind mount and by Task 6's integration tests).

- [ ] **Step 1: Ignore generated CA material**

Append to `.gitignore`:

```
envoy/ca/*.pem
```

- [ ] **Step 2: Create `envoy/gate.lua`**

```lua
local PLACEHOLDER = "Bearer sk-ant-oat-SANDBOX-PLACEHOLDER"

function envoy_on_request(request_handle)
  local auth = request_handle:headers():get("authorization")
  if auth == nil then
    return
  end
  if auth ~= PLACEHOLDER then
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
  end
end
```

- [ ] **Step 3: Write the failing integration test**

```ts
// tests/integration/generateCa.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../scripts/generate-ca.sh', import.meta.url));
const certPath = fileURLToPath(new URL('../../envoy/ca/cert.pem', import.meta.url));
const keyPath = fileURLToPath(new URL('../../envoy/ca/key.pem', import.meta.url));

describe('generate-ca.sh', () => {
  afterAll(() => {
    rmSync(certPath, { force: true });
    rmSync(keyPath, { force: true });
  });

  it('generates a CA cert/key covering the terminate hostnames', async () => {
    await execa('bash', [scriptPath]);

    expect(existsSync(certPath)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);

    const { stdout } = await execa('openssl', ['x509', '-in', certPath, '-noout', '-text']);
    expect(stdout).toContain('api.anthropic.com');
    expect(stdout).toContain('downloads.claude.ai');
  });
});
```

- [ ] **Step 4: Create `vitest.integration.config.ts` (needed to run the test above)**

```ts
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
```

- [ ] **Step 5: Run the test and verify it fails**

Run: `pnpm exec vitest run --config vitest.integration.config.ts`
Expected: FAIL — `scripts/generate-ca.sh` does not exist yet (`ENOENT` from execa).

- [ ] **Step 6: Implement `scripts/generate-ca.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

out_dir="$(cd "$(dirname "$0")/.." && pwd)/envoy/ca"
mkdir -p "$out_dir"

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$out_dir/key.pem" \
  -out "$out_dir/cert.pem" \
  -subj "/CN=sbx-sandbox-proxy-ca" \
  -addext "subjectAltName=DNS:api.anthropic.com,DNS:claude.com,DNS:platform.claude.com,DNS:statsig.anthropic.com,DNS:mcp-proxy.anthropic.com,DNS:downloads.claude.ai"

echo "Generated CA cert/key in $out_dir"
```

Run: `chmod +x scripts/generate-ca.sh`

- [ ] **Step 7: Run the test and verify it passes**

Run: `pnpm exec vitest run --config vitest.integration.config.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add envoy/gate.lua scripts/generate-ca.sh vitest.integration.config.ts tests/integration/generateCa.test.ts .gitignore
git commit -m "Add gate.lua and CA generation script"
```

---

## Task 4: `docker-compose.yml`

**Files:**
- Create: `docker-compose.yml`
- Create: `envoy/secrets/.gitkeep`
- Modify: `.gitignore` (ignore the generated SDS secret file)

**Interfaces:**
- Consumes: `envoy/envoy.yaml` (Task 2's output), `envoy/gate.lua` (Task 3), `envoy/ca/*.pem` (Task 3), `envoy/secrets/sds-secret.yaml` (written by Task 6's tests or, in production, by Task 7's host hook).
- Produces: a `docker compose up`-able stack. Host ports are driven by `ENVOY_HTTPS_PORT`/`ENVOY_HTTP_PORT`/`ENVOY_ADMIN_PORT` env vars (defaulting to the real `443`/`80`/`9901`) so integration tests can remap them to unprivileged ports without a second compose file.

- [ ] **Step 1: Ignore the generated SDS secret**

Append to `.gitignore`:

```
envoy/secrets/*.yaml
```

- [ ] **Step 2: Create the placeholder secrets directory**

```
// envoy/secrets/.gitkeep
```

(Empty file — Docker needs the directory to exist to bind-mount it; the actual secret file is generated at runtime and gitignored.)

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  envoy:
    image: envoyproxy/envoy:v1.31-latest
    ports:
      - '${ENVOY_HTTPS_PORT:-443}:443'
      - '${ENVOY_HTTP_PORT:-80}:80'
      - '${ENVOY_ADMIN_PORT:-9901}:9901'
    volumes:
      - ./envoy/envoy.yaml:/etc/envoy/envoy.yaml:ro
      - ./envoy/gate.lua:/etc/envoy/gate.lua:ro
      - ./envoy/ca:/etc/envoy/ca:ro
      - ./envoy/secrets:/etc/envoy/secrets:ro
    command: ['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info']
```

- [ ] **Step 4: Verify the compose file is syntactically valid**

Run: `docker compose config`
Expected: prints the resolved config with no errors (env vars will show their defaults since none are set in the shell).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml envoy/secrets/.gitkeep .gitignore
git commit -m "Add docker-compose.yml for the Envoy stack"
```

---

## Task 5: Mock upstream server

**Files:**
- Create: `tests/integration/mockUpstream.ts`
- Modify: `package.json` (add `selfsigned` devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface MockUpstream { port: number; server: import('node:https').Server; receivedAuthorizationHeaders: string[]; }`
  - `export function startMockUpstream(): Promise<MockUpstream>`
  - `export function stopMockUpstream(mock: MockUpstream): Promise<void>`
  - Task 6's integration tests import these exact names.

- [ ] **Step 1: Add the `selfsigned` devDependency**

Edit `package.json`'s `devDependencies` to add:

```json
    "selfsigned": "^2.4.1",
```

Run: `pnpm install`

- [ ] **Step 2: Implement `tests/integration/mockUpstream.ts`**

```ts
import { createServer, type Server } from 'node:https';
import selfsigned from 'selfsigned';

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
}

export function startMockUpstream(): Promise<MockUpstream> {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'mock-upstream' }], { days: 1 });
  const receivedAuthorizationHeaders: string[] = [];

  const server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    receivedAuthorizationHeaders.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock upstream ok');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind mock upstream');
      }
      resolve({ port: address.port, server, receivedAuthorizationHeaders });
    });
  });
}

export function stopMockUpstream(mock: MockUpstream): Promise<void> {
  return new Promise((resolve, reject) => {
    mock.server.close((err) => (err ? reject(err) : resolve()));
  });
}
```

- [ ] **Step 3: Verify it typechecks and lints**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. (No standalone test for this file — it's exercised directly by Task 6's integration tests.)

- [ ] **Step 4: Commit**

```bash
git add tests/integration/mockUpstream.ts package.json pnpm-lock.yaml
git commit -m "Add mock upstream server for credential-injection integration tests"
```

---

## Task 6: Integration tests — bring up the stack, verify behavior, tear it down

**Files:**
- Create: `tests/integration/fixtures/allowlist.txt`
- Create: `tests/integration/proxy.test.ts`
- Modify: `package.json` (add `test:integration` script, extend `test`)

**Interfaces:**
- Consumes: `startMockUpstream`/`stopMockUpstream` (Task 5), `docker-compose.yml` (Task 4), `configamatron build-envoy-config` (Task 2), `scripts/generate-ca.sh` (Task 3).
- Produces: nothing consumed by later tasks — this is the plan's terminal, whole-stack proof.

This fixture uses **real, public, allow-listed hosts** (`pypi.org`, `archive.ubuntu.com`) so the passthrough and port-80 tests exercise genuine network behavior, and redirects the one terminate host (`api.anthropic.com`) to the mock upstream so no real credential is ever needed.

- [ ] **Step 1: Create the integration fixture allowlist**

```
# tests/integration/fixtures/allowlist.txt
# passthrough
pypi.org:443
archive.ubuntu.com:80

# terminate
api.anthropic.com:443
```

- [ ] **Step 2: Write the integration test suite**

```ts
// tests/integration/proxy.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));

const HTTPS_PORT = 18443;
const HTTP_PORT = 18080;
const ADMIN_PORT = 19901;
const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
const REAL_AUTH = 'Bearer sandbox-test-real-token-12345';

let mockUpstream: MockUpstream;
let caCertPem: string;

async function waitForAdminReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: ADMIN_PORT, path: '/ready', timeout: 1000 },
          (res) => (res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`))),
        );
        req.on('error', reject);
        req.end();
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Envoy admin endpoint never became ready');
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();

  await execa('bash', ['scripts/generate-ca.sh'], { cwd: repoRoot });
  caCertPem = readFileSync(`${repoRoot}/envoy/ca/cert.pem`, 'utf8');

  await execa(
    'node',
    [
      cliPath,
      'build-envoy-config',
      allowlistFixture,
      '-o',
      `${repoRoot}/envoy/envoy.yaml`,
      '--upstream-override',
      `api.anthropic.com=127.0.0.1:${mockUpstream.port}`,
    ],
    { cwd: repoRoot },
  );

  mkdirSync(`${repoRoot}/envoy/secrets`, { recursive: true });
  writeFileSync(
    `${repoRoot}/envoy/secrets/sds-secret.yaml`,
    [
      'resources:',
      '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
      '    name: sandbox_bearer_token',
      '    generic_secret:',
      '      secret:',
      `        inline_string: "${REAL_AUTH}"`,
      '',
    ].join('\n'),
  );

  await execa('docker', ['compose', 'up', '-d'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ENVOY_HTTPS_PORT: String(HTTPS_PORT),
      ENVOY_HTTP_PORT: String(HTTP_PORT),
      ENVOY_ADMIN_PORT: String(ADMIN_PORT),
    },
  });

  await waitForAdminReady(30000);
}, 60000);

afterAll(async () => {
  await execa('docker', ['compose', 'down'], { cwd: repoRoot });
  await stopMockUpstream(mockUpstream);
}, 30000);

function requestThroughTerminate(authorization: string | undefined): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: caCertPem,
        path: '/',
        headers: authorization ? { authorization } : {},
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Envoy sandbox proxy stack', () => {
  it('injects the real credential when the placeholder Authorization header is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughTerminate(PLACEHOLDER_AUTH);

    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });

  it('rejects a non-placeholder Authorization header before reaching the upstream', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughTerminate('Bearer something-else');

    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });

  it('allows a real, allow-listed passthrough TLS host', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'pypi.org', path: '/simple/' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBeLessThan(400);
  });

  it('closes the connection for a non-allow-listed SNI', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tlsConnect(
          { host: '127.0.0.1', port: HTTPS_PORT, servername: 'not-allow-listed.example.com' },
          () => {
            socket.end();
            reject(new Error('expected the connection to be closed, but the TLS handshake succeeded'));
          },
        );
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it('allows a real, allow-listed Host header on port 80', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: HTTP_PORT, path: '/', headers: { host: 'archive.ubuntu.com' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBeLessThan(400);
  });

  it('returns 403 for a non-allow-listed Host header on port 80', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: HTTP_PORT,
          path: '/',
          headers: { host: 'not-allow-listed.example.com' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Wire up the `test:integration` script**

Edit `package.json`'s `scripts`:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e && pnpm test:integration",
```

- [ ] **Step 4: Run the integration tests and iterate until they pass**

Run: `pnpm build && pnpm test:integration`

Expected: all 6 tests PASS. If Envoy fails to start or a request behaves unexpectedly, run `docker compose logs envoy` (from the repo root) to see Envoy's own config-validation or runtime error, and adjust `src/envoyConfig.ts` (Task 1) accordingly — this is the expected feedback loop for getting the generated config exactly right, since Envoy's own config parser is the real source of truth here.

- [ ] **Step 5: Run the full pipeline**

Run: `pnpm test`
Expected: PASS end-to-end, including `test:integration`.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/fixtures/allowlist.txt tests/integration/proxy.test.ts package.json
git commit -m "Add end-to-end integration tests for the Envoy sandbox proxy stack"
```

---

## Task 7: Host session hook

**Files:**
- Create: `scripts/host-session-hook.sh`

**Interfaces:**
- Consumes: `~/.claude/credentials.json` (the host machine's real Claude Code login).
- Produces: `envoy/secrets/sds-secret.yaml`, matching the format Task 6's tests already write by hand and Task 1's generated config already reads.

This script isn't automatically testable in CI — it depends on a real, logged-in Claude Code session on the host — so it's covered by a manual check instead of a Vitest test.

- [ ] **Step 1: Create `scripts/host-session-hook.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

credentials_path="${HOME}/.claude/credentials.json"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
secret_path="${repo_root}/envoy/secrets/sds-secret.yaml"

if [ ! -f "$credentials_path" ]; then
  echo "host-session-hook: $credentials_path not found, skipping" >&2
  exit 0
fi

access_token="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).claudeAiOauth.accessToken)" "$credentials_path")"

mkdir -p "$(dirname "$secret_path")"
cat > "$secret_path" <<EOF
resources:
  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: sandbox_bearer_token
    generic_secret:
      secret:
        inline_string: "Bearer ${access_token}"
EOF

echo "host-session-hook: synced Claude credential into $secret_path"
```

Run: `chmod +x scripts/host-session-hook.sh`

- [ ] **Step 2: Manual verification**

Run: `bash scripts/host-session-hook.sh` on a machine with a real, logged-in Claude Code session.
Expected: prints `host-session-hook: synced Claude credential into .../envoy/secrets/sds-secret.yaml`, and that file contains a `Bearer sk-ant-oat-...` token matching `~/.claude/credentials.json`'s `claudeAiOauth.accessToken`.

The `~/.claude/settings.json` registration (add this manually on the host machine — this plan does not modify the host's global settings file):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/repo/scripts/host-session-hook.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/host-session-hook.sh
git commit -m "Add host-session-hook.sh to sync the real Claude credential into the SDS secret file"
```

---

## Task 8: VM-side scripts and credential template

**Files:**
- Create: `scripts/vm-setup-iptables.sh`
- Create: `scripts/vm-trust-ca.sh`
- Create: `vm/credentials.json.template`

**Interfaces:**
- Consumes: nothing (run manually inside the VM).
- Produces: nothing consumed by other tasks — these require the real Ubuntu VM and are verified manually.

- [ ] **Step 1: Create `scripts/vm-setup-iptables.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: vm-setup-iptables.sh <host-ip>}"

iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination "${host_ip}:443"
iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination "${host_ip}:80"

echo "vm-setup-iptables: DNAT rules installed, routing tcp/443 and tcp/80 to ${host_ip}"
```

Run: `chmod +x scripts/vm-setup-iptables.sh`

- [ ] **Step 2: Create `scripts/vm-trust-ca.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

cert_path="${1:?usage: vm-trust-ca.sh <path-to-cert.pem>}"

cp "$cert_path" /usr/local/share/ca-certificates/sbx-sandbox-proxy-ca.crt
update-ca-certificates

echo "vm-trust-ca: installed and trusted $cert_path"
```

Run: `chmod +x scripts/vm-trust-ca.sh`

- [ ] **Step 3: Create `vm/credentials.json.template`**

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat-SANDBOX-PLACEHOLDER",
    "refreshToken": "sandbox-placeholder-refresh-token",
    "expiresAt": 4102444800000,
    "scopes": ["user:inference"]
  }
}
```

- [ ] **Step 4: Manual verification (inside the Ubuntu VM)**

Run: `sudo bash scripts/vm-setup-iptables.sh <host-ip>`
Expected: prints the DNAT-installed message; `sudo iptables -t nat -L OUTPUT` shows both rules.

Run: `sudo bash scripts/vm-trust-ca.sh envoy/ca/cert.pem` (after copying the host's generated `envoy/ca/cert.pem` into the VM)
Expected: prints the installed message; `openssl s_client -connect api.anthropic.com:443 -servername api.anthropic.com </dev/null 2>/dev/null | openssl x509 -noout -issuer` shows the sandbox CA as issuer (proving the VM now both routes to and trusts the proxy for this domain).

Copy `vm/credentials.json.template` to wherever the Claude Code CLI expects `credentials.json` inside the VM.

- [ ] **Step 5: Commit**

```bash
git add scripts/vm-setup-iptables.sh scripts/vm-trust-ca.sh vm/credentials.json.template
git commit -m "Add VM-side iptables/CA-trust scripts and the placeholder credentials template"
```

---

## Task 9: `envoy-proxy.md` walkthrough doc

**Files:**
- Create: `envoy-proxy.md`

**Interfaces:**
- Consumes: nothing — this is the doc tying every prior task together for a human operator.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Create `envoy-proxy.md`**

```markdown
# Envoy Sandbox Proxy — Setup

See `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md` for the full design.

## Prerequisites

- Docker and Docker Compose on the host machine.
- Node.js >=18 and pnpm on the host machine (to run `configamatron` and the automated tests).
- An Ubuntu VM (VMware) with routable network access to the host machine's IP.
- OpenSSL on the host machine (used by `scripts/generate-ca.sh`).

## Host-side setup

1. `pnpm install`
2. `configamatron import-sbx-network-policy balanced.policy.txt` — produces `allowlist.txt`.
3. `bash scripts/generate-ca.sh` — produces `envoy/ca/cert.pem` and `envoy/ca/key.pem`.
4. `configamatron build-envoy-config` — produces `envoy/envoy.yaml` from `allowlist.txt`.
5. Add the `SessionStart` hook from `scripts/host-session-hook.sh`'s manual-verification step to `~/.claude/settings.json`, then run `claude` once on the host so the hook populates `envoy/secrets/sds-secret.yaml`.
6. `docker compose up -d`

## VM-side setup

1. Copy `envoy/ca/cert.pem` into the VM.
2. Copy `vm/credentials.json.template` into the VM, to wherever the Claude Code CLI expects `credentials.json`.
3. `sudo bash scripts/vm-trust-ca.sh <path-to-cert.pem>` (inside the VM).
4. `sudo bash scripts/vm-setup-iptables.sh <host-ip>` (inside the VM).

## Verification

- Automated: `pnpm test` (runs the full pipeline, including `test:integration`, which brings up and tears down a transient copy of the Envoy stack against a mock upstream — no VM or real credential required).
- Manual (requires the VM — see the design spec's Testing / Verification Plan for the full list):
  - `curl` an allow-listed domain from inside the VM succeeds; a non-allow-listed domain fails/resets.
  - Running the coding agent inside the VM against `api.anthropic.com`, using only the placeholder credential, gets real responses.
  - `apt-get update` succeeds from inside the VM (validates port 80 handling).
```

- [ ] **Step 2: Commit**

```bash
git add envoy-proxy.md
git commit -m "Add envoy-proxy.md setup walkthrough"
```

---

## Self-Review Notes

- **Spec coverage:** `build-envoy-config` + `--upstream-override` (Task 2), TLS termination/passthrough/port-80 behavior (Task 1), credential gate + injection (Tasks 1, 3, 6), CA (Task 3), `docker-compose.yml` (Task 4), automated integration testing section (Tasks 5–6), logging is intentionally **not** covered by a task — flagged below as a gap.
- **Gap found during self-review:** the design spec's "Logging" section (configurable all/denied-only access logging) has no task. Given every other requirement in the spec is now covered and this is a smaller, additive piece, it's called out here rather than expanding the plan further: add `access_log` entries (`envoy.access_loggers.file`) to the `http_connection_manager`/`tcp_proxy` configs in `src/envoyConfig.ts`, gated by a `logMode: 'all' | 'denied-only'` option, as a follow-up task before this feature is considered fully done.
- **Placeholder scan:** none — every step has runnable code and an exact expected result, except the intentionally-manual VM/host verification steps (Tasks 7 and 8), which is by design per the design spec's Testing/Verification Plan split.
- **Type consistency:** `Allowlist`, `UpstreamOverride`, `BuildEnvoyConfigOptions`, `MockUpstream` are named and typed identically everywhere they're used across Tasks 1–6.

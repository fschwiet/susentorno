# Host-Run MCP Servers Implementation Plan

**Goal:** Let susentorno launch MCP servers on the host and expose each to an isolated guest at a dedicated hostname through the existing Envoy proxy, cleartext-forwarded to a loopback port, with no credential injection.

**Architecture:** A new `.susentorno/mcp-servers.yaml` file is parsed and validated by a new `src/mcpServers.ts` module. `run-proxy` allocates a loopback port per declared server, spawns them in parallel (independent of Envoy's own bring-up), and supervises each with a background TCP-connect readiness probe plus an exit listener — either signal tears the whole proxy down. `envoyConfig.ts` gains a new cleartext destination kind routed to `host.docker.internal:<port>` (the container's view of the host loopback listener). `update-shares` generates a re-runnable guest post-script registering each server with the `claude`/`codex` CLIs.

**Tech Stack:** TypeScript, Node.js, `execa` (process spawning), `yaml` (parsing), `vitest` (unit + proxy-stack/Docker integration tests), Envoy (proxy).

## Global Constraints

- Fixed 60-second readiness-probe timeout per MCP server (not configurable per server).
- No auth at the MCP HTTP layer — no lua gate, no `credential_injector` filter.
- Envoy cluster upstream address is `host.docker.internal:<port>`, never `127.0.0.1:<port>` (that resolves inside the Envoy container).
- The spawned server process itself binds `127.0.0.1` via the `{ip}` substitution in its `command`.
- `mcp-servers.yaml` is read once at `run-proxy` startup; no live file watching.
- Servers launch in parallel; Envoy bring-up proceeds concurrently, not gated on MCP readiness.
- `name` must match `^[a-zA-Z0-9_-]+$`; `hostname` must be a syntactically valid DNS hostname; both must be unique across entries. Any violation (or an unreadable/malformed file) is fatal at `run-proxy` startup — never warn-and-drop.
- An MCP hostname colliding with an `allowlist.txt` `host:443` entry is resolved (not fatal): MCP always wins, with a warning.
- `claude mcp` commands use `--scope user`; `codex mcp` has no scope flag.

---

## File Structure

New files:

- `src/mcpServers.ts` — `McpServerConfig` type, `parseMcpServers`, `readMcpServers`, `resolveMcpAllowlistCollisions`.
- `src/mcpPostScript.ts` — `generateMcpPostScript` (guest CLI registration script generation for `update-shares`).
- `src/runProxy/allocateMcpPorts.ts` — allocate N free loopback ports.
- `src/runProxy/mcpProcess.ts` — thin `execa`-based real implementations: spawn a server, TCP-connect readiness probe.
- `src/runProxy/mcpSupervisor.ts` — dependency-injected orchestration: parallel launch, readiness-timeout-or-exit → fatal (once), console line prefixing, teardown.

Modified files:

- `src/envPaths.ts` — add the `mcp-servers.yaml` path.
- `src/envoyConfig.ts` — new MCP filter-chain/cluster builder, threaded into `generateEnvoyConfig`.
- `src/runProxy/buildConfig.ts` — thread MCP server upstreams through to `generateEnvoyConfig`.
- `src/runProxy/classify.ts` — new `mcp` pathId → `ALLOW MCP` tag.
- `src/runProxy/runProxyLoop.ts` — MCP config/deps, startup sequencing, MCP-triggered fatal (stops both Envoy colors), MCP process teardown on every shutdown path.
- `src/commands/runProxy.ts` — read `mcp-servers.yaml`, wire real MCP deps.
- `src/weaveShares.ts` — accept generated (not just on-disk) built-in post-scripts.
- `src/commands/updateShares.ts` — generate the MCP post-script content and feed it into `weaveShares`.

Test files (new or extended, one per task below):

- `tests/unit/mcpServers.test.ts`
- `tests/unit/mcpPostScript.test.ts`
- `tests/unit/mcpPortAllocation.test.ts`
- `tests/unit/mcpProcess.test.ts`
- `tests/unit/mcpSupervisor.test.ts`
- `tests/unit/proxyConfig.test.ts` (extend)
- `tests/unit/logLineClassification.test.ts` (extend)
- `tests/unit/proxyStackSupervisor.test.ts` (extend)
- `tests/unit/weaveShares.test.ts` (extend)
- `tests/proxy-stack/mcpServer.test.ts` (plus a new fixture, `tests/fixtures/mcpFakeServer.mjs`)

---

## Task 1: `EnvPaths` — add the `mcp-servers.yaml` path

**Files:**

- Modify: `src/envPaths.ts:17-42` (interface), `src/envPaths.ts:44-86` (`envPaths` function)
- Test: `tests/unit/envPaths.test.ts`

**Interfaces:**

- Produces: `EnvPaths.mcpServers: string` — absolute path to `.susentorno/mcp-servers.yaml`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/envPaths.test.ts` (open the file first to match its existing `describe`/`it` structure and import style; add this case alongside the other path assertions):

```ts
it('includes the mcp-servers.yaml path under the environment root', () => {
  const paths = envPaths('/fake/cwd');
  expect(paths.mcpServers).toBe(join('/fake/cwd', '.susentorno', 'mcp-servers.yaml'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/envPaths.test.ts -t "mcp-servers.yaml path"`
Expected: FAIL — `paths.mcpServers` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/envPaths.ts`, add to the `EnvPaths` interface (after `allowlist: string;`):

```ts
  mcpServers: string;
```

In `envPaths()`, add to the returned object (after `allowlist: join(proxy, 'allowlist.txt'),`):

```ts
    mcpServers: join(root, 'mcp-servers.yaml'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/envPaths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "envPaths: add mcp-servers.yaml path"
```

---

## Task 2: `mcpServers.ts` — schema, parsing, validation

**Files:**

- Create: `src/mcpServers.ts`
- Test: `tests/unit/mcpServers.test.ts`

**Interfaces:**

- Produces:
  - `interface McpServerConfig { name: string; hostname: string; command: string; cwd?: string; env?: Record<string, string>; }`
  - `function parseMcpServers(content: string): McpServerConfig[]` — throws `Error` on any structural/validation problem.
  - `function readMcpServers(path: string): McpServerConfig[]` — returns `[]` if `path` doesn't exist; otherwise reads and calls `parseMcpServers`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcpServers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpServers, readMcpServers } from '../../src/mcpServers';

describe('mcp-servers.yaml parsing & validation', () => {
  it('parses a valid file with all fields', () => {
    const content = [
      'servers:',
      '  - name: filesystem',
      '    hostname: filesystem.internal',
      '    command: npx -y @modelcontextprotocol/server-filesystem {ip} {port} /allowed',
      '    cwd: /home/me/project',
      '    env:',
      '      SOME_TOKEN: abc123',
      '',
    ].join('\n');

    expect(parseMcpServers(content)).toEqual([
      {
        name: 'filesystem',
        hostname: 'filesystem.internal',
        command: 'npx -y @modelcontextprotocol/server-filesystem {ip} {port} /allowed',
        cwd: '/home/me/project',
        env: { SOME_TOKEN: 'abc123' },
      },
    ]);
  });

  it('parses a minimal entry with only the required fields', () => {
    const content = ['servers:', '  - name: fs', '    hostname: fs.internal', '    command: fs-cmd', ''].join(
      '\n',
    );
    expect(parseMcpServers(content)).toEqual([
      { name: 'fs', hostname: 'fs.internal', command: 'fs-cmd', cwd: undefined, env: undefined },
    ]);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseMcpServers('servers: [')).toThrow('not valid YAML');
  });

  it("throws when there is no top-level 'servers' list", () => {
    expect(() => parseMcpServers('foo: bar\n')).toThrow("top-level 'servers' list");
  });

  it('throws when name has invalid characters', () => {
    const content = ['servers:', '  - name: "bad name!"', '    hostname: fs.internal', '    command: x', ''].join(
      '\n',
    );
    expect(() => parseMcpServers(content)).toThrow('servers[0].name');
  });

  it('throws when hostname is not a valid DNS hostname', () => {
    const content = ['servers:', '  - name: fs', '    hostname: "not a host!"', '    command: x', ''].join('\n');
    expect(() => parseMcpServers(content)).toThrow('servers[0].hostname');
  });

  it('throws when command is missing', () => {
    const content = ['servers:', '  - name: fs', '    hostname: fs.internal', ''].join('\n');
    expect(() => parseMcpServers(content)).toThrow('servers[0].command');
  });

  it('throws on a duplicate name', () => {
    const content = [
      'servers:',
      '  - name: fs',
      '    hostname: a.internal',
      '    command: x',
      '  - name: fs',
      '    hostname: b.internal',
      '    command: y',
      '',
    ].join('\n');
    expect(() => parseMcpServers(content)).toThrow("duplicate server name 'fs'");
  });

  it('throws on a duplicate hostname', () => {
    const content = [
      'servers:',
      '  - name: fs',
      '    hostname: shared.internal',
      '    command: x',
      '  - name: git',
      '    hostname: shared.internal',
      '    command: y',
      '',
    ].join('\n');
    expect(() => parseMcpServers(content)).toThrow("duplicate server hostname 'shared.internal'");
  });
});

describe('readMcpServers', () => {
  it('returns an empty list when the file does not exist', () => {
    expect(readMcpServers('/definitely/not/a/real/path/mcp-servers.yaml')).toEqual([]);
  });

  it('reads and parses an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-servers-test-'));
    const path = join(dir, 'mcp-servers.yaml');
    writeFileSync(
      path,
      ['servers:', '  - name: fs', '    hostname: fs.internal', '    command: x', ''].join('\n'),
    );
    try {
      expect(readMcpServers(path)).toEqual([
        { name: 'fs', hostname: 'fs.internal', command: 'x', cwd: undefined, env: undefined },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcpServers.test.ts`
Expected: FAIL — module `../../src/mcpServers` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcpServers.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface McpServerConfig {
  name: string;
  hostname: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HOSTNAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function validateServer(raw: unknown, index: number): McpServerConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`mcp-servers.yaml: servers[${index}] must be a mapping`);
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) {
    throw new Error(
      `mcp-servers.yaml: servers[${index}].name must match ${NAME_RE} (got ${JSON.stringify(r.name)})`,
    );
  }
  if (typeof r.hostname !== 'string' || !HOSTNAME_RE.test(r.hostname)) {
    throw new Error(
      `mcp-servers.yaml: servers[${index}].hostname must be a valid hostname (got ${JSON.stringify(r.hostname)})`,
    );
  }
  if (typeof r.command !== 'string' || r.command.trim() === '') {
    throw new Error(`mcp-servers.yaml: servers[${index}].command is required`);
  }
  if (r.cwd !== undefined && typeof r.cwd !== 'string') {
    throw new Error(`mcp-servers.yaml: servers[${index}].cwd must be a string`);
  }
  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env)) {
      throw new Error(`mcp-servers.yaml: servers[${index}].env must be a mapping of strings`);
    }
    for (const [key, value] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`mcp-servers.yaml: servers[${index}].env.${key} must be a string`);
      }
    }
  }

  return {
    name: r.name,
    hostname: r.hostname,
    command: r.command,
    cwd: r.cwd as string | undefined,
    env: r.env as Record<string, string> | undefined,
  };
}

export function parseMcpServers(content: string): McpServerConfig[] {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch (err) {
    throw new Error(`mcp-servers.yaml is not valid YAML: ${String(err)}`);
  }
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as Record<string, unknown>).servers)) {
    throw new Error("mcp-servers.yaml must have a top-level 'servers' list");
  }

  const servers = (doc as { servers: unknown[] }).servers.map(validateServer);

  const names = new Set<string>();
  const hostnames = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new Error(`mcp-servers.yaml: duplicate server name '${server.name}'`);
    }
    names.add(server.name);
    if (hostnames.has(server.hostname)) {
      throw new Error(`mcp-servers.yaml: duplicate server hostname '${server.hostname}'`);
    }
    hostnames.add(server.hostname);
  }

  return servers;
}

/** Returns [] if `path` doesn't exist. Throws on any read, parse, or validation failure. */
export function readMcpServers(path: string): McpServerConfig[] {
  if (!existsSync(path)) return [];
  return parseMcpServers(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcpServers.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/mcpServers.ts tests/unit/mcpServers.test.ts
git commit -m "mcpServers: add mcp-servers.yaml schema, parsing, and validation"
```

---

## Task 3: `mcpServers.ts` — collision resolution against `allowlist.txt`

**Files:**

- Modify: `src/mcpServers.ts`
- Test: `tests/unit/mcpServers.test.ts`

**Interfaces:**

- Consumes: `Allowlist` from `../src/allowlist` (its five host-list fields plus `warnings`), `McpServerConfig` from Task 2.
- Produces: `function resolveMcpAllowlistCollisions(allowlist: Allowlist, servers: McpServerConfig[]): Allowlist` — returns a new `Allowlist` with any colliding entries removed and a collision warning appended to `.warnings` for each.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/mcpServers.test.ts`:

```ts
import type { Allowlist } from '../../src/allowlist';
import { resolveMcpAllowlistCollisions } from '../../src/mcpServers';

describe('resolveMcpAllowlistCollisions', () => {
  const baseAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: [],
    githubAuthenticated: [],
    codexAuthenticated: [],
    authCandidate: [],
    warnings: [],
  };

  it('removes a passthrough entry that collides with an MCP hostname and warns', () => {
    const allowlist: Allowlist = { ...baseAllowlist, passthrough: ['filesystem.internal:443', 'other.com:443'] };
    const servers = [{ name: 'fs', hostname: 'filesystem.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.passthrough).toEqual(['other.com:443']);
    expect(resolved.warnings).toEqual([
      "collision: 'filesystem.internal:443' listed in passthrough and mcp-servers.yaml; using mcp-servers.yaml",
    ]);
  });

  it('checks every section, not just passthrough', () => {
    const allowlist: Allowlist = { ...baseAllowlist, claudeAuthenticated: ['fs.internal:443'] };
    const servers = [{ name: 'fs', hostname: 'fs.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.claudeAuthenticated).toEqual([]);
    expect(resolved.warnings).toEqual([
      "collision: 'fs.internal:443' listed in claudeAuthenticated and mcp-servers.yaml; using mcp-servers.yaml",
    ]);
  });

  it('does not modify or warn when there is no collision', () => {
    const allowlist: Allowlist = { ...baseAllowlist, passthrough: ['unrelated.com:443'] };
    const servers = [{ name: 'fs', hostname: 'fs.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved).toEqual(allowlist);
  });

  it('preserves pre-existing warnings alongside any new collision warnings', () => {
    const allowlist: Allowlist = { ...baseAllowlist, warnings: ['pre-existing warning'] };
    const resolved = resolveMcpAllowlistCollisions(allowlist, []);
    expect(resolved.warnings).toEqual(['pre-existing warning']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcpServers.test.ts -t "resolveMcpAllowlistCollisions"`
Expected: FAIL — `resolveMcpAllowlistCollisions` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/mcpServers.ts` (new import at the top, plus the function):

```ts
import type { Allowlist } from './allowlist';
```

```ts
const ALLOWLIST_SECTIONS = [
  ['passthrough', 'passthrough'],
  ['claudeAuthenticated', 'claudeAuthenticated'],
  ['githubAuthenticated', 'githubAuthenticated'],
  ['codexAuthenticated', 'codexAuthenticated'],
  ['authCandidate', 'authCandidate'],
] as const;

/**
 * MCP always wins a hostname collision with allowlist.txt: the colliding entry is
 * dropped from whichever section it was in, with a warning, so Envoy never sees two
 * filter chains matching one SNI. Resolved separately from parseAllowlist's own
 * intra-allowlist collision priority, since mcp-servers.yaml is a different file.
 */
export function resolveMcpAllowlistCollisions(
  allowlist: Allowlist,
  servers: McpServerConfig[],
): Allowlist {
  const resolved: Allowlist = {
    passthrough: [...allowlist.passthrough],
    claudeAuthenticated: [...allowlist.claudeAuthenticated],
    githubAuthenticated: [...allowlist.githubAuthenticated],
    codexAuthenticated: [...allowlist.codexAuthenticated],
    authCandidate: [...allowlist.authCandidate],
    warnings: [...allowlist.warnings],
  };

  for (const server of servers) {
    const entry = `${server.hostname}:443`;
    for (const [key, label] of ALLOWLIST_SECTIONS) {
      const list = resolved[key];
      const idx = list.indexOf(entry);
      if (idx === -1) continue;
      list.splice(idx, 1);
      resolved.warnings.push(
        `collision: '${entry}' listed in ${label} and mcp-servers.yaml; using mcp-servers.yaml`,
      );
    }
  }

  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcpServers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcpServers.ts tests/unit/mcpServers.test.ts
git commit -m "mcpServers: resolve MCP-vs-allowlist hostname collisions, MCP wins"
```

---

## Task 4: `envoyConfig.ts` — MCP destination kind

**Files:**

- Modify: `src/envoyConfig.ts` (add `McpServerUpstream`, `buildMcpEntry`, thread into `generateEnvoyConfig`)
- Test: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Produces:
  - `interface McpServerUpstream { hostname: string; port: number; }` (exported from `src/envoyConfig.ts`)
  - `BuildEnvoyConfigOptions.mcpServers?: McpServerUpstream[]`
  - `generateEnvoyConfig(allowlist, options)` now also emits one filter chain + cluster per entry in `options.mcpServers`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/proxyConfig.test.ts` (new top-level `describe`, alongside the existing ones; reuses the file's existing `allowlist` fixture):

```ts
describe('host-run MCP servers', () => {
  it('builds a cleartext filter chain and cluster routed to host.docker.internal', () => {
    const config = generateEnvoyConfig(allowlist, {
      mcpServers: [{ hostname: 'filesystem.internal', port: 54321 }],
    }) as any;
    const listener443 = config.static_resources.listeners.find((l: any) => l.name === 'listener_443');
    const mcpChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('filesystem.internal'),
    );

    expect(mcpChain).toBeDefined();
    expect(mcpChain.transport_socket.typed_config.common_tls_context.tls_certificates[0]).toEqual({
      certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
      private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
    });

    const hcm = mcpChain.filters[0].typed_config;
    expect(hcm.access_log[0].typed_config.log_format.text_format_source.inline_string).toContain('CFGM|mcp|');
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_mcp_filesystem_internal',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_mcp_filesystem_internal',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: 'host.docker.internal', port_value: 54321 });
    expect(cluster.transport_socket).toBeUndefined();
  });

  it('omits MCP chains and clusters when no MCP servers are declared', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find((l: any) => l.name === 'listener_443');
    expect(
      listener443.filter_chains.some((fc: any) => fc.filter_chain_match?.server_names?.[0]?.endsWith('.internal')),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/proxyConfig.test.ts -t "host-run MCP servers"`
Expected: FAIL — `filesystem.internal` chain not found; `options.mcpServers` unused.

- [ ] **Step 3: Write minimal implementation**

In `src/envoyConfig.ts`, add near `BuildEnvoyConfigOptions` (after its `fault?` field):

```ts
export interface McpServerUpstream {
  hostname: string;
  port: number;
}
```

```ts
  mcpServers?: McpServerUpstream[];
```

Add a builder function (place it after `buildCodexEntry`, before `DYNAMIC_FORWARD_PROXY_HTTP_CACHE`):

```ts
function buildMcpEntry(server: McpServerUpstream) {
  const clusterName = `cluster_mcp_${sanitizeName(server.hostname)}`;

  const filterChain = {
    filter_chain_match: { server_names: [server.hostname] },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext',
        common_tls_context: {
          tls_certificates: [
            {
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
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
          stat_prefix: `mcp_${sanitizeName(server.hostname)}`,
          access_log: accessLog('mcp'),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'mcp',
                domains: ['*'],
                routes: [
                  { match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } },
                ],
              },
            ],
          },
          // No auth_pre/credential_injector/auth_post: host-run MCP servers have no
          // auth of any form — network isolation is the only gate (see ADR host-run-mcp-servers).
          http_filters: [
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

  // Envoy runs inside the Docker container, so `127.0.0.1` here would be the
  // container's own loopback. host.docker.internal reaches the host, where the
  // spawned MCP server actually bound 127.0.0.1 (declared in docker-compose.yml's
  // `extra_hosts: host.docker.internal:host-gateway`). No transport_socket: cleartext
  // upstream, unlike every other terminated chain.
  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    dns_lookup_family: 'V4_ONLY',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: { socket_address: { address: 'host.docker.internal', port_value: server.port } },
              },
            },
          ],
        },
      ],
    },
  };

  return { filterChain, cluster };
}
```

In `generateEnvoyConfig`, add near the other `*Built` variables (after `githubBuilt`):

```ts
  const mcpBuilt = (options.mcpServers ?? []).map(buildMcpEntry);
```

Add `...mcpBuilt.map((b) => b.filterChain)` to the `filter_chains` array (after `...githubBuilt.map((b) => b.filterChain),`), and `...mcpBuilt.map((b) => b.cluster)` to the `clusters` array (after `...githubBuilt.map((b) => b.cluster),`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/proxyConfig.test.ts`
Expected: PASS (including all pre-existing cases in the file — this is an additive change)

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/proxyConfig.test.ts
git commit -m "envoyConfig: add cleartext MCP destination kind routed to host.docker.internal"
```

---

## Task 5: `buildConfig.ts` — thread MCP upstreams through `writeEnvoyConfig`

**Files:**

- Modify: `src/runProxy/buildConfig.ts`
- Test: `tests/unit/proxyConfigWriting.test.ts`

**Interfaces:**

- Consumes: `McpServerUpstream` from `src/envoyConfig.ts` (Task 4).
- Produces: `writeEnvoyConfig(allowlist, outputPath, overrides, fault?, mcpServers?)` — `mcpServers` is passed straight through to `generateEnvoyConfig`'s options.

- [ ] **Step 1: Write the failing test**

`tests/unit/proxyConfigWriting.test.ts` currently has a single `it`, using a per-test `mkdtempSync` directory (not a shared fixture) and the file's own local `ALLOWLIST` constant parsed via `parseAllowlist`. Add a second case in the same style, inside the existing `describe('proxy configuration writing', ...)` block:

```ts
it('threads mcpServers through to the generated config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
  const outputPath = join(dir, 'envoy.yaml');
  try {
    writeEnvoyConfig(parseAllowlist(ALLOWLIST), outputPath, [], undefined, [
      { hostname: 'fs.internal', port: 9999 },
    ]);

    const config = parse(readFileSync(outputPath, 'utf8')) as {
      static_resources: { listeners: Array<{ name: string; filter_chains: any[] }> };
    };
    const listener443 = config.static_resources.listeners.find((l) => l.name === 'listener_443');
    expect(
      listener443!.filter_chains.some((fc: any) => fc.filter_chain_match?.server_names?.includes('fs.internal')),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/proxyConfigWriting.test.ts -t "threads mcpServers"`
Expected: FAIL — TypeScript error (too many arguments to `writeEnvoyConfig`) until Step 3's `buildConfig.ts` change lands.

- [ ] **Step 3: Write minimal implementation**

In `src/runProxy/buildConfig.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { generateEnvoyConfig, type UpstreamOverride, type InjectFault, type McpServerUpstream } from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist and
 * write it to outputPath. Surfacing `allowlist.warnings` is the caller's job.
 * `fault` is a test-only render mutation; when omitted the output is unchanged.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
  fault?: InjectFault,
  mcpServers?: McpServerUpstream[],
): void {
  writeFileSync(outputPath, stringify(generateEnvoyConfig(allowlist, { overrides, fault, mcpServers })));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/proxyConfigWriting.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/buildConfig.ts tests/unit/proxyConfigWriting.test.ts
git commit -m "buildConfig: thread MCP server upstreams through to envoy.yaml generation"
```

---

## Task 6: `classify.ts` — `ALLOW MCP` access-log tag

**Files:**

- Modify: `src/runProxy/classify.ts`
- Test: `tests/unit/logLineClassification.test.ts`

**Interfaces:**

- Consumes: `AccessLine` from `./parseLine` (unchanged).
- Produces: `Tag` union gains `'ALLOW MCP'`; `classify()` maps `line.pathId === 'mcp'` to it.

- [ ] **Step 1: Write the failing test**

Open `tests/unit/logLineClassification.test.ts` to match its existing style (constructs an `AccessLine` and asserts on `classify(...)`), then add:

```ts
it('classifies an mcp pathId as ALLOW MCP', () => {
  const line = {
    pathId: 'mcp',
    time: '12:00:00',
    serverName: 'filesystem.internal',
    authority: 'filesystem.internal',
    codeDetails: '-',
  } as const; // match the AccessLine shape used by the file's other cases
  expect(classify(line as any)).toEqual([{ time: '12:00:00', tag: 'ALLOW MCP', domain: 'filesystem.internal' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/logLineClassification.test.ts -t "ALLOW MCP"`
Expected: FAIL — `classify` returns `tag: undefined` (switch falls through with no case) or throws, depending on TS strictness at runtime; the assertion fails either way.

- [ ] **Step 3: Write minimal implementation**

In `src/runProxy/classify.ts`, extend the `Tag` union:

```ts
export type Tag =
  | 'ALLOW CRED'
  | 'ALLOW PASS'
  | 'ALLOW HTTP'
  | 'ALLOW MCP'
  | 'BLOCK TLS'
  | 'BLOCK HTTP'
  | 'AUTH CANDIDATE';
```

Add a case to the `switch (line.pathId)` block (after the `case 'pass':` block):

```ts
    case 'mcp':
      tag = 'ALLOW MCP';
      break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/logLineClassification.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/classify.ts tests/unit/logLineClassification.test.ts
git commit -m "classify: add ALLOW MCP access-log tag for the mcp pathId"
```

---

## Task 7: `allocateMcpPorts` — free loopback ports for MCP servers

**Files:**

- Create: `src/runProxy/allocateMcpPorts.ts`
- Test: `tests/unit/mcpPortAllocation.test.ts`

**Interfaces:**

- Produces: `function allocateMcpPorts(count: number): Promise<number[]>` — resolves with `count` distinct free loopback ports; `[]` when `count` is `0`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcpPortAllocation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { allocateMcpPorts } from '../../src/runProxy/allocateMcpPorts';

describe('allocateMcpPorts', () => {
  it('returns the requested number of distinct ports', async () => {
    const ports = await allocateMcpPorts(3);
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) expect(port).toBeGreaterThan(0);
  });

  it('returns an empty array for zero servers', async () => {
    expect(await allocateMcpPorts(0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcpPortAllocation.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/runProxy/allocateMcpPorts.ts`:

```ts
import net from 'node:net';

function openEphemeral(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Allocate `count` distinct free loopback ports, one per declared MCP server. All
 * sockets are held open at once before any is released, so the OS cannot hand out the
 * same port twice — same pattern as allocateColorPorts.
 */
export async function allocateMcpPorts(count: number): Promise<number[]> {
  if (count === 0) return [];
  const servers = await Promise.all(Array.from({ length: count }, () => openEphemeral()));
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcpPortAllocation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/allocateMcpPorts.ts tests/unit/mcpPortAllocation.test.ts
git commit -m "runProxy: add allocateMcpPorts for host-run MCP server loopback ports"
```

---

## Task 8: `mcpProcess.ts` — real spawn + TCP-connect readiness probe

**Files:**

- Create: `src/runProxy/mcpProcess.ts`
- Test: `tests/unit/mcpProcess.test.ts`

**Interfaces:**

- Produces:
  - `interface McpChildHandle { pid: number; onExit: (cb: (code: number | null, signal: string | null) => void) => void; }`
  - `function spawnMcpServer(command: string, opts: { cwd?: string; env?: Record<string, string> }, onLine: (line: string) => void): McpChildHandle`
  - `function probeMcpReady(port: number, timeoutMs: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcpProcess.test.ts` (real subprocess/socket integration, same style as `tests/unit/processTermination.test.ts`):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { spawnMcpServer, probeMcpReady } from '../../src/runProxy/mcpProcess';
import { killProcessTree } from '../../src/runProxy/killProcessTree';

describe('spawnMcpServer', () => {
  it('spawns the shell command and streams its stdout lines', async () => {
    const lines: string[] = [];
    const isWin = process.platform === 'win32';
    const command = isWin ? 'echo hello-mcp' : 'echo hello-mcp';
    const handle = spawnMcpServer(command, {}, (line) => lines.push(line));
    try {
      await new Promise<void>((resolve) => handle.onExit(() => resolve()));
      expect(lines.some((l) => l.includes('hello-mcp'))).toBe(true);
    } finally {
      await killProcessTree(handle.pid, 'SIGTERM').catch(() => {});
    }
  });

  it('applies cwd and env to the spawned process', async () => {
    const lines: string[] = [];
    const isWin = process.platform === 'win32';
    const command = isWin ? 'echo %MCP_TEST_VAR%' : 'echo $MCP_TEST_VAR';
    const handle = spawnMcpServer(command, { env: { MCP_TEST_VAR: 'from-env' } }, (line) => lines.push(line));
    try {
      await new Promise<void>((resolve) => handle.onExit(() => resolve()));
      expect(lines.some((l) => l.includes('from-env'))).toBe(true);
    } finally {
      await killProcessTree(handle.pid, 'SIGTERM').catch(() => {});
    }
  });

  it('reports exit via onExit', async () => {
    const handle = spawnMcpServer(process.platform === 'win32' ? 'exit 0' : 'exit 0', {}, () => {});
    const result = await new Promise<{ code: number | null }>((resolve) =>
      handle.onExit((code) => resolve({ code })),
    );
    expect(result.code).toBe(0);
  });
});

describe('probeMcpReady', () => {
  let server: net.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('resolves true once something is listening on the port', async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probeMcpReady(port, 2000)).toBe(true);
  });

  it('resolves false when nothing is listening before the timeout', async () => {
    // 39217 is not bound by this test suite; a short timeout keeps this test fast.
    expect(await probeMcpReady(39217, 300)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcpProcess.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/runProxy/mcpProcess.ts`:

```ts
import { execa } from 'execa';
import { createInterface } from 'node:readline';
import net from 'node:net';

export interface McpChildHandle {
  pid: number;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
}

/**
 * Spawn `command` through a shell (its {ip}/{port}/etc. substitutions are already
 * baked in by the caller — see mcpServers.ts). `reject: false` means a non-zero exit
 * resolves rather than rejects the underlying promise, so both branches of `.then`
 * funnel into the same onExit callback.
 */
export function spawnMcpServer(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> },
  onLine: (line: string) => void,
): McpChildHandle {
  const child = execa(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    buffer: false,
    reject: false,
    // killProcessTree's non-Windows path signals the whole process group
    // (`process.kill(-pid, signal)`), which only reaches this child's own spawned
    // descendants (e.g. a shell-wrapped command re-execing the real server) if the
    // child is its own group leader — same requirement logStream.ts's execa call
    // already satisfies for the docker compose logs child.
    detached: process.platform !== 'win32',
  });

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', onLine);
  }

  if (child.pid === undefined) throw new Error(`failed to spawn MCP server: ${command}`);
  const pid = child.pid;

  return {
    pid,
    onExit: (cb) => {
      void child.then(
        (result) => cb(result.exitCode ?? null, result.signal ?? null),
        () => cb(null, null),
      );
    },
  };
}

/** Polls a TCP connect to 127.0.0.1:port every 250ms until it succeeds or timeoutMs elapses. */
export function probeMcpReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcpProcess.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/mcpProcess.ts tests/unit/mcpProcess.test.ts
git commit -m "runProxy: add real MCP server spawn and TCP readiness probe"
```

---

## Task 9: `mcpSupervisor.ts` — dependency-injected orchestration

**Files:**

- Create: `src/runProxy/mcpSupervisor.ts`
- Test: `tests/unit/mcpSupervisor.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks directly (fully mocked in tests); wired to the real `mcpProcess.ts`/`killProcessTree.ts` in Task 10.
- Produces:
  - `interface McpServerSpec { name: string; hostname: string; port: number; command: string; cwd?: string; env?: Record<string, string>; }`
  - `interface McpSupervisorDeps { spawn: (spec: McpServerSpec, onLine: (line: string) => void) => { pid: number; onExit: (cb: (code: number | null, signal: string | null) => void) => void }; probeReady: (port: number, timeoutMs: number) => Promise<boolean>; killProcessTree: (pid: number, signal: NodeJS.Signals) => Promise<void>; onLine: (name: string, line: string) => void; onReady: (name: string, elapsedMs: number) => void; onFatal: (message: string) => void; now: () => number; readyTimeoutMs: number; }`
  - `interface McpSupervisorHandle { stopAll: () => Promise<void>; }`
  - `function startMcpServers(specs: McpServerSpec[], deps: McpSupervisorDeps): McpSupervisorHandle`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcpSupervisor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startMcpServers, type McpSupervisorDeps, type McpServerSpec } from '../../src/runProxy/mcpSupervisor';

function spec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return { name: 'fs', hostname: 'fs.internal', port: 1234, command: 'run-fs', ...overrides };
}

function makeDeps(overrides: Partial<McpSupervisorDeps> = {}): {
  deps: McpSupervisorDeps;
  exitCallbacks: Map<string, (code: number | null, signal: string | null) => void>;
  resolveProbe: Map<string, (ready: boolean) => void>;
  pids: Map<string, number>;
} {
  const exitCallbacks = new Map<string, (code: number | null, signal: string | null) => void>();
  const resolveProbe = new Map<string, (ready: boolean) => void>();
  const pids = new Map<string, number>();
  let nextPid = 1000;

  const deps: McpSupervisorDeps = {
    spawn: vi.fn((s: McpServerSpec) => {
      const pid = nextPid++;
      pids.set(s.name, pid);
      return { pid, onExit: (cb: (code: number | null, signal: string | null) => void) => exitCallbacks.set(s.name, cb) };
    }),
    probeReady: vi.fn(
      (port: number) =>
        new Promise<boolean>((resolve) => {
          resolveProbe.set(String(port), resolve);
        }),
    ),
    killProcessTree: vi.fn().mockResolvedValue(undefined),
    onLine: vi.fn(),
    onReady: vi.fn(),
    onFatal: vi.fn(),
    now: () => 0,
    readyTimeoutMs: 60_000,
    ...overrides,
  };
  return { deps, exitCallbacks, resolveProbe, pids };
}

describe('startMcpServers', () => {
  it('spawns every declared server and reports readiness once its probe succeeds', async () => {
    // Three now() calls in order: 'fs' spawn start, 'git' spawn start (both happen
    // synchronously in the launch loop before either probe resolves), then 'fs's
    // elapsed-time read when its probe resolves below.
    const { deps, resolveProbe } = makeDeps({
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(500),
    });
    startMcpServers(
      [spec({ name: 'fs', port: 1111 }), spec({ name: 'git', hostname: 'git.internal', port: 2222 })],
      deps,
    );

    expect(deps.spawn).toHaveBeenCalledTimes(2);
    resolveProbe.get('1111')!(true);
    await Promise.resolve(); // let probeReady's .then() microtask run
    expect(deps.onReady).toHaveBeenCalledWith('fs', 500);
  });

  it('calls onFatal exactly once when a server exits, regardless of other servers', () => {
    const { deps, exitCallbacks } = makeDeps();
    startMcpServers([spec({ name: 'fs' }), spec({ name: 'git', hostname: 'git.internal', port: 2 })], deps);

    exitCallbacks.get('fs')!(1, null);
    exitCallbacks.get('git')!(1, null);

    expect(deps.onFatal).toHaveBeenCalledTimes(1);
    expect(deps.onFatal).toHaveBeenCalledWith(expect.stringContaining("mcp server 'fs' exited"));
  });

  it('calls onFatal when a probe never succeeds and does not call onReady for it', async () => {
    const { deps, resolveProbe } = makeDeps();
    startMcpServers([spec({ port: 3333 })], deps);

    resolveProbe.get('3333')!(false);
    await Promise.resolve();

    expect(deps.onFatal).toHaveBeenCalledWith(expect.stringContaining("did not become ready within 60000ms"));
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('stopAll kills every spawned process via killProcessTree', async () => {
    const { deps, pids } = makeDeps();
    const handle = startMcpServers([spec({ name: 'fs' }), spec({ name: 'git', hostname: 'git.internal', port: 2 })], deps);

    await handle.stopAll();

    expect(deps.killProcessTree).toHaveBeenCalledWith(pids.get('fs'), 'SIGTERM');
    expect(deps.killProcessTree).toHaveBeenCalledWith(pids.get('git'), 'SIGTERM');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcpSupervisor.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/runProxy/mcpSupervisor.ts`:

```ts
export interface McpServerSpec {
  name: string;
  hostname: string;
  port: number;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpChildHandle {
  pid: number;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
}

export interface McpSupervisorDeps {
  spawn: (spec: McpServerSpec, onLine: (line: string) => void) => McpChildHandle;
  probeReady: (port: number, timeoutMs: number) => Promise<boolean>;
  killProcessTree: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  onLine: (name: string, line: string) => void;
  onReady: (name: string, elapsedMs: number) => void;
  /** Called at most once total, across every server, for the first readiness-timeout or exit. */
  onFatal: (message: string) => void;
  now: () => number;
  readyTimeoutMs: number;
}

export interface McpSupervisorHandle {
  stopAll: () => Promise<void>;
}

/**
 * Launches every declared server in parallel. Readiness (a TCP-connect probe) and
 * exit are both supervised for the process's entire remaining lifetime, not just
 * until the probe first succeeds — either signal, for any server, at any time,
 * fires onFatal exactly once.
 */
export function startMcpServers(specs: McpServerSpec[], deps: McpSupervisorDeps): McpSupervisorHandle {
  let fatalFired = false;
  const pids: number[] = [];

  const fireFatal = (message: string): void => {
    if (fatalFired) return;
    fatalFired = true;
    deps.onFatal(message);
  };

  for (const spec of specs) {
    const startedAt = deps.now();
    let handle: McpChildHandle;
    try {
      handle = deps.spawn(spec, (line) => deps.onLine(spec.name, line));
    } catch (err) {
      fireFatal(`mcp server '${spec.name}' failed to start: ${String(err)}`);
      continue;
    }
    pids.push(handle.pid);

    let exited = false;
    handle.onExit((code, signal) => {
      exited = true;
      fireFatal(`mcp server '${spec.name}' exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    });

    void deps.probeReady(spec.port, deps.readyTimeoutMs).then((ready) => {
      if (exited || fatalFired) return;
      if (ready) {
        deps.onReady(spec.name, deps.now() - startedAt);
      } else {
        fireFatal(`mcp server '${spec.name}' did not become ready within ${deps.readyTimeoutMs}ms`);
      }
    });
  }

  return {
    stopAll: async () => {
      await Promise.all(pids.map((pid) => deps.killProcessTree(pid, 'SIGTERM').catch(() => {})));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcpSupervisor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/mcpSupervisor.ts tests/unit/mcpSupervisor.test.ts
git commit -m "runProxy: add mcpSupervisor orchestrating parallel launch, readiness, and exit"
```

---

## Task 10: `runProxyLoop.ts` — integrate MCP config, startup sequencing, and fatal teardown

**Files:**

- Modify: `src/runProxy/runProxyLoop.ts`
- Test: `tests/unit/proxyStackSupervisor.test.ts`

**Interfaces:**

- Consumes: `McpServerConfig`/`resolveMcpAllowlistCollisions` (Tasks 2–3), `McpServerUpstream` (Task 4), `startMcpServers`/`McpServerSpec`/`McpSupervisorHandle` (Task 9).
- Produces:
  - `RunProxyConfig.mcpServers?: McpServerConfig[]` (default `[]` when omitted)
  - `RunProxyConfig.mcpReadyTimeoutMs?: number` (default `60_000`)
  - `RunProxyDeps.buildConfig` signature becomes `(allowlist: Allowlist, mcpServers: McpServerUpstream[]) => void`
  - `RunProxyDeps.allocateMcpPorts: (count: number) => Promise<number[]>`
  - `RunProxyDeps.spawnMcpServer: McpSupervisorDeps['spawn']`
  - `RunProxyDeps.probeMcpReady: McpSupervisorDeps['probeReady']`
  - `RunProxyDeps.killProcessTree: (pid: number, signal: NodeJS.Signals) => Promise<void>`
  - Each `McpServerConfig.command`'s `{ip}`/`{port}` placeholders are substituted with `127.0.0.1` and the assigned port before being spawned (the spec's original substitution requirement — the earlier tasks only carry the unsubstituted `command` string through).

- [ ] **Step 1: Write the failing test**

Open `tests/unit/proxyStackSupervisor.test.ts` and extend its shared harness first (both new tests below depend on it), then add the two new tests. Edit `makeHarness()`'s `mocks` object to add:

```ts
    allocateMcpPorts: vi.fn(async (count: number) => Array.from({ length: count }, (_, i) => 30000 + i)),
    spawnMcpServer: vi.fn((spec: { name: string }, _onLine: (line: string) => void) => ({
      pid: 9000,
      onExit: () => {},
    })),
    probeMcpReady: vi.fn().mockResolvedValue(true),
    killProcessTree: vi.fn().mockResolvedValue(undefined),
```

and add the corresponding fields to the `deps: RunProxyDeps` object in the same function:

```ts
    allocateMcpPorts: mocks.allocateMcpPorts,
    spawnMcpServer: mocks.spawnMcpServer,
    probeMcpReady: mocks.probeMcpReady,
    killProcessTree: mocks.killProcessTree,
```

and to the `Harness['mocks']` type declaration (add the four `ReturnType<typeof vi.fn>` entries alongside the existing ones).

Then add a new top-level `describe` block at the end of the file, before the final closing of the outer `describe('proxy stack supervision', ...)`:

```ts
  describe('host-run MCP servers', () => {
    it('allocates ports, spawns servers, and includes their hostnames in the leaf SANs and envoy config', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      void runProxyLoop(config, h.deps);
      await flush();

      expect(h.mocks.allocateMcpPorts).toHaveBeenCalledWith(1);
      expect(h.mocks.spawnMcpServer).toHaveBeenCalledTimes(1);
      expect(h.mocks.spawnMcpServer.mock.calls[0][0]).toMatchObject({
        name: 'fs',
        hostname: 'fs.internal',
        command: 'run-fs',
        port: 30000,
      });
      expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(
        expect.arrayContaining(['api.anthropic.com', 'fs.internal']),
      );
      expect(h.mocks.buildConfig.mock.calls[0][1]).toEqual([{ hostname: 'fs.internal', port: 30000 }]);
    });

    it('does not wait for MCP readiness before bringing up Envoy', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let releaseProbe!: (ready: boolean) => void;
      h.mocks.probeMcpReady.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (releaseProbe = resolve)),
      );
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      void runProxyLoop(config, h.deps);
      await flush();

      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // Envoy started despite the pending probe
      expect(h.mocks.setActiveBackend).toHaveBeenCalledTimes(1);
      releaseProbe(true);
      await flush();
    });

    it('a probe timeout fatals the loop, stops both colors, and stops the mcp process', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      h.mocks.probeMcpReady.mockResolvedValueOnce(false);
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runProxyLoop(config, h.deps);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining("did not become ready"));
      expect(h.mocks.stopColor).toHaveBeenCalledWith('blue');
      expect(h.mocks.stopColor).toHaveBeenCalledWith('green');
      expect(h.mocks.killProcessTree).toHaveBeenCalledWith(9000, 'SIGTERM');
    });

    it('an mcp server exiting after the proxy is already serving still fatals the whole loop', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let exitCb!: (code: number | null, signal: string | null) => void;
      h.mocks.spawnMcpServer.mockImplementationOnce((_spec: unknown, _onLine: unknown) => ({
        pid: 9001,
        onExit: (cb: (code: number | null, signal: string | null) => void) => (exitCb = cb),
      }));
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runProxyLoop(config, h.deps);
      await flush(); // proxy fully serving, mcp already reported ready

      exitCb(1, null);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining("mcp server 'fs' exited"));
    });

    it('SIGINT stops any still-running mcp server alongside the normal clean shutdown', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runProxyLoop(config, h.deps);
      await flush();

      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      expect(h.mocks.killProcessTree).toHaveBeenCalledWith(9000, 'SIGTERM');
    });

    it('substitutes {ip} and {port} into the command before spawning', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs --host {ip} --port {port}' }],
      };
      void runProxyLoop(config, h.deps);
      await flush();

      expect(h.mocks.spawnMcpServer.mock.calls[0][0].command).toBe('run-fs --host 127.0.0.1 --port 30000');
    });

    it('a SIGINT racing in while an mcp fatal is stopping the Envoy colors does not win with a clean exit', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let releaseStopColor!: () => void;
      h.mocks.stopColor.mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseStopColor = resolve)),
      );
      let exitCb!: (code: number | null, signal: string | null) => void;
      h.mocks.spawnMcpServer.mockImplementationOnce((_spec: unknown, _onLine: unknown) => ({
        pid: 9002,
        onExit: (cb: (code: number | null, signal: string | null) => void) => (exitCb = cb),
      }));
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runProxyLoop(config, h.deps);
      await flush();

      exitCb(1, null); // mcpFatal begins; its first stopColor call is blocked
      await flush();
      h.fireSigint(); // races in while the mcp-triggered teardown is still in flight
      await flush();
      releaseStopColor();
      await flush();

      // The mcp fatal must win: exit code 1, not the SIGINT's 0.
      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining("mcp server 'fs' exited"));
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/proxyStackSupervisor.test.ts`
Expected: FAIL — TypeScript errors (`mcpServers` not on `RunProxyConfig`, new `deps` fields not recognized) and/or the new assertions failing at runtime.

- [ ] **Step 3: Write minimal implementation**

In `src/runProxy/runProxyLoop.ts`:

Add imports (near the top, alongside the existing ones):

```ts
import type { McpServerConfig } from '../mcpServers';
import { resolveMcpAllowlistCollisions } from '../mcpServers';
import type { McpServerUpstream } from '../envoyConfig';
import { startMcpServers, type McpServerSpec, type McpSupervisorHandle } from './mcpSupervisor';
```

Extend `RunProxyConfig` (add after `drainTimeoutMs: number;`):

```ts
  /** Declared host-run MCP servers for this environment; defaults to none. */
  mcpServers?: McpServerConfig[];
  /** Fixed TCP-connect readiness timeout per MCP server. Defaults to 60s. */
  mcpReadyTimeoutMs?: number;
```

Change `RunProxyDeps.buildConfig`'s signature (was `(allowlist: Allowlist) => void`):

```ts
  /** Render and write envoy.yaml (upstream overrides are baked in by the caller). */
  buildConfig: (allowlist: Allowlist, mcpServers: McpServerUpstream[]) => void;
```

Add new `RunProxyDeps` fields (after `stopColor`):

```ts
  /** Allocate `count` distinct free loopback ports for the declared MCP servers. */
  allocateMcpPorts: (count: number) => Promise<number[]>;
  /** Spawn one MCP server's command; onLine receives its stdout/stderr, unprefixed. */
  spawnMcpServer: (
    spec: McpServerSpec,
    onLine: (line: string) => void,
  ) => { pid: number; onExit: (cb: (code: number | null, signal: string | null) => void) => void };
  /** TCP-connect readiness probe for one MCP server's port. */
  probeMcpReady: (port: number, timeoutMs: number) => Promise<boolean>;
  /** Kill an MCP server's whole process tree. */
  killProcessTree: (pid: number, signal: NodeJS.Signals) => Promise<void>;
```

Inside `runProxyLoop`, near the top of the returned `Promise` body (after `const watchers: { close: () => void }[] = [];`), add:

```ts
    const mcpServerConfigs = config.mcpServers ?? [];
    const mcpReadyTimeoutMs = config.mcpReadyTimeoutMs ?? 60_000;
    const mcpHostnames = mcpServerConfigs.map((s) => s.hostname);
    let mcpServersWithPorts: McpServerUpstream[] = [];
    let mcpSupervisorHandle: McpSupervisorHandle | null = null;
```

Replace the `shutdown` function to also stop MCP servers and to accept an optional pre-teardown hook (was: `const shutdown = (code: number): void => { if (settled) return; settled = true; shutdownAbort.abort(); for (const channel of channels) channel.clearTimer(); for (const watcher of watchers) watcher.close(); void deps.stopLogStream().then(() => resolve(code)); };`):

```ts
    /**
     * `settled` flips to true synchronously, before `beforeTeardown` (if given) runs —
     * not after it resolves. This matters for mcpFatal below: without it, a SIGINT
     * racing in during mcpFatal's async color-stopping could call shutdown(0) first
     * and "win" with a clean exit code, silently losing the fact that an MCP server
     * had failed. Reserving `settled` immediately closes that window.
     */
    const shutdown = (code: number, beforeTeardown?: () => Promise<void>): void => {
      if (settled) return;
      settled = true;
      shutdownAbort.abort();
      for (const channel of channels) channel.clearTimer();
      for (const watcher of watchers) watcher.close();
      const pre = beforeTeardown ? beforeTeardown() : Promise.resolve();
      void pre
        .then(() => Promise.all([deps.stopLogStream(), mcpSupervisorHandle?.stopAll() ?? Promise.resolve()]))
        .then(() => resolve(code));
    };
```

Add a new `mcpFatal` function right after `fatal` (before the `channels` construction, since `mcpFatal` is referenced when starting the supervisor below):

```ts
    /**
     * An MCP-triggered fatal additionally stops both Envoy colors before the normal
     * shutdown teardown runs: unlike every other fatal path, leaving the container
     * running would let every other destination keep working while only the failed
     * MCP hostname went dead — exactly the silent partial degradation this exists to
     * prevent. stopColor on a color that was never brought up (or already stopped) is
     * expected to no-op or fail harmlessly; Promise.allSettled tolerates either. Note
     * this does NOT cover the process-level uncaughtException/unhandledRejection
     * safety net installed in commands/runProxy.ts, which calls process.exit()
     * directly and — like every other resource this codebase owns (including the
     * Envoy container itself) — is not expected to run any cleanup on a genuine crash;
     * that safety net's job is only the spoken alert, not graceful teardown.
     */
    const mcpFatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      shutdown(1, () =>
        Promise.allSettled([deps.stopColor('blue'), deps.stopColor('green')]).then(() => undefined),
      );
    };
```

Change `readParsedAllowlist` to resolve MCP collisions (was: `const allowlist = parseAllowlist(content); for (const warning of allowlist.warnings) ...; return allowlist;`):

```ts
    /** Read+parse the allowlist; null only when the file is unreadable (keep previous config). */
    const readParsedAllowlist = (): Allowlist | null => {
      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        deps.error(
          `run-proxy: could not read allowlist at ${config.allowlistPath}, keeping previous config`,
        );
        return null;
      }
      const allowlist = resolveMcpAllowlistCollisions(parseAllowlist(content), mcpServerConfigs);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);
      return allowlist;
    };
```

Change `applyAllowlist` to union MCP hostnames into the leaf SANs and pass MCP upstreams to `buildConfig` (was: `deps.log(...deps.ensureLeaf(terminateTlsHosts(allowlist))); deps.buildConfig(allowlist);`):

```ts
    /** Reissue the leaf if the TLS-terminated hosts changed and rewrite envoy.yaml. */
    const applyAllowlist = (allowlist: Allowlist): void => {
      deps.log(`run-proxy: ${deps.ensureLeaf([...terminateTlsHosts(allowlist), ...mcpHostnames])}`);
      deps.buildConfig(allowlist, mcpServersWithPorts);
    };
```

In `start()`, insert MCP port allocation and supervisor startup. First, replace the allowlist-read block (was: `const content = deps.readAllowlist(config.allowlistPath); if (content === null) {...} const allowlist = parseAllowlist(content); for (const warning of allowlist.warnings) ...;`):

```ts
      const ports = mcpServerConfigs.length > 0 ? await deps.allocateMcpPorts(mcpServerConfigs.length) : [];
      mcpServersWithPorts = mcpServerConfigs.map((s, i) => ({ hostname: s.hostname, port: ports[i] }));
      // {ip} is always 127.0.0.1: the spawned process itself must bind loopback only
      // (see the design spec) — only the Envoy cluster upstream uses host.docker.internal.
      const mcpSpecs: McpServerSpec[] = mcpServerConfigs.map((s, i) => ({
        name: s.name,
        hostname: s.hostname,
        port: ports[i],
        command: s.command.replaceAll('{ip}', '127.0.0.1').replaceAll('{port}', String(ports[i])),
        cwd: s.cwd,
        env: s.env,
      }));

      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        fatal(`could not read allowlist at ${config.allowlistPath}`);
        return;
      }
      const allowlist = resolveMcpAllowlistCollisions(parseAllowlist(content), mcpServerConfigs);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);
```

Then, right after the existing `try { applyAllowlist(allowlist); } catch (err) { fatal(...); return; }` block inside `start()`'s `try`, add the supervisor start (before `const ports = await deps.allocatePorts();` — rename that pre-existing Envoy-color-ports local from `ports` to `colorPorts` to avoid shadowing the new `ports` above, and update its two call sites in the same function accordingly):

```ts
        // Spawn MCP servers now that ports/hostnames are baked into envoy.yaml.
        // Readiness/exit supervision runs in the background for the rest of the
        // process; Envoy's own bring-up below proceeds without waiting on it.
        if (mcpSpecs.length > 0) {
          mcpSupervisorHandle = startMcpServers(mcpSpecs, {
            spawn: deps.spawnMcpServer,
            probeReady: deps.probeMcpReady,
            killProcessTree: deps.killProcessTree,
            onLine: (name, line) => deps.log(`[${name}] ${line}`),
            onReady: (name, elapsedMs) => deps.log(`[${name}] ready in ${elapsedMs}ms`),
            onFatal: (message) => mcpFatal(message),
            now: deps.now,
            readyTimeoutMs: mcpReadyTimeoutMs,
          });
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/proxyStackSupervisor.test.ts`
Expected: PASS (both the new MCP cases and every pre-existing case in the file — the `ports` → `colorPorts` rename is purely local, so unrelated tests are unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/runProxyLoop.ts tests/unit/proxyStackSupervisor.test.ts
git commit -m "runProxyLoop: launch and supervise host-run MCP servers alongside Envoy"
```

---

## Task 11: `commands/runProxy.ts` — wire the real MCP dependencies

**Files:**

- Modify: `src/commands/runProxy.ts`
- Test: none (thin wiring; covered end-to-end by Task 14's proxy-stack test)

**Interfaces:**

- Consumes: `readMcpServers` (Task 2), `allocateMcpPorts` (Task 7), `spawnMcpServer`/`probeMcpReady` (Task 8), `killProcessTree` (pre-existing).
- Produces: `run-proxy`'s CLI action reads `.susentorno/mcp-servers.yaml` and passes it through to `runProxyLoop`.

- [ ] **Step 1: Add the imports**

In `src/commands/runProxy.ts`, add near the existing imports:

```ts
import { readMcpServers } from '../mcpServers';
import { allocateMcpPorts } from '../runProxy/allocateMcpPorts';
import { spawnMcpServer, probeMcpReady } from '../runProxy/mcpProcess';
import { killProcessTree } from '../runProxy/killProcessTree';
```

- [ ] **Step 2: Read and validate `mcp-servers.yaml` before constructing `deps`**

Insert this right after the existing `const secretPath = options.secret ?? paths.sdsSecret;` line:

```ts
        let mcpServers;
        try {
          mcpServers = readMcpServers(paths.mcpServers);
        } catch (err) {
          console.error(`run-proxy: ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
```

- [ ] **Step 3: Wire the new `RunProxyDeps` fields and update `buildConfig`'s call**

In the `deps: RunProxyDeps = { ... }` object, change the existing `buildConfig` entry:

```ts
          buildConfig: (allowlist, mcpServersWithPorts) =>
            writeEnvoyConfig(
              allowlist,
              paths.envoyConfig,
              options.upstreamOverride,
              options.injectFault,
              mcpServersWithPorts,
            ),
```

and add, alongside the other deps (after `stopColor: (color: Color) => stopColor(color, paths.proxy),`):

```ts
          allocateMcpPorts,
          spawnMcpServer: (spec, onLine) => spawnMcpServer(spec.command, { cwd: spec.cwd, env: spec.env }, onLine),
          probeMcpReady,
          killProcessTree,
```

- [ ] **Step 4: Pass `mcpServers` into the `runProxyLoop` config**

In the `runProxyLoop({...}, deps)` call, add to the config object:

```ts
              mcpServers,
              mcpReadyTimeoutMs: 60_000,
```

- [ ] **Step 5: Verify the build compiles and existing tests still pass**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run tests/unit/commands`
Expected: PASS (pre-existing `runProxy.test.ts` cases unaffected — `mcp-servers.yaml` absent in its fixtures means `readMcpServers` returns `[]`)

- [ ] **Step 6: Commit**

```bash
git add src/commands/runProxy.ts
git commit -m "commands/runProxy: wire host-run MCP servers into the real run-proxy command"
```

---

## Task 12: `mcpPostScript.ts` — generate the guest CLI registration script

**Files:**

- Create: `src/mcpPostScript.ts`
- Test: `tests/unit/mcpPostScript.test.ts`

**Interfaces:**

- Consumes: `McpServerConfig` (Task 2).
- Produces: `function generateMcpPostScript(servers: McpServerConfig[], platform: 'sh' | 'ps1'): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcpPostScript.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateMcpPostScript } from '../../src/mcpPostScript';
import type { McpServerConfig } from '../../src/mcpServers';

const servers: McpServerConfig[] = [
  { name: 'filesystem', hostname: 'filesystem.internal', command: 'x' },
  { name: 'git', hostname: 'git.internal', command: 'y' },
];

describe('generateMcpPostScript', () => {
  it('returns an empty string when there are no servers', () => {
    expect(generateMcpPostScript([], 'sh')).toBe('');
    expect(generateMcpPostScript([], 'ps1')).toBe('');
  });

  it('emits a remove-then-add pair per server per CLI for sh, claude scoped to user', () => {
    const script = generateMcpPostScript(servers, 'sh');
    expect(script).toContain('claude mcp remove --scope user filesystem || true');
    expect(script).toContain('claude mcp add --scope user --transport http filesystem https://filesystem.internal');
    expect(script).toContain('codex mcp remove filesystem || true');
    expect(script).toContain('codex mcp add filesystem https://filesystem.internal');
    expect(script).toContain('claude mcp remove --scope user git || true');
    expect(script).toContain('codex mcp add git https://git.internal');
  });

  it('emits the ps1 equivalent without a bash-style || true', () => {
    const script = generateMcpPostScript(servers, 'ps1');
    expect(script).toContain('claude mcp remove --scope user filesystem');
    expect(script).toContain('claude mcp add --scope user --transport http filesystem https://filesystem.internal');
    expect(script).toContain('codex mcp remove filesystem');
    expect(script).toContain('codex mcp add filesystem https://filesystem.internal');
    expect(script).not.toContain('|| true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcpPostScript.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcpPostScript.ts`:

```ts
import type { McpServerConfig } from './mcpServers';

/**
 * Unconditional remove-then-add per server, per CLI: converges additions/edits on
 * every re-run (a server whose hostname changed gets re-registered), but does NOT
 * remove a server deleted or renamed out of mcp-servers.yaml — that's a documented,
 * accepted manual step (see the design spec). `codex mcp` has no --scope flag.
 */
export function generateMcpPostScript(servers: McpServerConfig[], platform: 'sh' | 'ps1'): string {
  if (servers.length === 0) return '';

  const lines: string[] = [];
  for (const server of servers) {
    const url = `https://${server.hostname}`;
    if (platform === 'sh') {
      lines.push(
        `claude mcp remove --scope user ${server.name} || true`,
        `claude mcp add --scope user --transport http ${server.name} ${url}`,
        `codex mcp remove ${server.name} || true`,
        `codex mcp add ${server.name} ${url}`,
      );
    } else {
      // PowerShell doesn't abort the script on a native command's non-zero exit
      // (unlike bash's `set -e`), so a "not found" remove needs no || true equivalent.
      lines.push(
        `claude mcp remove --scope user ${server.name}`,
        `claude mcp add --scope user --transport http ${server.name} ${url}`,
        `codex mcp remove ${server.name}`,
        `codex mcp add ${server.name} ${url}`,
      );
    }
  }

  const shebang = platform === 'sh' ? '#!/bin/bash\n\n' : '';
  return `${shebang}${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcpPostScript.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the `codex mcp remove` syntax against the installed CLI**

The design spec flags this explicitly: the exact `codex mcp remove` subcommand syntax was not confirmed against a real `codex` CLI at spec-writing time. Before committing, run `codex mcp remove --help` (or `codex mcp --help` if `remove` isn't a recognized subcommand) against whatever `codex` CLI version is available, and adjust the hardcoded `codex mcp remove ${server.name}`/`codex mcp add ${server.name} ${url}` strings in Step 3 if the real syntax differs (e.g. a different flag name, or `codex mcp delete` instead of `remove`). If no `codex` CLI is available in this environment, leave the strings as written and note this as a follow-up to verify manually before the feature ships.

- [ ] **Step 6: Commit**

```bash
git add src/mcpPostScript.ts tests/unit/mcpPostScript.test.ts
git commit -m "mcpPostScript: generate the guest MCP CLI registration script"
```

---

## Task 13: `weaveShares.ts` — accept a generated built-in post-script

**Files:**

- Modify: `src/weaveShares.ts`
- Test: `tests/unit/weaveShares.test.ts`

**Interfaces:**

- Produces:
  - `interface GeneratedScript { ext: ScriptExtension; remainder: string; sourcePath: string; }`
  - `planAllPhases(opts: { templatesDir: string; paths: EnvPaths; generatedPostScripts?: GeneratedScript[] })` — entries in `generatedPostScripts` matching a given platform's extension are folded into that platform's `post-scripts` plan as built-in scripts (numbered after the on-disk built-ins, before custom scripts).

- [ ] **Step 1: Write the failing test**

Open `tests/unit/weaveShares.test.ts` to match its existing fixture/assertion style (it builds a temp `templatesDir`/`paths` pair and inspects `planAllPhases(...)`'s resulting `PhasePlan[]` actions), then add:

```ts
it('folds a generated post-script into the post-scripts plan as a built-in, after the on-disk built-ins', () => {
  // Reuse the file's existing temp-dir/templatesDir/paths fixtures from its outer
  // beforeEach/setup; write one real on-disk built-in post-script (01-existing.sh)
  // the same way the file's other tests already do.
  const genDir = mkdtempSync(join(tmpdir(), 'gen-post-script-'));
  const genPath = join(genDir, 'mcp-servers.sh');
  writeFileSync(genPath, '#!/bin/bash\necho mcp\n');

  const plans = planAllPhases({
    templatesDir,
    paths,
    generatedPostScripts: [{ ext: 'sh', remainder: 'mcp-servers.sh', sourcePath: genPath }],
  });

  const shPostScripts = plans.find((p) => p.livePhaseDir === paths.vmShared + '/post-scripts' || p.livePhaseDir.endsWith('vm-shared-linux/post-scripts'));
  const names = shPostScripts!.actions.map((a) => a.destRel);
  expect(names).toContain('02-mcp-servers.sh'); // after the one on-disk built-in (01-existing.sh)

  rmSync(genDir, { recursive: true, force: true });
});
```

(Adjust the `shPostScripts` lookup and the expected numbered filename to match whatever built-in post-script fixture the existing test file already sets up in its shared setup — the key assertion is that the generated script appears, numbered as a built-in, ahead of any custom script.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/weaveShares.test.ts -t "generated post-script"`
Expected: FAIL — TypeScript error (`generatedPostScripts` not a valid option) and/or the file missing from the plan.

- [ ] **Step 3: Write minimal implementation**

In `src/weaveShares.ts`, add near the top (after the `WeaveAction`/`PhasePlan` interfaces):

```ts
export interface GeneratedScript {
  ext: ScriptExtension;
  /** Output filename after the 'NN-' prefix is stripped, e.g. 'mcp-servers.sh'. */
  remainder: string;
  /** A real file on disk holding the generated content (a temp file, typically). */
  sourcePath: string;
}
```

Change `planAllPhases`'s signature and its loop body (was: `export function planAllPhases(opts: { templatesDir: string; paths: EnvPaths }): PhasePlan[] { ... for (const phase of ['pre-scripts', 'post-scripts']) { for (const platform of platforms) { try { plans.push(planPhase({ ...no generatedScripts... })); } ... } } ... }`):

```ts
export function planAllPhases(opts: {
  templatesDir: string;
  paths: EnvPaths;
  generatedPostScripts?: GeneratedScript[];
}): PhasePlan[] {
  const platforms = [
    { ext: 'sh' as const, template: 'vm-shared-linux', output: opts.paths.vmShared, insensitive: false },
    {
      ext: 'ps1' as const,
      template: 'vm-shared-windows',
      output: opts.paths.vmSharedWindows,
      insensitive: true,
    },
  ];
  const plans: PhasePlan[] = [];
  const errors: string[] = [];
  for (const phase of ['pre-scripts', 'post-scripts'] as const) {
    for (const platform of platforms) {
      try {
        plans.push(
          planPhase({
            builtinPhaseDir: join(opts.templatesDir, platform.template, phase),
            customPhaseDir: join(opts.paths.root, phase),
            outPhaseDir: join(platform.output, phase),
            extension: platform.ext,
            caseInsensitive: platform.insensitive,
            generated:
              phase === 'post-scripts'
                ? (opts.generatedPostScripts ?? []).filter((g) => g.ext === platform.ext)
                : [],
          }),
        );
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n\n'));
  return plans;
}
```

Change `planPhase`'s signature and `labeled` construction (was: `function planPhase(opts: {...no generated...}): PhasePlan { ... const labeled: ... = [ ...builtin.scripts.filter(s => !s.sentinel)..., ...custom.scripts..., ...builtin.scripts.filter(s => s.sentinel)... ]; ... }`):

```ts
function planPhase(opts: {
  builtinPhaseDir: string;
  customPhaseDir: string;
  outPhaseDir: string;
  extension: ScriptExtension;
  caseInsensitive: boolean;
  generated: GeneratedScript[];
}): PhasePlan {
  const builtin = readFolderContents({
    dir: opts.builtinPhaseDir,
    extension: opts.extension,
    allowSentinel: true,
    strictExtension: true,
  });
  const custom = readFolderContents({
    dir: opts.customPhaseDir,
    extension: opts.extension,
    allowSentinel: false,
    strictExtension: false,
  });
  const generatedScripts: OrderedScript[] = opts.generated.map((g) => ({
    sourcePath: g.sourcePath,
    sourceName: `generated-${g.remainder}`,
    remainder: g.remainder,
    ext: g.ext,
    sentinel: false,
  }));
  const labeled: { script: OrderedScript; label: 'built-in' | 'custom' }[] = [
    ...builtin.scripts
      .filter((s) => !s.sentinel)
      .map((script) => ({ script, label: 'built-in' as const })),
    ...generatedScripts.map((script) => ({ script, label: 'built-in' as const })),
    ...custom.scripts.map((script) => ({ script, label: 'custom' as const })),
    ...builtin.scripts
      .filter((s) => s.sentinel)
      .map((script) => ({ script, label: 'built-in' as const })),
  ];
  // ... rest of the function (numbered, actions, items, collisions, return) is unchanged.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/weaveShares.test.ts`
Expected: PASS (new case, and every pre-existing case in the file — `generated` defaults to `[]` wherever the old call sites in this file's own other tests still call `planPhase`/`planAllPhases` without it, since `generatedPostScripts` is optional at the `planAllPhases` level and `phase === 'post-scripts' ? ... : []` supplies `[]` for `planPhase`'s now-required `generated` field)

- [ ] **Step 5: Commit**

```bash
git add src/weaveShares.ts tests/unit/weaveShares.test.ts
git commit -m "weaveShares: allow a generated script to be folded into post-scripts as built-in"
```

---

## Task 14: `commands/updateShares.ts` — generate and weave the MCP post-script

**Files:**

- Modify: `src/commands/updateShares.ts`
- Test: `tests/cli/updateShares.test.ts`

**Interfaces:**

- Consumes: `readMcpServers` (Task 2), `generateMcpPostScript` (Task 12), `GeneratedScript`/`planAllPhases` (Task 13).
- Produces: `update-shares` writes the generated MCP registration post-script into both VM shares' `post-scripts` when `mcp-servers.yaml` declares any servers.

- [ ] **Step 1: Write the failing test**

Open `tests/cli/updateShares.test.ts` to match its existing style (it runs the built CLI end-to-end against a temp environment and inspects the resulting `vm-shared-linux*/post-scripts` files), then add:

```ts
it('generates a re-runnable MCP registration post-script when mcp-servers.yaml declares servers', async () => {
  // Reuse the file's existing env-init fixture setup (init, generate-ca, etc.) from
  // its beforeEach/beforeAll, then:
  writeFileSync(
    join(envRoot, 'mcp-servers.yaml'),
    ['servers:', '  - name: filesystem', '    hostname: filesystem.internal', '    command: run-fs', ''].join(
      '\n',
    ),
  );

  await execa('node', [cliPath, 'update-shares'], { cwd: envParent });

  const shDir = join(envRoot, 'vm-shared-linux', 'post-scripts');
  const generatedName = readdirSync(shDir).find((f) => f.includes('mcp-servers'));
  expect(generatedName).toBeDefined();
  const content = readFileSync(join(shDir, generatedName!), 'utf8');
  expect(content).toContain('claude mcp add --scope user --transport http filesystem https://filesystem.internal');

  const ps1Dir = join(envRoot, 'vm-shared-windows', 'post-scripts');
  const generatedPs1Name = readdirSync(ps1Dir).find((f) => f.includes('mcp-servers'));
  expect(generatedPs1Name).toBeDefined();
});

it('emits no MCP post-script when mcp-servers.yaml is absent', async () => {
  // Same fixture setup as above, but without writing mcp-servers.yaml.
  await execa('node', [cliPath, 'update-shares'], { cwd: envParent });
  const shDir = join(envRoot, 'vm-shared-linux', 'post-scripts');
  expect(readdirSync(shDir).some((f) => f.includes('mcp-servers'))).toBe(false);
});
```

(Match imports/fixtures — `execa`, `cliPath`, `envRoot`/`envParent`, `readFileSync`/`readdirSync`/`writeFileSync`, `join` — to whatever this file already imports and however it already stages its temp environment; the two tests above assume `update-shares` has already been run once via `init`/`generate-ca` in the file's shared setup, same as its other cases.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.cli.config.ts tests/cli/updateShares.test.ts -t "mcp-servers"`
Expected: FAIL — no `*mcp-servers*` file appears in either `post-scripts` directory.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/updateShares.ts`, add imports:

```ts
import { mkdtempSync, writeFileSync as writeFileSyncFs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readMcpServers } from '../mcpServers';
import { generateMcpPostScript } from '../mcpPostScript';
import type { GeneratedScript } from '../weaveShares';
```

(Note: `writeFileSync` may already be imported from elsewhere in this file under a different name — check the existing import list and reuse it directly rather than aliasing, adjusting the alias above only if there's a genuine name collision.)

Right before the existing `let plans: PhasePlan[];` block, add:

```ts
      let mcpServers;
      try {
        mcpServers = readMcpServers(paths.mcpServers);
      } catch (error) {
        console.error(`update-shares: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      let generatedDir: string | null = null;
      let generatedPostScripts: GeneratedScript[] = [];
      if (mcpServers.length > 0) {
        generatedDir = mkdtempSync(join(tmpdir(), 'cfgm-mcp-postscript-'));
        const shPath = join(generatedDir, 'mcp-servers.sh');
        const ps1Path = join(generatedDir, 'mcp-servers.ps1');
        writeFileSyncFs(shPath, generateMcpPostScript(mcpServers, 'sh'));
        writeFileSyncFs(ps1Path, generateMcpPostScript(mcpServers, 'ps1'));
        generatedPostScripts = [
          { ext: 'sh', remainder: 'mcp-servers.sh', sourcePath: shPath },
          { ext: 'ps1', remainder: 'mcp-servers.ps1', sourcePath: ps1Path },
        ];
      }
```

The existing code after `mcpServers`/`generatedDir` (now inserted above it) has three points that can return before `executePlans` ever runs — the `planAllPhases` failure `catch`, the `options.dryRun` branch, and (implicitly) any exception `executePlans` itself throws — every one of which would leak `generatedDir` if cleanup were only added after a successful `executePlans` call. Wrap the whole remainder of the action in `try`/`finally` instead. Replace the existing block (`let plans: PhasePlan[]; try { plans = planAllPhases({ templatesDir: templatesDir(), paths }); } catch (error) { ...; return; } const homeJqPlans: PhasePlan[] = ...; if (options.dryRun) { ...; return; } executePlans([...plans, ...homeJqPlans]); console.log(...);`) with:

```ts
      try {
        let plans: PhasePlan[];
        try {
          plans = planAllPhases({ templatesDir: templatesDir(), paths, generatedPostScripts });
        } catch (error) {
          console.error(`update-shares: ${(error as Error).message}`);
          process.exitCode = 1;
          return;
        }

        const homeJqPlans: PhasePlan[] = paths.vmSharedTargets.map((target) => ({
          livePhaseDir: target.homeJqTransforms,
          actions: [{ kind: 'dir', src: paths.homeJqTransforms, destRel: '.' }],
        }));

        if (options.dryRun) {
          console.log('\nupdate-shares: dry run — no files copied.');
          return;
        }

        executePlans([...plans, ...homeJqPlans]);
        console.log(
          'update-shares: rewove pre/post scripts and refreshed home-jq-transforms in both shares',
        );
      } finally {
        if (generatedDir) rmSync(generatedDir, { recursive: true, force: true });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.cli.config.ts tests/cli/updateShares.test.ts`
Expected: PASS (new cases and every pre-existing case in the file)

- [ ] **Step 5: Commit**

```bash
git add src/commands/updateShares.ts tests/cli/updateShares.test.ts
git commit -m "update-shares: generate and weave the MCP guest registration post-script"
```

---

## Task 15: Proxy-stack integration test — real Envoy reaches a host-loopback MCP server

**Files:**

- Create: `tests/proxy-stack/mcpServer.test.ts`, `tests/fixtures/mcpFakeServer.mjs`
- Test: itself (this task *is* the test)

**Interfaces:**

- Consumes: the built CLI (`dist/cli.js`), the real `run-proxy`/`init`/`generate-ca` commands, `killProcessTree` (pre-existing).

- [ ] **Step 1: Add a fixture MCP server script**

`spawnMcpServer` runs commands through a shell; a single-line `node -e "..."` command with embedded double quotes is fragile to quote cross-platform (Windows `cmd.exe` shell-quoting is unforgiving). Instead, follow the existing `tests/fixtures/processTree/parent.mjs` convention: a real fixture script, invoked with a plain argv, no embedded quoting needed. Create `tests/fixtures/mcpFakeServer.mjs`:

```js
import { createServer } from 'node:http';

const [, , ip, port] = process.argv;

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`mcp ok:${req.url}`);
}).listen(Number(port), ip);
```

- [ ] **Step 2: Write the test**

Model this closely on `tests/proxy-stack/codexInjection.test.ts` (same `beforeAll`/`afterAll` shape: `init`, write `allowlist.txt` and `mcp-servers.yaml`, `generate-ca`, spawn `run-proxy` for real, wait for its "serving" log line). Unlike that suite, the "MCP server" here is a real child process `run-proxy` itself spawns (via `mcp-servers.yaml`, using the fixture from Step 1 with `{ip}`/`{port}` placeholders) — not something the test spawns or manages directly, and not something reached via `--upstream-override`, since `buildMcpEntry` (Task 4) has no override support and doesn't need any: this is the real, non-overridden path.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { envParent, envRoot } from '../testEnvRoot';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const fakeMcpScript = fileURLToPath(new URL('../fixtures/mcpFakeServer.mjs', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

// Distinct from the other proxy-stack suites' ports.
const HTTPS_PORT = 18450;
const HTTP_PORT = 18187;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

let tempDir: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];
let caCertPem: string;

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for '${needle}'\n${stdoutLines.join('\n')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(servername: string, path: string): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-stack-'));
  // Written BEFORE run-proxy is spawned: run-proxy reads credentials synchronously
  // at startup and fails fast if they're missing, so this must not race the spawn.
  writeFileSync(
    join(tempDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 86400000 } }),
  );
  writeFileSync(
    join(tempDir, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: null, tokens: null, auth_mode: 'chatgpt' }),
  );

  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  writeFileSync(join(proxyDir, 'allowlist.txt'), '');
  writeFileSync(
    join(envRoot, 'mcp-servers.yaml'),
    [
      'servers:',
      '  - name: faketool',
      '    hostname: faketool.internal',
      `    command: node ${fakeMcpScript} {ip} {port}`,
      '',
    ].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      join(tempDir, '.credentials.json'),
      '--codex-credentials',
      join(tempDir, 'auth.json'),
    ],
    { cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }
  await waitForLine('serving the current token', 60000);
  // Confirms the fixture server actually came up and passed its readiness probe —
  // not just that run-proxy itself started.
  await waitForLine('[faketool] ready in', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 120000);

afterAll(async () => {
  // run-proxy's own SIGINT shutdown kills the faketool child it spawned (Task 10);
  // no separate cleanup of that process is needed here.
  if (proxyProc?.pid !== undefined) await killProcessTree(proxyProc.pid, 'SIGINT');
  try {
    await proxyProc;
  } catch {
    /* ignore */
  }
  await execa('docker', ['compose', 'down'], { cwd: proxyDir, env: { ...process.env, ...envoyEnv }, reject: false });
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('host-run MCP server, reached through the proxy on loopback', () => {
  it('reaches the spawned host-loopback server in cleartext via host.docker.internal', async () => {
    const { statusCode, body } = await requestThrough('faketool.internal', '/mcp-tool-call');
    expect(statusCode).toBe(200);
    expect(body).toBe('mcp ok:/mcp-tool-call');
  });

  it('logs the request with the ALLOW MCP tag', async () => {
    const before = stdoutLines.length;
    await requestThrough('faketool.internal', '/another-call');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !stdoutLines.slice(before).some((l) => l.includes('ALLOW MCP'))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      stdoutLines.slice(before).some((l) => l.includes('ALLOW MCP') && l.includes('faketool.internal')),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run --config vitest.proxy-stack.config.ts tests/proxy-stack/mcpServer.test.ts`
Expected: PASS. This proves, end to end: `run-proxy` allocates a port and substitutes it into the fixture's `{ip}`/`{port}` command; the fixture binds `127.0.0.1` only; the readiness probe (Task 9) confirms it; Envoy's cleartext MCP filter chain (Task 4) routes a real HTTPS request through `host.docker.internal` to that `127.0.0.1`-only listener; and the access log emits the `ALLOW MCP` tag (Task 6) via `runProxyLoop`'s own formatted console output — not the raw `CFGM|mcp|` line, which is parsed and reformatted before it ever reaches stdout.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/mcpFakeServer.mjs tests/proxy-stack/mcpServer.test.ts
git commit -m "proxy-stack: verify Envoy routes a real request to a host-run MCP server in cleartext"
```

---

## Self-Review

**Spec coverage:**

- `mcp-servers.yaml` schema/validation → Task 2. ✓
- MCP/allowlist collision resolution, MCP wins → Task 3. ✓
- Envoy destination kind (cleartext, no auth, `host.docker.internal`, `ALLOW MCP` tag) → Tasks 4, 6. ✓
- SAN integration → Task 10 (`applyAllowlist` change). ✓
- Port allocation → Task 7. ✓
- Parallel launch, readiness probe, exit listener, fatal-once → Task 9. ✓
- Envoy bring-up not gated on MCP readiness → Task 10 (explicit test). ✓
- MCP-triggered fatal stops both Envoy colors → Task 10 (explicit test). ✓
- Console line prefixing → Task 10 (`onLine` wiring to `deps.log`). ✓
- Shutdown kills MCP processes on every path → Task 10 (`shutdown()` change + SIGINT test). ✓
- No live watching of `mcp-servers.yaml` → Task 10 (config is read once in `start()`, no watcher registered). ✓
- `update-shares` post-script generation, `--scope user`, no scope for codex → Task 12. ✓
- Weaving the generated script as a built-in → Task 13. ✓
- CLI wiring for both commands → Tasks 11, 14. ✓
- Proxy-stack integration proving `host.docker.internal` reachability → Task 15. ✓
- `{ip}`/`{port}` command substitution → Task 10 (explicit test; the earlier tasks intentionally carry the raw `command` string unchanged, since substitution needs the assigned port, which isn't known until Task 10's `start()`).
- Known limitations (unverified loopback bind, no auto-removal on rename/delete) → intentionally not implemented; called out in the spec, not re-litigated here.

**Placeholder scan:** every step above shows real, complete code — no `TBD`/`implement later`/prose-only steps.

**Type consistency check:** `McpServerConfig` (Task 2) flows unchanged into `resolveMcpAllowlistCollisions` (Task 3), `runProxyLoop`'s `RunProxyConfig.mcpServers` (Task 10), `readMcpServers`'s return type (Task 2/11/14), and `generateMcpPostScript` (Task 12) — one shape throughout, no renamed fields. `McpServerUpstream { hostname, port }` (Task 4) flows unchanged into `buildConfig.ts` (Task 5) and `RunProxyDeps.buildConfig`/`mcpServersWithPorts` (Task 10). `McpServerSpec { name, hostname, port, command, cwd, env }` (Task 9) matches the object built in Task 10's `mcpSpecs` mapping (command already substituted) and the `spec` parameter destructured in Task 8's `spawnMcpServer` wiring in Task 11.

**Peer review round 2 (applied inline above):** a peer review of the first draft found several real defects, all fixed in place: `{ip}`/`{port}` substitution was entirely missing from the command-building code (now in Task 10); `spawnMcpServer` omitted `detached: process.platform !== 'win32'`, so `killProcessTree`'s process-group signal couldn't reach a shell-wrapped MCP server's descendants on non-Windows (fixed in Task 8); `mcpFatal` had a race where a concurrent SIGINT could resolve with a clean exit 0 before the async color-stopping finished, silently losing the fatal (fixed by reserving `settled` synchronously inside `shutdown()`, with a new race-condition test in Task 10); Task 9's readiness test asserted synchronously before the probe's `.then()` microtask ran and had a broken `now()` mock sequence (both fixed); Task 15's original integration test was unbuildable — its command exited immediately (triggering the very fatal path Task 9 implements), relied on `--upstream-override` support `buildMcpEntry` doesn't have, wrote credentials after spawning `run-proxy` (a startup race), and asserted on a raw `CFGM|mcp|` log line `runProxyLoop` never emits verbatim (it reformats to `ALLOW MCP`) — replaced with a real long-running fixture script substituted into a real `{ip}`/`{port}` command, no override needed, correct credential-write ordering, and an assertion on the actual formatted output. Task 5 and Task 14's test snippets were also corrected to match the real shape of `proxyConfigWriting.test.ts` and `tests/cli/updateShares.test.ts` (verified by reading both files directly rather than assumed). One item was intentionally left as a documented follow-up rather than fully engineered: the top-level `uncaughtException`/`unhandledRejection` safety net in `commands/runProxy.ts` calls `process.exit()` directly and does not run `runProxyLoop`'s MCP-process cleanup — this matches the existing convention (that same safety net doesn't stop the Envoy container either), so it's noted as an intentional scope boundary in Task 10 rather than a gap to close.

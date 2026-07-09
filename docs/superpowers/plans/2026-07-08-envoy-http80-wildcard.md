# Port-80 Wildcard Allowlist Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `**.host`/`*.host` wildcard entries on port 80 actually work (they currently 403 because the generated Envoy virtual-host domain and cluster upstream both use the literal, unresolvable wildcard string), and make malformed wildcard syntax fail loudly at generation time instead of silently producing broken or incomplete config.

**Architecture:** `parseAllowlist` (`src/allowlist.ts`) becomes the single point that turns raw allowlist text into a clean, generation-ready `Allowlist`: it now also validates wildcard shape (flagging entries like `crl*.digicert.com` as `invalid`), normalizes `**.host` to Envoy's native `*.host`, and prunes exact entries made redundant by a same-port wildcard (e.g. drops `archive.ubuntu.com:80` when `*.ubuntu.com:80` is present). `build-envoy-config` (`src/commands/buildEnvoyConfig.ts`) rejects any `invalid` entries before generating anything. `generateEnvoyConfig` (`src/envoyConfig.ts`) trusts its input is already valid/normalized/pruned, and gains a shared `envoy.filters.http.dynamic_forward_proxy` HTTP filter + `dynamic_forward_proxy_cluster_http` cluster (mirroring the existing port-443 SNI dynamic-forward-proxy pattern) so wildcard `:80` hosts resolve dynamically instead of needing a static per-host DNS entry.

**Tech Stack:** TypeScript, Vitest (unit/e2e/integration configs), commander CLI, Envoy 1.31 config generation (YAML via the `yaml` package), Docker Compose for integration tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-08-envoy-http80-wildcard-design.md` — read it before starting; this plan implements it exactly.
- Wildcard host shape: valid iff it matches `/^\*{1,2}\.[^*]+$/` (a single leading `**.` or `*.` followed by a non-wildcard remainder). Anything else containing `*` is invalid.
- `terminate` entries may never contain `*`, valid shape or not.
- Pruning and normalization happen in-memory only inside `parseAllowlist` — never rewrite `allowlist.txt`/`current-allow-list.txt` on disk.
- Pruning/normalization are silent (no console output); only `invalid` entries are ever reported, and only by the CLI layer (`buildEnvoyConfig.ts`), not by `parseAllowlist` itself.
- New shared port-80 wildcard cluster/cache/filter are added to generated config only when the allowlist has at least one wildcard `:80` entry.

---

## Task 1: Add `invalid` field and wildcard-shape validation to `parseAllowlist`

**Files:**
- Modify: `src/allowlist.ts`
- Modify: `src/policyFile.ts`
- Test: `tests/unit/allowlist.test.ts`
- Test: `tests/unit/policyFile.test.ts`
- Modify (compile fix only, no behavior change): `tests/unit/envoyConfig.test.ts:5-8`

**Interfaces:**
- Produces: `Allowlist` interface now has `invalid: string[]` alongside existing `passthrough: string[]` and `terminate: string[]`. Every later task and every existing consumer of `Allowlist` relies on this shape.
- Produces: `parseAllowlist(content: string): Allowlist` — same signature, now also returns `invalid` (deduped raw `host:port` lines that have unsupported wildcard syntax, or any `*` at all in the `terminate` section).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/allowlist.test.ts`, inside the existing `describe('parseAllowlist', ...)` block (after the last `it`):

```ts
  it('flags a mid-string wildcard as invalid instead of treating it as passthrough', () => {
    const content = [
      '# passthrough',
      'crl*.digicert.com:80',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['crl*.digicert.com:80'],
    });
  });

  it('flags any wildcard in the terminate section as invalid, valid shape or not', () => {
    const content = [
      '# passthrough',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      '**.anthropic.com:443',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['**.anthropic.com:443'],
    });
  });

  it('dedupes repeated invalid entries', () => {
    const content = [
      '# passthrough',
      'crl*.digicert.com:80',
      'crl*.digicert.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      terminate: ['api.anthropic.com:443'],
      invalid: ['crl*.digicert.com:80'],
    });
  });
```

Update the four existing assertions in the same file that construct or expect an `Allowlist` shape to include `invalid: []` (no invalid entries in any of these fixtures):

```ts
// 'writes sorted passthrough and terminate sections' — the `allowlist` literal:
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };
```

```ts
// 'splits entries into passthrough and terminate by section header':
    expect(parseAllowlist(content)).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
```

```ts
// 'round-trips through formatAllowlist' — both the `allowlist` literal and the expectation:
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };

    expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
```

```ts
// 'drops an exact-duplicate line within a section, keeping first-occurrence order':
    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
```

```ts
// 'keeps the same host in both passthrough and terminate independently':
    expect(parseAllowlist(content)).toEqual({
      passthrough: ['shared.example.com:443'],
      terminate: ['shared.example.com:443'],
      invalid: [],
    });
```

Update `tests/unit/policyFile.test.ts`'s two `toEqual` assertions:

```ts
    expect(parsePolicyFile(content)).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
```

```ts
    expect(parsePolicyFile(content)).toEqual({ passthrough: [], terminate: [], invalid: [] });
```

Update the `Allowlist` literal at the top of `tests/unit/envoyConfig.test.ts` (compile fix only — `generateEnvoyConfig` doesn't use `invalid` yet, but the type now requires it):

```ts
const allowlist: Allowlist = {
  passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
  terminate: ['api.anthropic.com:443'],
  invalid: [],
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `tests/unit/allowlist.test.ts` and `tests/unit/policyFile.test.ts` fail (missing `invalid` field / new cases not implemented); `tsc`/vitest may also report type errors from the `envoyConfig.test.ts` and `policyFile.ts` mismatch until Step 3 lands.

- [ ] **Step 3: Implement `invalid` field and validation**

Replace the top of `src/allowlist.ts` (interface + `parseAllowlist`) with:

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  invalid: string[];
}

const WILDCARD_HOST_PATTERN = /^\*{1,2}\.[^*]+$/;

function splitHostPort(entry: string): { host: string; port: string } {
  const idx = entry.lastIndexOf(':');
  return { host: entry.slice(0, idx), port: entry.slice(idx + 1) };
}

export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  const invalid = new Set<string>();
  let section: 'passthrough' | 'terminate' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '# passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '# terminate') {
      section = 'terminate';
      continue;
    }
    if (line.startsWith('#')) continue;
    if (section === null) continue;

    const { host } = splitHostPort(line);
    const hasWildcard = host.includes('*');

    if (hasWildcard && (section === 'terminate' || !WILDCARD_HOST_PATTERN.test(host))) {
      invalid.add(line);
      continue;
    }

    if (section === 'passthrough') passthrough.add(line);
    else terminate.add(line);
  }

  return { passthrough: [...passthrough], terminate: [...terminate], invalid: [...invalid] };
}
```

Leave `formatAllowlist` unchanged (it doesn't reference `invalid`, and structural typing means the extra field on any `Allowlist` value passed to it is fine).

In `src/policyFile.ts`, update the return statement of `parsePolicyFile`:

```ts
  return {
    passthrough: [...passthrough].sort(),
    terminate: [...terminate].sort(),
    invalid: [],
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts src/policyFile.ts tests/unit/allowlist.test.ts tests/unit/policyFile.test.ts tests/unit/envoyConfig.test.ts
git commit -m "feat: flag malformed wildcard allowlist entries as invalid"
```

---

## Task 2: Normalize `**.host` to `*.host` in `parseAllowlist`

**Files:**
- Modify: `src/allowlist.ts`
- Test: `tests/unit/allowlist.test.ts`

**Interfaces:**
- Consumes: `WILDCARD_HOST_PATTERN`, `splitHostPort` from Task 1.
- Produces: every valid wildcard entry returned by `parseAllowlist` is now in `*.host:port` form, never `**.host:port`. `**.` and `*.` forms of the same host+port collapse into a single entry.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/allowlist.test.ts`, inside `describe('parseAllowlist', ...)`:

```ts
  it('normalizes **.host to Envoy-native *.host', () => {
    const content = [
      '# passthrough',
      '**.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('collapses **.host and *.host for the same host:port into one normalized entry', () => {
    const content = [
      '# passthrough',
      '**.ubuntu.com:80',
      '*.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });
```

Update the "round-trips through formatAllowlist" test's final expectation (the input still writes `**.chatgpt.com:443`, but parsing it back now normalizes):

```ts
    expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — the two new tests fail (`**.ubuntu.com:80` still present verbatim instead of normalized), and the round-trip test's updated expectation fails against the not-yet-changed implementation.

- [ ] **Step 3: Implement normalization**

In `src/allowlist.ts`, add a helper and use it when adding a passthrough/terminate entry:

```ts
function normalizeWildcardHost(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}
```

Update the body of the loop in `parseAllowlist` where valid entries are added (replace the final `if (section === 'passthrough') ...` block):

```ts
    const entry = hasWildcard ? `${normalizeWildcardHost(host)}:${splitHostPort(line).port}` : line;
    if (section === 'passthrough') passthrough.add(entry);
    else terminate.add(entry);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts
git commit -m "feat: normalize **.host wildcard entries to Envoy-native *.host"
```

---

## Task 3: Prune wildcard-covered exact entries in `parseAllowlist`

**Files:**
- Modify: `src/allowlist.ts`
- Test: `tests/unit/allowlist.test.ts`

**Interfaces:**
- Consumes: normalized `*.host` entries from Task 2.
- Produces: `parseAllowlist`'s returned `passthrough` never contains an exact entry that's a strict subdomain of a same-port wildcard entry also in `passthrough`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/allowlist.test.ts`, inside `describe('parseAllowlist', ...)`:

```ts
  it('prunes an exact passthrough entry covered by a same-port wildcard', () => {
    const content = [
      '# passthrough',
      '**.ubuntu.com:80',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('does not prune an exact entry at a different port than the wildcard', () => {
    const content = [
      '# passthrough',
      '**.ubuntu.com:80',
      'archive.ubuntu.com:443',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80', 'archive.ubuntu.com:443'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('does not prune the wildcard\'s own bare base domain, since it is not a subdomain', () => {
    const content = [
      '# passthrough',
      '**.ubuntu.com:80',
      'ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80', 'ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('does not prune a terminate entry covered by a passthrough wildcard', () => {
    const content = [
      '# passthrough',
      '**.ubuntu.com:80',
      '',
      '# terminate',
      'archive.ubuntu.com:80',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['archive.ubuntu.com:80'],
      invalid: [],
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `archive.ubuntu.com:80` is still present in `passthrough` in the first test (no pruning implemented yet). The other three tests pass already (they assert *no* pruning happens), which is fine — Step 2 just needs to confirm the pruning test fails before Step 3.

- [ ] **Step 3: Implement pruning**

In `src/allowlist.ts`, add a pruning helper and call it before returning from `parseAllowlist`:

```ts
function prunePassthrough(entries: string[]): string[] {
  const wildcardSuffixesByPort = new Map<string, string[]>();
  for (const entry of entries) {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) {
      const suffixes = wildcardSuffixesByPort.get(port) ?? [];
      suffixes.push(host.slice(1)); // "*.ubuntu.com" -> ".ubuntu.com"
      wildcardSuffixesByPort.set(port, suffixes);
    }
  }

  return entries.filter((entry) => {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) return true;
    const suffixes = wildcardSuffixesByPort.get(port);
    return !suffixes?.some((suffix) => host.endsWith(suffix));
  });
}
```

Update the `return` statement at the end of `parseAllowlist`:

```ts
  return {
    passthrough: prunePassthrough([...passthrough]),
    terminate: [...terminate],
    invalid: [...invalid],
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts
git commit -m "feat: prune passthrough entries made redundant by a same-port wildcard"
```

---

## Task 4: Reject invalid allowlist entries in `build-envoy-config`

**Files:**
- Modify: `src/commands/buildEnvoyConfig.ts`
- Create: `tests/fixtures/invalid-allowlist.txt`
- Test: `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `allowlist.invalid` from `parseAllowlist` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures/invalid-allowlist.txt`:

```
# passthrough
crl*.digicert.com:80

# terminate
api.anthropic.com:443
```

Add to `tests/e2e/cli.test.ts`, inside `describe('configamatron CLI', ...)` (after the `'generates envoy.yaml into the environment by default with build-envoy-config'` test):

```ts
  it('build-envoy-config rejects an allowlist with unsupported wildcard syntax', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/invalid-allowlist.txt', import.meta.url));

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'build-envoy-config', fixturePath],
        { cwd: dir, reject: false },
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain('crl*.digicert.com:80');
      expect(existsSync(join(dir, '.configamatron', 'proxy', 'envoy.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm test:e2e`
Expected: FAIL — `build-envoy-config` currently exits 0 and writes `envoy.yaml` even though the input contains `crl*.digicert.com:80` (it's silently treated as a literal, unmatchable host today).

- [ ] **Step 3: Implement the CLI check**

In `src/commands/buildEnvoyConfig.ts`, insert a check right after `const allowlist = parseAllowlist(content);` and before building the config:

```ts
        const content = readFileSync(inputPath, 'utf8');
        const allowlist = parseAllowlist(content);
        if (allowlist.invalid.length > 0) {
          console.error(
            `build-envoy-config: unsupported wildcard syntax in ${inputPath}:\n` +
              allowlist.invalid.map((entry) => `  - ${entry}`).join('\n'),
          );
          process.exitCode = 1;
          return;
        }
        const config = generateEnvoyConfig(allowlist, { overrides: options.upstreamOverride });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm test:e2e`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/buildEnvoyConfig.ts tests/fixtures/invalid-allowlist.txt tests/e2e/cli.test.ts
git commit -m "feat: build-envoy-config fails cleanly on unsupported wildcard syntax"
```

---

## Task 5: Remove `toEnvoyWildcard`, trust pre-normalized wildcard input in `envoyConfig.ts`

**Files:**
- Modify: `src/envoyConfig.ts:16-18` (delete `toEnvoyWildcard`), `src/envoyConfig.ts:207-209` (`passthroughServerNames`)
- Modify: `tests/unit/envoyConfig.test.ts:5-8`

**Interfaces:**
- Consumes: `Allowlist.passthrough` entries are already normalized to `*.host` form (Task 2) by the time `generateEnvoyConfig` sees them.
- No change to `generateEnvoyConfig`'s exported signature.

- [ ] **Step 1: Update the test fixture (no new test — this is a refactor with existing coverage)**

In `tests/unit/envoyConfig.test.ts`, change the module-level fixture from `**.chatgpt.com:443` to the already-normalized `*.chatgpt.com:443` (the existing tests already assert the *output* server name is `*.chatgpt.com` — this only changes what form the *input* is given in, since `generateEnvoyConfig` will no longer perform the conversion itself):

```ts
const allowlist: Allowlist = {
  passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
  terminate: ['api.anthropic.com:443'],
  invalid: [],
};
```

- [ ] **Step 2: Run tests to verify they still pass with the old implementation**

Run: `pnpm test:unit`
Expected: PASS — `toEnvoyWildcard('*.chatgpt.com:443'.split(':')[0])` is a no-op today for input that doesn't start with `**.`, so existing assertions (which check the *output* is `*.chatgpt.com`) are unaffected by this fixture change alone. This step just confirms the fixture edit itself introduced no regression before we touch the implementation.

- [ ] **Step 3: Remove `toEnvoyWildcard` and simplify `passthroughServerNames`**

In `src/envoyConfig.ts`, delete the `toEnvoyWildcard` function (lines 16-18):

```ts
function toEnvoyWildcard(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}
```

Replace the `passthroughServerNames` line inside `generateEnvoyConfig`:

```ts
  const passthroughServerNames = allowlist.passthrough
    .filter((e) => e.endsWith(':443'))
    .map((e) => e.split(':')[0]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "refactor: drop toEnvoyWildcard now that parseAllowlist normalizes wildcards"
```

---

## Task 6: Route wildcard `:80` hosts through a shared dynamic-forward-proxy cluster

**Files:**
- Modify: `src/envoyConfig.ts` (inside `generateEnvoyConfig`, and new helper functions)
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**
- Consumes: `Allowlist.passthrough` entries at `:80`, already normalized (`*.host:80`) and pruned (Tasks 2-3) by the time they reach here.
- Produces: when at least one wildcard `:80` entry is present, listener_80 gains virtual host `http_wildcard` (domains = every wildcard `:80` host, routed to cluster `dynamic_forward_proxy_cluster_http`), listener_80's HTTP connection manager gains the `envoy.filters.http.dynamic_forward_proxy` filter (before `envoy.filters.http.router`), and `static_resources.clusters` gains cluster `dynamic_forward_proxy_cluster_http` (DNS cache name `dynamic_forward_proxy_cache_config_http`). None of these three are present when there are no wildcard `:80` entries.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/envoyConfig.test.ts`, inside `describe('generateEnvoyConfig', ...)`:

```ts
  it('routes wildcard :80 hosts through a shared dynamic_forward_proxy_cluster_http', () => {
    const wildcardAllowlist: Allowlist = {
      passthrough: ['*.ubuntu.com:80', 'security.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    };
    const config = generateEnvoyConfig(wildcardAllowlist) as any;
    const listener80 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_80',
    );
    const hcm = listener80.filter_chains[0].filters[0].typed_config;
    const vhosts = hcm.route_config.virtual_hosts;

    const wildcardVhost = vhosts.find((v: any) => v.domains.includes('*.ubuntu.com'));
    expect(wildcardVhost.routes[0].route.cluster).toBe('dynamic_forward_proxy_cluster_http');

    const exactVhost = vhosts.find((v: any) => v.domains.includes('security.ubuntu.com'));
    expect(exactVhost.routes[0].route.cluster).toBe('cluster_http_security_ubuntu_com');

    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.dynamic_forward_proxy',
      'envoy.filters.http.router',
    ]);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'dynamic_forward_proxy_cluster_http',
    );
    expect(cluster.lb_policy).toBe('CLUSTER_PROVIDED');
    expect(cluster.cluster_type.name).toBe('envoy.clusters.dynamic_forward_proxy');
    expect(cluster.cluster_type.typed_config.dns_cache_config.name).toBe(
      'dynamic_forward_proxy_cache_config_http',
    );
  });

  it('omits the shared http dynamic_forward_proxy cluster and filter when there are no wildcard :80 entries', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener80 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_80',
    );
    const hcm = listener80.filter_chains[0].filters[0].typed_config;

    expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);
    expect(
      config.static_resources.clusters.find(
        (c: any) => c.name === 'dynamic_forward_proxy_cluster_http',
      ),
    ).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `*.ubuntu.com:80` today goes through `buildHttp80Entry` unchanged, producing a virtual host with `domains: ['*.ubuntu.com']` routed to a static `cluster_http__ubuntu_com`-style cluster (not `dynamic_forward_proxy_cluster_http`), and no `dynamic_forward_proxy` HTTP filter exists at all.

- [ ] **Step 3: Implement the shared wildcard cluster/filter**

In `src/envoyConfig.ts`, add these helpers near `buildHttp80Entry`:

```ts
const DYNAMIC_FORWARD_PROXY_HTTP_CACHE = 'dynamic_forward_proxy_cache_config_http';

function buildWildcardHttp80VirtualHost(hosts: string[]) {
  return {
    name: 'http_wildcard',
    domains: hosts,
    routes: [
      { match: { prefix: '/' }, route: { cluster: 'dynamic_forward_proxy_cluster_http' } },
    ],
  };
}

function buildDynamicForwardProxyHttpCluster() {
  return {
    name: 'dynamic_forward_proxy_cluster_http',
    lb_policy: 'CLUSTER_PROVIDED',
    cluster_type: {
      name: 'envoy.clusters.dynamic_forward_proxy',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig',
        dns_cache_config: {
          name: DYNAMIC_FORWARD_PROXY_HTTP_CACHE,
          dns_lookup_family: 'V4_ONLY',
        },
      },
    },
  };
}

function buildDynamicForwardProxyHttpFilter() {
  return {
    name: 'envoy.filters.http.dynamic_forward_proxy',
    typed_config: {
      '@type':
        'type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig',
      dns_cache_config: {
        name: DYNAMIC_FORWARD_PROXY_HTTP_CACHE,
        dns_lookup_family: 'V4_ONLY',
      },
    },
  };
}
```

Inside `generateEnvoyConfig`, replace the single `http80Built` line with a split between exact and wildcard `:80` entries:

```ts
  const http80Entries = allowlist.passthrough.filter((e) => e.endsWith(':80'));
  const http80ExactBuilt = http80Entries.filter((e) => !e.startsWith('*.')).map(buildHttp80Entry);
  const http80WildcardHosts = http80Entries
    .filter((e) => e.startsWith('*.'))
    .map((e) => e.split(':')[0]);
  const hasWildcardHttp80 = http80WildcardHosts.length > 0;
```

Update the `listener_80` virtual hosts array (replace `...http80Built.map((b) => b.virtualHost),` in the `route_config.virtual_hosts` array):

```ts
                      virtual_hosts: [
                        ...http80ExactBuilt.map((b) => b.virtualHost),
                        ...(hasWildcardHttp80
                          ? [buildWildcardHttp80VirtualHost(http80WildcardHosts)]
                          : []),
                        {
                          name: 'default_deny',
```

Update the `listener_80` HTTP connection manager's `http_filters` array:

```ts
                    http_filters: [
                      ...(hasWildcardHttp80 ? [buildDynamicForwardProxyHttpFilter()] : []),
                      {
                        name: 'envoy.filters.http.router',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                        },
                      },
                    ],
```

Update `static_resources.clusters` (replace `...http80Built.map((b) => b.cluster),`):

```ts
      clusters: [
        ...terminateBuilt.map((b) => b.cluster),
        ...http80ExactBuilt.map((b) => b.cluster),
        ...(hasWildcardHttp80 ? [buildDynamicForwardProxyHttpCluster()] : []),
        {
          name: 'blackhole',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat: resolve wildcard :80 hosts via a shared dynamic_forward_proxy cluster"
```

---

## Task 7: Prove the fix end-to-end against a real wildcard subdomain

**Files:**
- Modify: `tests/integration/fixtures/allowlist.txt`
- Test: `tests/integration/proxy.test.ts`

**Interfaces:**
- Consumes: the full Envoy stack brought up by `startProxyStack()` (`tests/proxyStack.ts`), unchanged by this task.

- [ ] **Step 1: Update the integration fixture**

In `tests/integration/fixtures/allowlist.txt`, add a wildcard `:80` entry and an exact entry it doesn't cover (proves the exact/wildcard split from Task 6 works against the real CLI + Envoy, not just the unit-tested config object):

```
# passthrough
pypi.org:443
archive.ubuntu.com:80
**.ubuntu.com:80

# terminate
api.anthropic.com:443
```

- [ ] **Step 2: Write the failing test**

Add to `tests/integration/proxy.test.ts`, inside `describe('Envoy sandbox proxy stack', ...)` (after the `'allows a real, allow-listed Host header on port 80'` test):

```ts
  it('allows a wildcard-covered Host header on port 80 that was never explicitly listed', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: HTTP_PORT,
          path: '/',
          headers: { host: 'connectivity-check.ubuntu.com' },
        },
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
```

- [ ] **Step 3: Run the test**

By this point Tasks 1-6 have already implemented the fix, so this is not a red/green TDD step — it's an end-to-end check that the real Docker/Envoy stack behaves the way the unit tests (Task 6) predicted, using a live public subdomain that was never explicitly enumerated in the allowlist.

Run: `pnpm build && pnpm test:integration`
Expected: PASS — `connectivity-check.ubuntu.com` resolves via `dynamic_forward_proxy_cluster_http` and gets a real response (status < 400). `archive.ubuntu.com:80`'s existing test also still passes, proving the exact entry works correctly even though it's pruned from generated config in favor of `**.ubuntu.com:80`'s dynamic path covering it instead.

If this step fails, that means the unit-level modeling in Task 6 diverged from Envoy's actual runtime behavior — stop and re-examine Task 6 rather than patching around it here.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/fixtures/allowlist.txt tests/integration/proxy.test.ts
git commit -m "test: prove wildcard :80 allowlist entries resolve real subdomains end-to-end"
```

---

## Final Verification

- [ ] Run the full pipeline: `pnpm test` (format, lint, typecheck, unit, build, e2e, integration — requires Docker running for the integration stage).
- [ ] Confirm `git log --oneline -7` shows the seven commits from this plan in order.

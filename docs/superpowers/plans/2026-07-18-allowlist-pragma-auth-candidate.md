# Allowlist Pragma Commands + Auth-Candidate Logging Implementation Plan

**Goal:** Replace the allowlist file's bare `#`-comment section headers with an explicit `#pragma` syntax, and add a new `#pragma auth candidate` section whose hosts are TLS-terminated (no credential injection, no leak gate) so the proxy can log a short prefix of the client's real auth headers.

**Architecture:** The allowlist parser (`src/allowlist.ts`) is the single source of truth: it recognizes three `#pragma` section headers, throws on unknown/legacy headers, and returns a new required `authCandidate` field. `src/envoyConfig.ts` grows a parallel filter-chain/cluster builder for auth-candidate hosts that omits the lua gate and credential injector and adds an access log carrying five auth-header prefixes truncated to 12 chars *in the Envoy config*. The run-proxy log pipeline (`src/runProxy/*`) parses the new `cand` log line into one entry per present header and renders it inline.

**Tech Stack:** TypeScript (ESM), Node.js, `commander` (CLI), `yaml` (Envoy config render), Envoy (proxy, run in Docker), Vitest (unit/e2e/integration), pnpm.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- The three recognized pragma commands, matched against the **exact trimmed line**, are `#pragma passthrough`, `#pragma claude authenticated`, `#pragma auth candidate`. A line starting with `#pragma ` (trailing space) that is none of these throws `Error`. The exact legacy lines `# passthrough` and `# terminate` also throw, with a migration hint.
- The in-memory field name stays `terminate` (only the on-disk pragma text changes). The new field is `authCandidate`.
- `authCandidate` follows the same validation as `terminate`: no wildcards, and only `:443` entries reach the TLS-termination path.
- A host present in **both** `terminate` and `authCandidate` is removed from both and added to `invalid[]` (would otherwise be a duplicate-SNI Envoy config error).
- `terminateTlsHosts` returns `:443` hosts from **both** `terminate` and `authCandidate`.
- Auth-candidate Envoy names: cluster `cluster_authcandidate_<sanitized-host>`, `stat_prefix: authcandidate_<sanitized-host>`. Access-log `pathId` is `cand`.
- The auth-candidate access log truncates each header to a **12-character prefix** via Envoy's `%REQ(HEADER):12%` syntax. The five headers, in this order, are: `AUTHORIZATION`, `COOKIE`, `X-API-KEY`, `X-AUTH-TOKEN`, `PROXY-AUTHORIZATION`. Display names (for log output) are `Authorization`, `Cookie`, `X-API-Key`, `X-Auth-Token`, `Proxy-Authorization`, same order.
- A `cand` log line has exactly 11 pipe-delimited fields; all other pathIds have exactly 6. A wrong field count returns `null`.
- The auth-candidate filter chain's `http_filters` is exactly `[envoy.filters.http.router]` — no lua gate, no credential injector.
- Test commands: single unit file `pnpm exec vitest run <path>`; all unit `pnpm test:unit`; typecheck `pnpm typecheck`; build `pnpm build`; e2e `pnpm test:e2e` (needs `pnpm build` first); integration `pnpm test:integration` (needs `pnpm build` first and Docker).

---

## File Structure

**Modified — source:**

- `src/allowlist.ts` — pragma parsing, legacy/unknown throw, `authCandidate` field, cross-section conflict guard, `formatAllowlist` sections, `terminateTlsHosts`.
- `src/policyFile.ts` — return `authCandidate: []` (never populated from policy files).
- `src/envoyConfig.ts` — `buildAuthCandidateEntry`, `authCandidateAccessLog`, shared `buildTlsUpstreamCluster`, splice into `generateEnvoyConfig`.
- `src/runProxy/parseLine.ts` — `'cand'` pathId, `CAND_HEADER_NAMES`, `authHeaders` field, per-pathId field count.
- `src/runProxy/classify.ts` — return `Entry[]`, `AUTH CANDIDATE` tag, `protocol/header/value` fields.
- `src/runProxy/uniqueTracker.ts` — dedup key includes `protocol/header/value`.
- `src/runProxy/formatOutput.ts` — render `AUTH CANDIDATE`.
- `src/runProxy/runProxyLoop.ts` — `onLogLine` iterates the classify array.
- `src/commands/importSbxNetworkPolicy.ts` — help text notes comment loss on regeneration.

**Modified — on-disk allowlist files (pragma migration):**

- `current-allow-list.txt`, `tests/integration/fixtures/allowlist.txt`, `tests/fixtures/invalid-allowlist.txt`.

**Modified — tests:**

- `tests/unit/allowlist.test.ts`, `tests/unit/envoyConfig.test.ts`, `tests/unit/policyFile.test.ts`, `tests/unit/runProxy/parseLine.test.ts`, `tests/unit/runProxy/classify.test.ts`, `tests/unit/runProxy/uniqueTracker.test.ts`, `tests/unit/runProxy/formatOutput.test.ts`, `tests/unit/runProxy/buildConfig.test.ts`, `tests/unit/runProxy/runProxyLoop.test.ts`, `tests/e2e/cli.test.ts`, `tests/integration/proxy.test.ts`, `tests/proxyStack.ts`, `tests/vm/vm.test.ts` (comment only).

---

## Task 1: Pragma syntax + legacy/unknown throw (no interface change)

Recognize `#pragma passthrough` / `#pragma claude authenticated` as the two section headers, throw on unknown `#pragma ...` and on legacy `# passthrough` / `# terminate`. `formatAllowlist` emits pragma headers. The `Allowlist` interface is **unchanged** in this task.

**Files:**

- Modify: `src/allowlist.ts` (`parseAllowlist`, `formatAllowlist`)
- Modify (migrate inline strings + `toEqual`): `tests/unit/allowlist.test.ts`, `tests/unit/runProxy/buildConfig.test.ts`, `tests/unit/runProxy/runProxyLoop.test.ts`, `tests/e2e/cli.test.ts`
- Modify (migrate on-disk): `current-allow-list.txt`, `tests/integration/fixtures/allowlist.txt`, `tests/fixtures/invalid-allowlist.txt`
- Modify (comment only): `tests/vm/vm.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `parseAllowlist(content: string): Allowlist` recognizing `#pragma passthrough` / `#pragma claude authenticated`, throwing `Error` on unknown `#pragma ` lines and on legacy `# passthrough` / `# terminate`. `formatAllowlist(allowlist: Allowlist): string` emitting `#pragma passthrough` / `#pragma claude authenticated` headers.

- [ ] **Step 1: Write the failing tests for pragma recognition and throwing**

Add these tests to `tests/unit/allowlist.test.ts` inside the `describe('parseAllowlist', ...)` block:

```ts
it('recognizes #pragma section headers', () => {
  const content = [
    '#pragma passthrough',
    '*.chatgpt.com:443',
    '',
    '#pragma claude authenticated',
    'api.anthropic.com:443',
    '',
  ].join('\n');

  expect(parseAllowlist(content)).toEqual({
    passthrough: ['*.chatgpt.com:443'],
    terminate: ['api.anthropic.com:443'],
    invalid: [],
  });
});

it('throws on an unrecognized #pragma line', () => {
  expect(() => parseAllowlist('#pragma bogus\n')).toThrow('Invalid pragma: "#pragma bogus"');
});

it('throws a migration hint on the legacy # terminate header', () => {
  expect(() => parseAllowlist('# terminate\napi.anthropic.com:443\n')).toThrow(
    'Legacy allowlist header "# terminate"; use "#pragma claude authenticated"',
  );
});

it('throws a migration hint on the legacy # passthrough header', () => {
  expect(() => parseAllowlist('# passthrough\npypi.org:443\n')).toThrow(
    'Legacy allowlist header "# passthrough"; use "#pragma passthrough"',
  );
});

it('still ignores non-pragma comment lines', () => {
  const content = [
    '#pragma passthrough',
    '## a free-text comment',
    'pypi.org:443',
    '',
    '#pragma claude authenticated',
    'api.anthropic.com:443',
    '',
  ].join('\n');

  expect(parseAllowlist(content)).toEqual({
    passthrough: ['pypi.org:443'],
    terminate: ['api.anthropic.com:443'],
    invalid: [],
  });
});
```

- [ ] **Step 2: Migrate every existing inline `# passthrough` / `# terminate` string in the touched test files**

In `tests/unit/allowlist.test.ts`, `tests/unit/runProxy/buildConfig.test.ts`, and `tests/unit/runProxy/runProxyLoop.test.ts`, replace every occurrence of the literal `'# passthrough'` with `'#pragma passthrough'` and `'# terminate'` with `'#pragma claude authenticated'` (including the `INVALID_ALLOWLIST` constant in `runProxyLoop.test.ts:20`, which becomes `['#pragma claude authenticated', '*.bad.example.com:443', ''].join('\n')`).

In `tests/unit/allowlist.test.ts`, the `formatAllowlist` expectation (lines 17-28) and the round-trip test must expect the pragma headers:

```ts
expect(formatAllowlist(allowlist)).toBe(
  [
    '#pragma passthrough',
    '*.chatgpt.com:443',
    'archive.ubuntu.com:80',
    '',
    '#pragma claude authenticated',
    'api.anthropic.com:443',
    'claude.com:443',
    '',
  ].join('\n'),
);
```

In `tests/e2e/cli.test.ts` (lines 83-93), update the expected `current-allow-list.txt` content to pragma headers:

```ts
expect(readFileSync(join(dir, 'current-allow-list.txt'), 'utf8')).toBe(
  [
    '#pragma passthrough',
    '*.chatgpt.com:443',
    'archive.ubuntu.com:80',
    '',
    '#pragma claude authenticated',
    'api.anthropic.com:443',
    'claude.com:443',
    '',
  ].join('\n'),
);
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/allowlist.test.ts`
Expected: FAIL — the new `#pragma` tests fail (parser still keys off `# passthrough`), and the migrated `formatAllowlist` expectation fails (still emits `# passthrough`).

- [ ] **Step 4: Implement pragma parsing and formatting in `src/allowlist.ts`**

Replace `parseAllowlist` (lines 33-70) with:

```ts
export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  const invalid = new Set<string>();
  let section: 'passthrough' | 'terminate' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '#pragma passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '#pragma claude authenticated') {
      section = 'terminate';
      continue;
    }
    if (line === '# passthrough' || line === '# terminate') {
      const replacement =
        line === '# passthrough' ? '#pragma passthrough' : '#pragma claude authenticated';
      throw new Error(`Legacy allowlist header "${line}"; use "${replacement}"`);
    }
    if (line.startsWith('#pragma ')) {
      throw new Error(`Invalid pragma: "${line}"`);
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

  return {
    passthrough: prunePassthrough([...passthrough]),
    terminate: [...terminate],
    invalid: [...invalid],
  };
}
```

Replace `formatAllowlist` (lines 79-86) with:

```ts
export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['#pragma passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '#pragma claude authenticated');
  for (const entry of [...allowlist.terminate].sort()) lines.push(entry);
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 5: Migrate the on-disk allowlist files**

In `current-allow-list.txt`: change the line `# passthrough` to `#pragma passthrough` and the line `# terminate` to `#pragma claude authenticated`. Leave all other `#` comment lines untouched.

In `tests/integration/fixtures/allowlist.txt`: same two replacements (`# passthrough` → `#pragma passthrough`, `# terminate` → `#pragma claude authenticated`). Leave the free-text comment block untouched.

In `tests/fixtures/invalid-allowlist.txt`: same two replacements, giving:

```
#pragma passthrough
crl*.digicert.com:80

#pragma claude authenticated
api.anthropic.com:443
```

In `tests/vm/vm.test.ts` (comment near line 313): update `The staged fixture ends with the '# terminate' section` to `The staged fixture ends with the '#pragma claude authenticated' section`.

- [ ] **Step 6: Run the allowlist and dependent unit tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/allowlist.test.ts tests/unit/runProxy/buildConfig.test.ts tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and run the full unit suite**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts tests/unit/runProxy/buildConfig.test.ts tests/unit/runProxy/runProxyLoop.test.ts tests/e2e/cli.test.ts current-allow-list.txt tests/integration/fixtures/allowlist.txt tests/fixtures/invalid-allowlist.txt tests/vm/vm.test.ts
git commit -m "Switch allowlist to #pragma section headers; throw on legacy/unknown"
```

---

## Task 2: Add `authCandidate` field, section, validation, and cert coverage

Add the required `authCandidate` field, parse `#pragma auth candidate`, apply terminate-style validation, guard the terminate∩authCandidate conflict, format the section (omitted when empty), and include auth-candidate hosts in `terminateTlsHosts`.

**Files:**

- Modify: `src/allowlist.ts` (`Allowlist`, `parseAllowlist`, `terminateTlsHosts`, `formatAllowlist`)
- Modify: `src/policyFile.ts` (add `authCandidate: []` to the returned literal)
- Modify: `tests/unit/allowlist.test.ts`, `tests/unit/policyFile.test.ts`, `tests/unit/envoyConfig.test.ts` (add `authCandidate: []` to every `Allowlist` literal and full-object `toEqual`)

**Interfaces:**

- Consumes: `parseAllowlist`, `formatAllowlist`, `terminateTlsHosts` from Task 1.
- Produces: `interface Allowlist { passthrough: string[]; terminate: string[]; authCandidate: string[]; invalid: string[] }`. `parseAllowlist` and `parsePolicyFile` always return `authCandidate` (empty when unused). `terminateTlsHosts(allowlist)` returns `:443` hosts from `terminate` **and** `authCandidate`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/allowlist.test.ts`:

```ts
it('parses the #pragma auth candidate section like terminate', () => {
  const content = [
    '#pragma passthrough',
    'pypi.org:443',
    '',
    '#pragma claude authenticated',
    'api.anthropic.com:443',
    '',
    '#pragma auth candidate',
    'partner.example.com:443',
    '',
  ].join('\n');

  expect(parseAllowlist(content)).toEqual({
    passthrough: ['pypi.org:443'],
    terminate: ['api.anthropic.com:443'],
    authCandidate: ['partner.example.com:443'],
    invalid: [],
  });
});

it('flags a wildcard in the auth candidate section as invalid', () => {
  const content = [
    '#pragma claude authenticated',
    'api.anthropic.com:443',
    '',
    '#pragma auth candidate',
    '*.partner.example.com:443',
    'partner.example.com:443',
    '',
  ].join('\n');

  expect(parseAllowlist(content)).toEqual({
    passthrough: [],
    terminate: ['api.anthropic.com:443'],
    authCandidate: ['partner.example.com:443'],
    invalid: ['*.partner.example.com:443'],
  });
});

it('moves a host present in both terminate and auth candidate to invalid', () => {
  const content = [
    '#pragma claude authenticated',
    'shared.example.com:443',
    '',
    '#pragma auth candidate',
    'shared.example.com:443',
    '',
  ].join('\n');

  expect(parseAllowlist(content)).toEqual({
    passthrough: [],
    terminate: [],
    authCandidate: [],
    invalid: ['shared.example.com:443'],
  });
});

it('omits the auth candidate section from formatAllowlist when empty', () => {
  const allowlist: Allowlist = {
    passthrough: ['pypi.org:443'],
    terminate: ['api.anthropic.com:443'],
    authCandidate: [],
    invalid: [],
  };
  expect(formatAllowlist(allowlist)).toBe(
    ['#pragma passthrough', 'pypi.org:443', '', '#pragma claude authenticated', 'api.anthropic.com:443', ''].join(
      '\n',
    ),
  );
});

it('writes and round-trips the auth candidate section when present', () => {
  const allowlist: Allowlist = {
    passthrough: [],
    terminate: ['api.anthropic.com:443'],
    authCandidate: ['b.example.com:443', 'a.example.com:443'],
    invalid: [],
  };
  const formatted = formatAllowlist(allowlist);
  expect(formatted).toBe(
    [
      '#pragma passthrough',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
      '#pragma auth candidate',
      'a.example.com:443',
      'b.example.com:443',
      '',
    ].join('\n'),
  );
  expect(parseAllowlist(formatted)).toEqual({
    passthrough: [],
    terminate: ['api.anthropic.com:443'],
    authCandidate: ['a.example.com:443', 'b.example.com:443'],
    invalid: [],
  });
});
```

Add to the `describe('terminateTlsHosts', ...)` block:

```ts
it('includes auth candidate :443 hosts alongside terminate hosts', () => {
  const allowlist: Allowlist = {
    passthrough: [],
    terminate: ['api.anthropic.com:443'],
    authCandidate: ['partner.example.com:443', 'plain.example.com:80'],
    invalid: [],
  };
  expect(terminateTlsHosts(allowlist)).toEqual(['api.anthropic.com', 'partner.example.com']);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/allowlist.test.ts`
Expected: FAIL — `authCandidate` is not a known property (type error) and the new cases fail.

- [ ] **Step 3: Implement the `authCandidate` field and parsing in `src/allowlist.ts`**

Replace the `Allowlist` interface (lines 1-5) with:

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  authCandidate: string[];
  invalid: string[];
}
```

Replace `parseAllowlist` (the Task 1 version) with:

```ts
export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  const authCandidate = new Set<string>();
  const invalid = new Set<string>();
  let section: 'passthrough' | 'terminate' | 'authCandidate' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '#pragma passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '#pragma claude authenticated') {
      section = 'terminate';
      continue;
    }
    if (line === '#pragma auth candidate') {
      section = 'authCandidate';
      continue;
    }
    if (line === '# passthrough' || line === '# terminate') {
      const replacement =
        line === '# passthrough' ? '#pragma passthrough' : '#pragma claude authenticated';
      throw new Error(`Legacy allowlist header "${line}"; use "${replacement}"`);
    }
    if (line.startsWith('#pragma ')) {
      throw new Error(`Invalid pragma: "${line}"`);
    }
    if (line.startsWith('#')) continue;
    if (section === null) continue;

    const { host } = splitHostPort(line);
    const hasWildcard = host.includes('*');
    const noWildcards = section === 'terminate' || section === 'authCandidate';

    if (hasWildcard && (noWildcards || !WILDCARD_HOST_PATTERN.test(host))) {
      invalid.add(line);
      continue;
    }

    if (section === 'passthrough') passthrough.add(line);
    else if (section === 'terminate') terminate.add(line);
    else authCandidate.add(line);
  }

  // A host in both terminate and authCandidate would emit two :443 filter
  // chains with the same SNI, which Envoy rejects at load. Pull the conflict
  // out of both sections and mark it invalid so run-proxy keeps the prior
  // config instead of building a config Envoy refuses.
  for (const entry of [...terminate]) {
    if (authCandidate.has(entry)) {
      terminate.delete(entry);
      authCandidate.delete(entry);
      invalid.add(entry);
    }
  }

  return {
    passthrough: prunePassthrough([...passthrough]),
    terminate: [...terminate],
    authCandidate: [...authCandidate],
    invalid: [...invalid],
  };
}
```

Replace `terminateTlsHosts` (lines 72-77) with:

```ts
/** Hosts the proxy terminates TLS for (the leaf's SANs): terminate + authCandidate entries on :443, port stripped. */
export function terminateTlsHosts(allowlist: Allowlist): string[] {
  return [...allowlist.terminate, ...allowlist.authCandidate]
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}
```

Replace `formatAllowlist` (the Task 1 version) with:

```ts
export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['#pragma passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '#pragma claude authenticated');
  for (const entry of [...allowlist.terminate].sort()) lines.push(entry);
  if (allowlist.authCandidate.length > 0) {
    lines.push('', '#pragma auth candidate');
    for (const entry of [...allowlist.authCandidate].sort()) lines.push(entry);
  }
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Add `authCandidate: []` to the `parsePolicyFile` return**

In `src/policyFile.ts`, change the returned object (lines 56-60) to:

```ts
  return {
    passthrough: [...passthrough].sort(),
    terminate: [...terminate].sort(),
    authCandidate: [],
    invalid: [...invalid].sort(),
  };
```

- [ ] **Step 5: Add `authCandidate: []` to every remaining `Allowlist` literal and full-object assertion**

The compiler now enumerates every site that omits the new required field. Add `authCandidate: []` to each:

- `tests/unit/allowlist.test.ts`: every `const allowlist: Allowlist = { ... }` and every `expect(parseAllowlist(...)).toEqual({ ... })` / `expect(parseAllowlist(formatAllowlist(...))).toEqual({ ... })` that does not already set it (the pre-existing cases from before this task).
- `tests/unit/envoyConfig.test.ts`: the top-level `allowlist` const (lines 5-9) and the `wildcardAllowlist` literal (lines 147-151).
- `tests/unit/policyFile.test.ts`: every `.toEqual({ passthrough..., terminate..., invalid... })`, including line 48 which becomes `toEqual({ passthrough: [], terminate: [], authCandidate: [], invalid: [] })`.

Example edit (representative — apply the same field addition everywhere):

```ts
// before
const allowlist: Allowlist = {
  passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
  terminate: ['api.anthropic.com:443'],
  invalid: [],
};
// after
const allowlist: Allowlist = {
  passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
  terminate: ['api.anthropic.com:443'],
  authCandidate: [],
  invalid: [],
};
```

- [ ] **Step 6: Typecheck to confirm no literal was missed**

Run: `pnpm typecheck`
Expected: PASS (no "property authCandidate is missing" errors).

- [ ] **Step 7: Run the affected unit tests**

Run: `pnpm exec vitest run tests/unit/allowlist.test.ts tests/unit/policyFile.test.ts tests/unit/envoyConfig.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/allowlist.ts src/policyFile.ts tests/unit/allowlist.test.ts tests/unit/policyFile.test.ts tests/unit/envoyConfig.test.ts
git commit -m "Add authCandidate allowlist section, validation, and cert coverage"
```

---

## Task 3: Envoy auth-candidate filter chain + cluster

Add `buildAuthCandidateEntry` (no gate, no injector, 12-char header access log) and splice its filter chains and clusters into the config. Factor the shared upstream cluster out of `buildTerminateEntry` to avoid drift.

**Files:**

- Modify: `src/envoyConfig.ts`
- Modify: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Consumes: `Allowlist` (with `authCandidate`) from Task 2.
- Produces: `generateEnvoyConfig` emitting, per `authCandidate` `:443` host, a filter chain whose `http_filters` is exactly `[envoy.filters.http.router]`, a `cluster_authcandidate_<host>` cluster (same shape as a terminate cluster, override-aware), and a `CFGM|cand|...` access log ending in the five `%REQ(...):12%` fields.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/envoyConfig.test.ts` a new describe block:

```ts
describe('generateEnvoyConfig auth candidate', () => {
  const candAllowlist: Allowlist = {
    passthrough: [],
    terminate: ['api.anthropic.com:443'],
    authCandidate: ['partner.example.com:443'],
    invalid: [],
  };

  it('builds an auth-candidate chain with only the router http filter', () => {
    const config = generateEnvoyConfig(candAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_authcandidate_partner_example_com',
    );
  });

  it('serves the leaf cert and builds an override-aware cluster', () => {
    const config = generateEnvoyConfig(candAllowlist, {
      overrides: [{ sniHost: 'partner.example.com', target: '127.0.0.1:9443' }],
    }) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    const tls = chain.transport_socket.typed_config.common_tls_context.tls_certificates[0];
    expect(tls.certificate_chain.filename).toBe('/etc/envoy/ca/leaf-cert.pem');

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_authcandidate_partner_example_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    expect(
      cluster.transport_socket.typed_config.common_tls_context.validation_context
        .trust_chain_verification,
    ).toBe('ACCEPT_UNTRUSTED');
  });

  it('logs the five auth headers truncated to 12 chars via a cand access log', () => {
    const config = generateEnvoyConfig(candAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    const log = chain.filters[0].typed_config.access_log[0].typed_config.log_format
      .text_format_source.inline_string;
    expect(log).toMatch(/^CFGM\|cand\|/);
    expect(log).toContain('%REQ(AUTHORIZATION):12%');
    expect(log).toContain('%REQ(COOKIE):12%');
    expect(log).toContain('%REQ(X-API-KEY):12%');
    expect(log).toContain('%REQ(X-AUTH-TOKEN):12%');
    expect(log).toContain('%REQ(PROXY-AUTHORIZATION):12%');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts`
Expected: FAIL — no auth-candidate filter chain is produced.

- [ ] **Step 3: Add the shared upstream-cluster helper and the auth-candidate builders in `src/envoyConfig.ts`**

Add this helper above `buildTerminateEntry` (after `sanitizeName`):

```ts
function buildTlsUpstreamCluster(
  clusterName: string,
  sniHost: string,
  portStr: string,
  override: UpstreamOverride | undefined,
) {
  const [upstreamHost, upstreamPortStr] = override ? override.target.split(':') : [sniHost, portStr];
  return {
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
}
```

In `buildTerminateEntry`, replace the inline `const cluster = { ... }` block (lines 134-165) with:

```ts
  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);
```

(The `override`/`upstreamHost`/`upstreamPortStr` locals at the top of `buildTerminateEntry` used only by that block can be reduced to just `const override = overrides.find((o) => o.sniHost === sniHost);`.)

Add the auth-candidate access-log builder next to `accessLog`:

```ts
function authCandidateAccessLog(): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              'CFGM|cand|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|' +
              '%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%REQ(AUTHORIZATION):12%|' +
              '%REQ(COOKIE):12%|%REQ(X-API-KEY):12%|%REQ(X-AUTH-TOKEN):12%|' +
              '%REQ(PROXY-AUTHORIZATION):12%\n',
          },
        },
      },
    },
  ];
}
```

Add the auth-candidate entry builder after `buildTerminateEntry`:

```ts
function buildAuthCandidateEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_authcandidate_${sanitizeName(sniHost)}`;

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
          stat_prefix: `authcandidate_${sanitizeName(sniHost)}`,
          access_log: authCandidateAccessLog(),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'authcandidate',
                domains: ['*'],
                // timeout '0s' matches the terminate path: don't sever long
                // streaming responses at Envoy's default 15s route timeout.
                routes: [{ match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } }],
              },
            ],
          },
          // No lua gate and no credential_injector: the point is to observe the
          // client's own auth untouched, not to reject or replace it.
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

  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);
  return { filterChain, cluster };
}
```

In `generateEnvoyConfig`, after the `terminateBuilt` declaration (line 252-254), add:

```ts
  const authCandidateBuilt = allowlist.authCandidate
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildAuthCandidateEntry(e, overrides));
```

In the `filter_chains` array (line 285), insert the auth-candidate chains right after the terminate chains:

```ts
          filter_chains: [
            ...terminateBuilt.map((b) => b.filterChain),
            ...authCandidateBuilt.map((b) => b.filterChain),
            {
              filter_chain_match: { server_names: passthroughServerNames },
```

In the `clusters` array (line 382), insert the auth-candidate clusters right after the terminate clusters:

```ts
      clusters: [
        ...terminateBuilt.map((b) => b.cluster),
        ...authCandidateBuilt.map((b) => b.cluster),
        ...http80ExactBuilt.map((b) => b.cluster),
```

- [ ] **Step 4: Run the envoy tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts`
Expected: PASS (new auth-candidate tests and the pre-existing terminate tests, which cover the refactored cluster helper).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "Emit Envoy filter chain + cluster for auth-candidate hosts"
```

---

## Task 4: Parse the `cand` access-log line

Extend `parseLine` to accept the 11-field `cand` line and expose the five header prefixes.

**Files:**

- Modify: `src/runProxy/parseLine.ts`
- Modify: `tests/unit/runProxy/parseLine.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `type PathId = 'term' | 'pass' | 'http' | 'deny443' | 'cand'`; `const CAND_HEADER_NAMES = ['Authorization', 'Cookie', 'X-API-Key', 'X-Auth-Token', 'Proxy-Authorization'] as const`; `interface AccessLine` gains `authHeaders?: string[]` (the five raw values in `CAND_HEADER_NAMES` order, present only for `cand`). `parseLine` returns `null` unless the field count matches the pathId (6 normally, 11 for `cand`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/runProxy/parseLine.test.ts`:

```ts
it('parses an 11-field cand line into authHeaders', () => {
  const line =
    'CFGM|cand|2026-07-18T09:00:00|partner.example.com|partner.example.com|via_upstream|Bearer abc12|-|sk-ant-key01|-|-';
  expect(parseLine(line)).toEqual({
    pathId: 'cand',
    time: '2026-07-18T09:00:00',
    serverName: 'partner.example.com',
    authority: 'partner.example.com',
    codeDetails: 'via_upstream',
    authHeaders: ['Bearer abc12', '-', 'sk-ant-key01', '-', '-'],
  });
});

it('returns null for a cand line without 11 fields', () => {
  expect(parseLine('CFGM|cand|2026-07-18T09:00:00|partner.example.com|partner.example.com|via_upstream')).toBeNull();
});

it('returns null for a non-cand line with 11 fields', () => {
  expect(parseLine('CFGM|term|t|s|a|d|x|x|x|x|x')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/runProxy/parseLine.test.ts`
Expected: FAIL — `cand` is rejected as an unknown path-id / wrong field count.

- [ ] **Step 3: Implement in `src/runProxy/parseLine.ts`**

Replace the whole file with:

```ts
export type PathId = 'term' | 'pass' | 'http' | 'deny443' | 'cand';

/** Header names carried by a `cand` line, in field order; also their display names. */
export const CAND_HEADER_NAMES = [
  'Authorization',
  'Cookie',
  'X-API-Key',
  'X-Auth-Token',
  'Proxy-Authorization',
] as const;

export interface AccessLine {
  pathId: PathId;
  time: string;
  serverName: string;
  authority: string;
  codeDetails: string;
  /** `cand` only: the five truncated header values in CAND_HEADER_NAMES order ('-' when absent). */
  authHeaders?: string[];
}

const PATH_IDS = new Set<PathId>(['term', 'pass', 'http', 'deny443', 'cand']);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  const pathId = parts[1] as PathId;
  if (!PATH_IDS.has(pathId)) return null;
  const expectedFields = pathId === 'cand' ? 11 : 6;
  if (parts.length !== expectedFields) return null;
  const [, , time, serverName, authority, codeDetails] = parts;
  return {
    pathId,
    time,
    serverName,
    authority,
    codeDetails,
    ...(pathId === 'cand' ? { authHeaders: parts.slice(6) } : {}),
  };
}
```

- [ ] **Step 4: Run the parseLine tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runProxy/parseLine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/parseLine.ts tests/unit/runProxy/parseLine.test.ts
git commit -m "Parse the 11-field cand access-log line"
```

---

## Task 5: Classify, dedup, format, and render `AUTH CANDIDATE` entries

Change `classify` to return `Entry[]`, emit one entry per present auth header, extend the dedup key, render the new line, and update `onLogLine` to iterate.

**Files:**

- Modify: `src/runProxy/classify.ts`, `src/runProxy/uniqueTracker.ts`, `src/runProxy/formatOutput.ts`, `src/runProxy/runProxyLoop.ts`
- Modify: `tests/unit/runProxy/classify.test.ts`, `tests/unit/runProxy/uniqueTracker.test.ts`, `tests/unit/runProxy/formatOutput.test.ts`

**Interfaces:**

- Consumes: `AccessLine`, `CAND_HEADER_NAMES` from Task 4.
- Produces: `type Tag` gains `'AUTH CANDIDATE'`; `interface Entry` gains `protocol?: string; header?: string; value?: string`; `classify(line: AccessLine): Entry[]`. `UniqueTracker.shouldPrint(entry: Entry)` keys on `${tag} ${domain} ${protocol ?? ''} ${header ?? ''} ${value ?? ''}`. `formatOutput(entry: Entry)` renders `AUTH CANDIDATE` as `HH:MM:SS  AUTH CANDIDATE  <domain>  <protocol>  <header>=<value>`.

- [ ] **Step 1: Write the failing tests**

Update `tests/unit/runProxy/classify.test.ts` — the existing assertions must expect arrays. Change the `ALLOW CRED` case to:

```ts
it('maps terminate to ALLOW CRED with the SNI as domain', () => {
  expect(classify(line({ pathId: 'term', serverName: 'api.anthropic.com' }))).toEqual([
    { time: '2026-07-06T12:00:00', tag: 'ALLOW CRED', domain: 'api.anthropic.com' },
  ]);
});
```

Change the three `.tag` assertions to index the array, e.g.:

```ts
expect(classify(line({ pathId: 'pass', serverName: 'pypi.org' }))[0].tag).toBe('ALLOW PASS');
```

```ts
expect(classify(line({ pathId: 'deny443', serverName: 'nope.example.com' }))[0].tag).toBe('BLOCK TLS');
```

```ts
expect(
  classify(line({ pathId: 'http', authority: 'nope.example.com', codeDetails: 'direct_response' }))[0].tag,
).toBe('BLOCK HTTP');
```

Change the `ALLOW HTTP` `.toEqual` to wrap in an array:

```ts
expect(
  classify(line({ pathId: 'http', authority: 'archive.ubuntu.com', codeDetails: 'via_upstream' })),
).toEqual([{ time: '2026-07-06T12:00:00', tag: 'ALLOW HTTP', domain: 'archive.ubuntu.com' }]);
```

Add cand cases:

```ts
it('emits one AUTH CANDIDATE entry per present header, skipping "-"', () => {
  const result = classify(
    line({
      pathId: 'cand',
      serverName: 'partner.example.com',
      authHeaders: ['Bearer abc12', '-', 'sk-ant-key01', '-', '-'],
    }),
  );
  expect(result).toEqual([
    {
      time: '2026-07-06T12:00:00',
      tag: 'AUTH CANDIDATE',
      domain: 'partner.example.com',
      protocol: 'https',
      header: 'Authorization',
      value: 'Bearer abc12',
    },
    {
      time: '2026-07-06T12:00:00',
      tag: 'AUTH CANDIDATE',
      domain: 'partner.example.com',
      protocol: 'https',
      header: 'X-API-Key',
      value: 'sk-ant-key01',
    },
  ]);
});

it('emits no entries for a cand line with all headers absent', () => {
  expect(
    classify(line({ pathId: 'cand', serverName: 'partner.example.com', authHeaders: ['-', '-', '-', '-', '-'] })),
  ).toEqual([]);
});
```

Add to `tests/unit/runProxy/uniqueTracker.test.ts`:

```ts
it('dedups AUTH CANDIDATE per domain+header+value but reprints a new value', () => {
  const t = new UniqueTracker();
  const cand = (header: string, value: string): Entry => ({
    time: '2026-07-18T09:00:00',
    tag: 'AUTH CANDIDATE',
    domain: 'partner.example.com',
    protocol: 'https',
    header,
    value,
  });
  expect(t.shouldPrint(cand('Authorization', 'Bearer abc12'))).toBe(true);
  expect(t.shouldPrint(cand('Authorization', 'Bearer abc12'))).toBe(false);
  // a rotated value prints again
  expect(t.shouldPrint(cand('Authorization', 'Bearer xyz99'))).toBe(true);
  // a different header prints again
  expect(t.shouldPrint(cand('X-API-Key', 'Bearer abc12'))).toBe(true);
});
```

Add to `tests/unit/runProxy/formatOutput.test.ts`:

```ts
it('formats an AUTH CANDIDATE entry with protocol and header=value', () => {
  expect(
    formatOutput({
      time: '2026-07-18T09:00:00',
      tag: 'AUTH CANDIDATE',
      domain: 'partner.example.com',
      protocol: 'https',
      header: 'Authorization',
      value: 'Bearer abc12',
    }),
  ).toBe('09:00:00  AUTH CANDIDATE  partner.example.com  https  Authorization=Bearer abc12');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/runProxy/classify.test.ts tests/unit/runProxy/uniqueTracker.test.ts tests/unit/runProxy/formatOutput.test.ts`
Expected: FAIL — `classify` still returns a single `Entry`; `AUTH CANDIDATE` is not a valid tag.

- [ ] **Step 3: Implement `classify` returning `Entry[]`**

Replace `src/runProxy/classify.ts` with:

```ts
import type { AccessLine } from './parseLine';
import { CAND_HEADER_NAMES } from './parseLine';

export type Tag =
  | 'ALLOW CRED'
  | 'ALLOW PASS'
  | 'ALLOW HTTP'
  | 'BLOCK TLS'
  | 'BLOCK HTTP'
  | 'AUTH CANDIDATE';

export interface Entry {
  time: string;
  tag: Tag;
  domain: string;
  protocol?: string;
  header?: string;
  value?: string;
}

export function classify(line: AccessLine): Entry[] {
  const domain = line.serverName !== '-' ? line.serverName : line.authority;

  if (line.pathId === 'cand') {
    const values = line.authHeaders ?? [];
    const entries: Entry[] = [];
    CAND_HEADER_NAMES.forEach((header, i) => {
      const value = values[i];
      if (value === undefined || value === '-') return;
      // protocol is hardcoded 'https' since auth-candidate only supports :443.
      entries.push({ time: line.time, tag: 'AUTH CANDIDATE', domain, protocol: 'https', header, value });
    });
    return entries;
  }

  let tag: Tag;
  switch (line.pathId) {
    case 'term':
      tag = 'ALLOW CRED';
      break;
    case 'pass':
      tag = 'ALLOW PASS';
      break;
    case 'deny443':
      tag = 'BLOCK TLS';
      break;
    case 'http':
      tag = line.codeDetails === 'direct_response' ? 'BLOCK HTTP' : 'ALLOW HTTP';
      break;
  }
  return [{ time: line.time, tag, domain }];
}
```

- [ ] **Step 4: Implement the dedup key in `src/runProxy/uniqueTracker.ts`**

Replace the `shouldPrint` body's key line (line 14) with:

```ts
    const key = `${entry.tag} ${entry.domain} ${entry.protocol ?? ''} ${entry.header ?? ''} ${entry.value ?? ''}`;
```

- [ ] **Step 5: Implement the render in `src/runProxy/formatOutput.ts`**

Replace `formatOutput` (lines 7-9) with:

```ts
export function formatOutput(entry: Entry): string {
  if (entry.tag === 'AUTH CANDIDATE') {
    return `${hms(entry.time)}  AUTH CANDIDATE  ${entry.domain}  ${entry.protocol}  ${entry.header}=${entry.value}`;
  }
  return `${hms(entry.time)}  ${entry.tag}  ${entry.domain}`;
}
```

- [ ] **Step 6: Update `onLogLine` in `src/runProxy/runProxyLoop.ts` to iterate**

Replace `onLogLine` (lines 166-173) with:

```ts
    const onLogLine = (raw: string): void => {
      if (settled) return;
      const access = parseLine(raw);
      if (!access) return;
      for (const entry of classify(access)) {
        if (!unique.shouldPrint(entry)) continue;
        deps.log(formatOutput(entry));
      }
    };
```

- [ ] **Step 7: Run the affected unit tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runProxy/classify.test.ts tests/unit/runProxy/uniqueTracker.test.ts tests/unit/runProxy/formatOutput.test.ts tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and run the full unit suite**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/runProxy/classify.ts src/runProxy/uniqueTracker.ts src/runProxy/formatOutput.ts src/runProxy/runProxyLoop.ts tests/unit/runProxy/classify.test.ts tests/unit/runProxy/uniqueTracker.test.ts tests/unit/runProxy/formatOutput.test.ts
git commit -m "Render AUTH CANDIDATE entries in the run-proxy log pipeline"
```

---

## Task 6: Document comment loss in `import-sbx-network-policy` help text

**Files:**

- Modify: `src/commands/importSbxNetworkPolicy.ts`
- Modify: `tests/e2e/cli.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: the `import-sbx-network-policy` command's `--help` output contains the substring `does not preserve hand-added comments`.

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/cli.test.ts` inside `describe('configamatron CLI', ...)`:

```ts
it('warns in help that import-sbx-network-policy regeneration drops comments', async () => {
  const { stdout, exitCode } = await execa('node', [cliPath, 'import-sbx-network-policy', '--help']);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('does not preserve customizations since last import, including hand-added comments');
});
```

- [ ] **Step 2: Build and run to verify failure**

Run: `pnpm build && pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts -t "drops comments"`
Expected: FAIL — the help text does not contain the phrase.

- [ ] **Step 3: Update the command description**

In `src/commands/importSbxNetworkPolicy.ts`, replace the `.description(...)` call (lines 9-12) with:

```ts
    .description(
      'Maintainer command: parse a network policy file into current-allow-list.txt ' +
        '(the tracked default allow list copied into environments by init). ' +
        'Regeneration overwrites the output file and does not preserve hand-added comments.',
    )
```

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `pnpm build && pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts -t "drops comments"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/importSbxNetworkPolicy.ts tests/e2e/cli.test.ts
git commit -m "Note comment loss in import-sbx-network-policy help text"
```

---

## Task 7: Integration test — live auth-candidate behavior

Add one auth-candidate host to the integration fixture, route it to the mock upstream, and assert the three live behaviors: gate absent, original headers preserved, and real 12-char truncation.

**Files:**

- Modify: `tests/integration/fixtures/allowlist.txt` (add the auth-candidate section)
- Modify: `tests/proxyStack.ts` (add a second `--upstream-override`)
- Modify: `tests/integration/proxy.test.ts` (add the auth-candidate tests + a request helper)

**Interfaces:**

- Consumes: `startProxyStack`/`ProxyStack` exports (`HTTPS_PORT`, `caCertPem`, `mockUpstream`, `proxyDir`, `composeEnv`) from `tests/proxyStack.ts`; `buildAuthCandidateEntry` behavior from Task 3; `terminateTlsHosts` cert coverage from Task 2.
- Produces: no new exported code — integration assertions only.

- [ ] **Step 1: Add the auth-candidate host to the integration fixture**

Append to `tests/integration/fixtures/allowlist.txt` (after the `#pragma claude authenticated` section migrated in Task 1):

```
#pragma auth candidate
auth-candidate.test:443
```

- [ ] **Step 2: Route the auth-candidate host to the mock upstream in `tests/proxyStack.ts`**

In the `run-proxy` argument array (the `--upstream-override` block near line 130), add a second override so both terminate and auth-candidate hosts reach the mock upstream:

```ts
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `auth-candidate.test=host.docker.internal:${mockUpstream.port}`,
```

- [ ] **Step 3: Write the failing tests in `tests/integration/proxy.test.ts`**

Add a request helper next to `requestThroughTerminate` (after line 53):

```ts
function requestThroughAuthCandidate(
  authorization: string,
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'auth-candidate.test',
        ca: caCertPem,
        path: '/',
        headers: { authorization },
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
```

Add these tests inside the `describe('Envoy sandbox proxy stack', ...)` block:

```ts
it('passes a non-placeholder auth header straight through an auth-candidate host (no gate, no injection)', async () => {
  const before = mockUpstream.receivedAuthorizationHeaders.length;
  const original = 'Bearer candidate-original-secret-value';
  const { statusCode } = await requestThroughAuthCandidate(original);

  // No lua gate: a non-placeholder credential is NOT 403'd (contrast the terminate host).
  expect(statusCode).toBe(200);
  // No credential_injector: the upstream sees the client's own header, unmodified.
  expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([original]);
});
```

Add this test inside the `describe('Envoy access logging', ...)` block (which already has `readEnvoyLogs`):

```ts
it('truncates auth-candidate header values to 12 chars in the cand access log', async () => {
  await requestThroughAuthCandidate('Bearer truncation-probe-0123456789');

  // Give Envoy a moment to flush the access log, then read it.
  let candLine: string | undefined;
  for (let attempt = 0; attempt < 20 && !candLine; attempt++) {
    const logs = await readEnvoyLogs();
    candLine = logs
      .split('\n')
      .find((l) => l.includes('CFGM|cand|') && l.includes('auth-candidate.test'));
    if (!candLine) await new Promise((r) => setTimeout(r, 500));
  }
  expect(candLine, 'expected a CFGM|cand| line for auth-candidate.test').toBeDefined();

  const fields = candLine!.slice(candLine!.indexOf('CFGM|')).trim().split('|');
  // Field 6 (0-indexed) is %REQ(AUTHORIZATION):12% — exactly the first 12 chars.
  expect(fields[6]).toBe('Bearer trunc');
}, 30000);
```

- [ ] **Step 4: Build and run the integration suite to verify the new tests fail meaningfully first**

Run: `pnpm build && pnpm test:integration`
Expected on the pre-implementation tree: these tests would fail; on the current tree (Tasks 1-6 done) they should pass. If a failure occurs, read the captured `run-proxy` output the harness prints for the failing SNI/cert/override.

- [ ] **Step 5: Confirm the integration suite passes**

Run: `pnpm build && pnpm test:integration`
Expected: PASS, including the two new auth-candidate tests. (Requires Docker running.)

- [ ] **Step 6: Commit**

```bash
git add tests/integration/fixtures/allowlist.txt tests/proxyStack.ts tests/integration/proxy.test.ts
git commit -m "Integration-test auth-candidate: no gate, no injection, 12-char log truncation"
```

---

## Task 8: Full-suite green + final commit

**Files:** none (verification only).

- [ ] **Step 1: Run the full test pipeline**

Run: `pnpm test`
Expected: PASS through `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration`. (Requires Docker for `test:integration`.)

- [ ] **Step 2: If `format:check` or `lint` flags anything, fix it**

Run: `pnpm format && pnpm lint`
Then re-run `pnpm test`. Expected: PASS.

- [ ] **Step 3: Commit any formatting fixups**

```bash
git add -A
git commit -m "Formatting and lint fixups for allowlist pragma + auth-candidate"
```

---

## Self-Review

**1. Spec coverage:**

- §1 pragma syntax (recognize three commands, throw on unknown, legacy-header throw, non-pragma comments ignored) → Task 1 (+ auth-candidate command in Task 2).
- §2 `Allowlist` shape (required `authCandidate`, always populated by parse + policyFile), same-as-terminate validation, cross-section conflict → invalid, `formatAllowlist` section-omitted-when-empty → Task 2.
- §3 `terminateTlsHosts` includes `authCandidate` → Task 2.
- §4 envoy `buildAuthCandidateEntry` (router-only http_filters, no gate/injector, distinct cluster/stat names, 12-char access log), spliced into config → Task 3.
- §5 pipeline: `parseLine` 11-field cand → Task 4; `classify` `Entry[]` + `AUTH CANDIDATE`, `uniqueTracker` key, `formatOutput`, `runProxyLoop` iterate → Task 5.
- §6 migration (on-disk files, policyFile.ts, whole-object `toEqual` churn, import-sbx help text) → Tasks 1, 2, 6.
- Testing (unit for allowlist/envoy/runProxy + integration: gate absent, no injection, real truncation) → Tasks 1-5, 7.

No spec requirement is left without a task.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" left. The one bulk-edit step (Task 2 Step 5, adding `authCandidate: []` to many literals) gives an exact rule, a representative before/after, and `pnpm typecheck` as the completeness check — the compiler enumerates every missed site by name.

**3. Type consistency:** `Allowlist.authCandidate: string[]` (Task 2) is consumed by `terminateTlsHosts` and `generateEnvoyConfig` (Task 3) with the same name. `CAND_HEADER_NAMES` and `AccessLine.authHeaders` (Task 4) are consumed by `classify` (Task 5) unchanged. `classify(line): Entry[]` (Task 5) matches the `onLogLine` iteration in the same task. `Entry.protocol/header/value` are set in `classify` and read in `uniqueTracker`/`formatOutput` with identical names. Envoy names `cluster_authcandidate_<host>` / `authcandidate_<host>` and `pathId` `cand` are used consistently across Tasks 3, 4, and the Task 7 log assertion (`CFGM|cand|`, field index 6).

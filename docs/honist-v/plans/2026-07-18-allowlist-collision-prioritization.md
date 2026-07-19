# Allowlist Collision Prioritization & Non-Fatal Warnings — Implementation Plan

**Goal:** Resolve exact cross-section allowlist collisions by a fixed priority order and surface every dropped entry (collision loser or invalid syntax) as a non-fatal warning, so run-proxy always builds the best valid config instead of failing.

**Architecture:** `parseAllowlist` (and the sibling `parsePolicyFile`) gain a `warnings: string[]` field replacing `invalid: string[]`. The parser de-conflicts any `host:port` present in more than one section using priority `authCandidate > terminate > passthrough`, dropping losing copies so Envoy emits exactly one filter chain per SNI. `run-proxy` stops treating allowlist *content* as fatal: it prints warnings and proceeds, failing only when the allowlist file is unreadable.

**Tech Stack:** TypeScript (Node ESM), vitest (unit/integration), pnpm, Envoy (via docker compose, integration only).

## Global Constraints

- **Priority order (highest wins):** `authCandidate > terminate > passthrough`. Copied to this exact order everywhere resolution happens.
- **Collision detection is exact-string only:** a `host:port` present verbatim in ≥2 sections. A passthrough wildcard (`*.x:443`) that merely *covers* an explicit `foo.x:443` in another section is **not** a collision and must be left in both sections.
- **Collision runs after `prunePassthrough`** and after invalid-syntax exclusion — only entries that survive into a section are reconciled.
- **Warning strings are presentation-neutral** (no `run-proxy:` / `import-sbx-network-policy:` prefix — the caller adds it) and wrap the entry in single quotes. Exact formats:
  - Invalid syntax: `unsupported wildcard syntax, excluded: '<entry>'`
  - Collision: `collision: '<entry>' listed in <sections joined by " and "> ; using <winner>` — with **no** space before the semicolon, i.e. `collision: 'shared.example.com:443' listed in passthrough and terminate; using terminate`
  - Sections in the "listed in" clause use stable display order: `passthrough`, `terminate`, `authCandidate`.
- **Warning emission order:** invalid-syntax warnings first (added during line parsing), then collision warnings (added in the resolution pass). Set-backed dedup preserves insertion order.
- **The only fatal / keep-previous allowlist case is an unreadable file** (`readAllowlist` returns `null`). Parseable-but-flawed content is never fatal.
- **Test command:** `pnpm test:unit` (all unit tests); a single file: `pnpm vitest run <path>`. Integration: `pnpm build && pnpm test:integration` (needs docker).

---

## Task 1: Parser — `warnings` field, quoted messages, and collision resolution

Replace the `invalid` field with `warnings` across the shared `Allowlist` type and both parsers, convert invalid-syntax exclusions to the quoted message, and replace the single terminate∩authCandidate guard with a full three-section collision pass. All mechanical renames in this task exist so the project compiles; the reviewable substance is the collision semantics.

**Files:**

- Modify: `src/allowlist.ts` (interface + `parseAllowlist` resolution)
- Modify: `src/policyFile.ts` (`parsePolicyFile` field + message)
- Modify: `src/commands/importSbxNetworkPolicy.ts:20-25` (iterate `warnings`)
- Modify: `src/runProxy/buildConfig.ts:8` (doc comment reference)
- Modify: `src/runProxy/runProxyLoop.ts` (field-name references only — behavior unchanged this task)
- Test: `tests/unit/allowlist.test.ts`
- Test: `tests/unit/policyFile.test.ts`
- Test: `tests/unit/envoyConfig.test.ts` (Allowlist literals: `invalid: []` → `warnings: []`)

**Interfaces:**

- Produces: `interface Allowlist { passthrough: string[]; terminate: string[]; authCandidate: string[]; warnings: string[] }` — `warnings` replaces `invalid`. `parseAllowlist(content: string): Allowlist` and `parsePolicyFile(content: string): Allowlist` unchanged in signature.
- Consumes: nothing new.

- [ ] **Step 1: Flip the two collision unit tests and add the new collision cases (failing)**

In `tests/unit/allowlist.test.ts`, replace the test at `:145` ("keeps the same host in both passthrough and terminate independently") with:

```ts
  it('resolves a passthrough+terminate collision to terminate with a warning', () => {
    const content = [
      '#pragma passthrough',
      'shared.example.com:443',
      '',
      '#pragma claude authenticated',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      terminate: ['shared.example.com:443'],
      authCandidate: [],
      warnings: [
        "collision: 'shared.example.com:443' listed in passthrough and terminate; using terminate",
      ],
    });
  });
```

Replace the test at `:375` ("moves a host present in both terminate and auth candidate to invalid") with:

```ts
  it('resolves a terminate+authCandidate collision to authCandidate with a warning', () => {
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
      authCandidate: ['shared.example.com:443'],
      warnings: [
        "collision: 'shared.example.com:443' listed in terminate and authCandidate; using authCandidate",
      ],
    });
  });
```

Add these new cases (anywhere in the `describe('parseAllowlist auth candidate', ...)` block):

```ts
  it('resolves a passthrough+authCandidate collision to authCandidate with a warning', () => {
    const content = [
      '#pragma passthrough',
      'shared.example.com:443',
      '',
      '#pragma auth candidate',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      terminate: [],
      authCandidate: ['shared.example.com:443'],
      warnings: [
        "collision: 'shared.example.com:443' listed in passthrough and authCandidate; using authCandidate",
      ],
    });
  });

  it('resolves a host present in all three sections to authCandidate, naming all three', () => {
    const content = [
      '#pragma passthrough',
      'shared.example.com:443',
      '',
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
      authCandidate: ['shared.example.com:443'],
      warnings: [
        "collision: 'shared.example.com:443' listed in passthrough and terminate and authCandidate; using authCandidate",
      ],
    });
  });

  it('emits an invalid-syntax warning and a collision warning together, syntax first', () => {
    const content = [
      '#pragma passthrough',
      'crl*.digicert.com:80',
      'shared.example.com:443',
      '',
      '#pragma claude authenticated',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      terminate: ['shared.example.com:443'],
      authCandidate: [],
      warnings: [
        "unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'",
        "collision: 'shared.example.com:443' listed in passthrough and terminate; using terminate",
      ],
    });
  });

  it('does not treat a wildcard-covered terminate host as a collision', () => {
    const content = [
      '#pragma passthrough',
      '*.example.com:443',
      '',
      '#pragma claude authenticated',
      'foo.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.example.com:443'],
      terminate: ['foo.example.com:443'],
      authCandidate: [],
      warnings: [],
    });
  });
```

- [ ] **Step 2: Mechanically rename `invalid` → `warnings` in the remaining literal assertions**

In `tests/unit/allowlist.test.ts`, for every remaining `invalid: []` change the key to `warnings: []`. For the four cases whose value is non-empty, change both key and value to the quoted message:

- `:178` → `warnings: ["unsupported wildcard syntax, excluded: '**.ubuntu.com:80'"]`
- `:197` → `warnings: ["unsupported wildcard syntax, excluded: '**.ubuntu.com:80'"]`
- `:291` → `warnings: ["unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'"]`
- `:310` → `warnings: ["unsupported wildcard syntax, excluded: '*.anthropic.com:443'"]`
- `:329` → `warnings: ["unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'"]`
- `:371` → `warnings: ["unsupported wildcard syntax, excluded: '*.partner.example.com:443'"]`

In `tests/unit/envoyConfig.test.ts`, change the three `invalid: []` literals (lines 9, 167, 248) to `warnings: []`.

- [ ] **Step 3: Run the allowlist tests to verify they fail**

Run: `pnpm vitest run tests/unit/allowlist.test.ts`
Expected: FAIL — `warnings` does not exist on the returned object / collisions not yet resolved (e.g. `shared.example.com:443` still present in both sections).

- [ ] **Step 4: Update the `Allowlist` interface and `parseAllowlist` resolution**

In `src/allowlist.ts`, change the interface field:

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  authCandidate: string[];
  warnings: string[];
}
```

In `parseAllowlist`, rename the local set and change the invalid-syntax push. Replace:

```ts
  const invalid = new Set<string>();
```

with:

```ts
  const warnings = new Set<string>();
```

Replace the invalid-syntax block (currently `invalid.add(line); continue;`):

```ts
    if (hasWildcard && (noWildcards || !WILDCARD_HOST_PATTERN.test(host))) {
      warnings.add(`unsupported wildcard syntax, excluded: '${line}'`);
      continue;
    }
```

Replace the terminate∩authCandidate block (the `for (const entry of [...terminate]) { ... }` loop) and the `return` with the collision pass and updated return:

```ts
  const passthroughSet = new Set(prunePassthrough([...passthrough]));

  // Resolve exact host:port strings present in more than one section. Priority:
  // authCandidate > terminate > passthrough. Losing copies are dropped so Envoy
  // emits exactly one filter chain per SNI, and each drop is reported as a warning.
  const byPriority: Array<{ name: string; set: Set<string> }> = [
    { name: 'authCandidate', set: authCandidate },
    { name: 'terminate', set: terminate },
    { name: 'passthrough', set: passthroughSet },
  ];
  const displayOrder = ['passthrough', 'terminate', 'authCandidate'];

  for (const entry of new Set([...passthroughSet, ...terminate, ...authCandidate])) {
    const present = byPriority.filter((s) => s.set.has(entry));
    if (present.length < 2) continue;
    const [winner, ...losers] = present; // byPriority is priority-ordered
    for (const loser of losers) loser.set.delete(entry);
    const listed = displayOrder.filter((name) => present.some((p) => p.name === name));
    warnings.add(`collision: '${entry}' listed in ${listed.join(' and ')}; using ${winner.name}`);
  }

  return {
    passthrough: [...passthroughSet],
    terminate: [...terminate],
    authCandidate: [...authCandidate],
    warnings: [...warnings],
  };
```

- [ ] **Step 5: Run the allowlist tests to verify they pass**

Run: `pnpm vitest run tests/unit/allowlist.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `parsePolicyFile` and its tests**

In `src/policyFile.ts`, rename the set and change the message:

```ts
  const warnings = new Set<string>();
```

Change `invalid.add(resource);` to:

```ts
        warnings.add(`unsupported wildcard syntax, excluded: '${resource}'`);
```

Change the return's `invalid: [...invalid].sort()` to `warnings: [...warnings].sort()`.

In `tests/unit/policyFile.test.ts`, change `:23` and `:54` `invalid: []` → `warnings: []`, and `:40` to:

```ts
      warnings: ["unsupported wildcard syntax, excluded: 'foo*.bar.com:443'"],
```

- [ ] **Step 7: Update the two non-test consumers to compile**

In `src/commands/importSbxNetworkPolicy.ts`, replace the `if (allowlist.invalid.length > 0) { ... }` block with:

```ts
      for (const warning of allowlist.warnings) {
        console.warn(`import-sbx-network-policy: ${warning}`);
      }
```

In `src/runProxy/buildConfig.ts:8`, change the doc comment sentence to:

```ts
 * write it to outputPath. Surfacing `allowlist.warnings` is the caller's job.
```

In `src/runProxy/runProxyLoop.ts`, rename the field references only (behavior stays fatal this task). At the startup block (~`:369-375`) and in `readValidAllowlist` (~`:194-200`), change `allowlist.invalid` → `allowlist.warnings` in both the `.length > 0` checks and the `.map((entry) => ...)` calls. Do **not** change control flow yet.

- [ ] **Step 8: Run the full unit suite and typecheck**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS. (runProxyLoop tests `:176`/`:305` still pass — their substring assertions still match the renamed field's messages.)

- [ ] **Step 9: Commit**

```bash
git add src/allowlist.ts src/policyFile.ts src/commands/importSbxNetworkPolicy.ts src/runProxy/buildConfig.ts src/runProxy/runProxyLoop.ts tests/unit/allowlist.test.ts tests/unit/policyFile.test.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(allowlist): resolve cross-section collisions by priority, add warnings field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: run-proxy — allowlist content warnings are non-fatal

Stop failing / keeping-previous on parseable-but-flawed allowlists. Print warnings and proceed. Only an unreadable file stays fatal (startup) / keep-previous (reload).

**Files:**

- Modify: `src/runProxy/runProxyLoop.ts` (startup block ~`:368-375`; `readValidAllowlist` ~`:184-202`)
- Test: `tests/unit/runProxy/runProxyLoop.test.ts`

**Interfaces:**

- Consumes: `Allowlist.warnings` (from Task 1).
- Produces: `readParsedAllowlist(): Allowlist | null` — renamed from `readValidAllowlist`; returns `null` **only** when the file is unreadable.

- [ ] **Step 1: Add a collision constant and rewrite the two behavior tests (failing)**

In `tests/unit/runProxy/runProxyLoop.test.ts`, add near the other allowlist constants (after `INVALID_ALLOWLIST`):

```ts
const COLLISION_ALLOWLIST = [
  '#pragma passthrough',
  'shared.example.com:443',
  '',
  '#pragma claude authenticated',
  'api.anthropic.com:443',
  'shared.example.com:443',
  '',
].join('\n');
```

Replace the test at `:176` ("exits 1 on an invalid allowlist without touching docker") with:

```ts
  it('warns but still brings up the proxy on an invalid-syntax allowlist', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, INVALID_ALLOWLIST);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('unsupported wildcard syntax'),
    );
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

    // Still running (not settled): a later SIGINT would resolve it.
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });

  it('warns and resolves a collision, then brings up the proxy from the resolved config', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, COLLISION_ALLOWLIST);
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "collision: 'shared.example.com:443' listed in passthrough and terminate; using terminate",
      ),
    );
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].terminate).toEqual([
      'api.anthropic.com:443',
      'shared.example.com:443',
    ]);
    expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toEqual([]);
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
  });
```

Replace the test at `:305` ("keeps the previous config on an invalid edit and stays live for the fix") with:

```ts
  it('applies the resolved config on a flawed edit and warns instead of keeping previous', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.buildConfig.mockClear();
    h.mocks.bringUpColor.mockClear();

    h.allowlist.value = COLLISION_ALLOWLIST;
    h.fireAllowlist();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("collision: 'shared.example.com:443'"),
    );
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].terminate).toContain('shared.example.com:443');
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the runProxyLoop tests to verify they fail**

Run: `pnpm vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: FAIL — startup still exits 1 on `INVALID_ALLOWLIST`; reload still keeps previous (buildConfig not called).

- [ ] **Step 3: Make the reload path non-fatal**

In `src/runProxy/runProxyLoop.ts`, rewrite `readValidAllowlist` (rename included). Replace the whole function with:

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
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);
      return allowlist;
    };
```

Update the caller in `drainRestarts` (`const allowlist = readValidAllowlist();`) to `readParsedAllowlist()`.

- [ ] **Step 4: Make the startup path non-fatal**

In `start`, replace the block:

```ts
      const allowlist = parseAllowlist(content);
      if (allowlist.warnings.length > 0) {
        fatal(
          `unsupported wildcard syntax in ${config.allowlistPath}:\n` +
            allowlist.warnings.map((entry) => `  - ${entry}`).join('\n'),
        );
        return;
      }
```

with:

```ts
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);
```

- [ ] **Step 5: Run the runProxyLoop tests to verify they pass**

Run: `pnpm vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full unit suite and typecheck**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runProxy/runProxyLoop.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "feat(run-proxy): treat allowlist content warnings as non-fatal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 (optional, recommended): integration test — Envoy accepts a collision-resolved config

Proves the real payoff: an allowlist that previously produced duplicate SNI filter chains (which Envoy rejects at load) now starts cleanly because the collision is resolved to a single section. Requires docker; skip if unavailable.

**Files:**

- Modify: `tests/integration/runProxyRobustness.test.ts`

**Interfaces:**

- Consumes: the run-proxy CLI and the existing integration harness (`proxyDir`, `writeCredentials`, `waitForLine`, `envoyEnv`).

- [ ] **Step 1: Add a no-fault spawn helper**

In `tests/integration/runProxyRobustness.test.ts`, add alongside `spawnProxy`:

```ts
function spawnProxyPlain(): ResultPromise {
  lines = [];
  const proc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => lines.push(line));
  }
  return proc;
}
```

- [ ] **Step 2: Add the test (failing without the parser fix; passing with it)**

Add inside `describe('run-proxy robustness', ...)`:

```ts
  it('starts cleanly on a passthrough+terminate collision (single filter chain per SNI)', async () => {
    writeFileSync(
      join(proxyDir, 'allowlist.txt'),
      [
        '#pragma passthrough',
        'shared.example.com:443',
        '',
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        'shared.example.com:443',
        '',
      ].join('\n'),
    );

    proxyProc = spawnProxyPlain();
    // The collision warning appears, and Envoy accepts the resolved config and
    // becomes ready — a regression would leave Envoy refusing the config.
    await waitForLine("collision: 'shared.example.com:443'", 30000);
    await waitForLine('proxy is serving the current token', 60000);
  }, 120000);
```

- [ ] **Step 3: Restore the fixture allowlist after this test**

Because `beforeAll` copies the fixture once, add an `afterEach` restore so this test does not leak its allowlist into others. In the existing `afterEach` (after the docker `compose down`), append:

```ts
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
```

- [ ] **Step 4: Build and run the integration suite**

Run: `pnpm build && pnpm test:integration`
Expected: PASS (all three robustness tests). If docker is unavailable, skip this task.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/runProxyRobustness.test.ts
git commit -m "test(run-proxy): integration cover Envoy accepting a collision-resolved config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

- `warnings` field replacing `invalid` — Task 1 (interface, both parsers, all consumers). ✓
- Invalid-syntax pass → quoted message — Task 1 Step 4/6. ✓
- Collision pass, priority `authCandidate > terminate > passthrough`, runs after prune — Task 1 Step 4. ✓
- Collision + all-three + wildcard-cover-not-a-collision — Task 1 Step 1 tests. ✓
- Warning format (quoted, neutral, caller-prefixed, order) — Global Constraints + Task 1/2. ✓
- run-proxy startup non-fatal — Task 2 Step 4. ✓
- run-proxy reload non-fatal + narrowed `readParsedAllowlist` contract/rename — Task 2 Step 3. ✓
- Unreadable file still fatal/keep-previous — unchanged; guarded by existing `:190` test and the retained `content === null` branches. ✓
- `policyFile` / `importSbxNetworkPolicy` / `formatAllowlist` — Task 1 (formatAllowlist untouched, reads only sections). ✓
- e2e confirming Envoy accepts the config — Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; test assertions are concrete strings.

**Type consistency:** `Allowlist.warnings` used identically in Tasks 1–2; `readValidAllowlist` → `readParsedAllowlist` renamed at both definition and its single caller (`drainRestarts`); collision message format matches between parser (Task 1) and the run-proxy test assertions (Task 2) and integration needle (Task 3).

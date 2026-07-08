# Allowlist Duplicate-Entry Tolerance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `parseAllowlist` tolerates duplicate lines within a section (`# passthrough` or `# terminate`) so that `build-envoy-config` never generates an `envoy.yaml` with duplicate cluster names or duplicate route domains.

**Architecture:** Change `parseAllowlist` in `src/allowlist.ts` to collect each section's entries in a `Set` instead of an array, then spread back to an array before returning. `Set` preserves insertion order and silently ignores re-adding an existing value, which gives first-occurrence-wins dedup with zero new control flow. Every consumer of `Allowlist` (`generateEnvoyConfig`, `import-sbx-network-policy`'s round-trip) goes through `parseAllowlist`, so this single change fixes `build-envoy-config` with no edits to `envoyConfig.ts` or `buildEnvoyConfig.ts`.

**Tech Stack:** TypeScript, vitest (`test:unit` for unit tests, `test:e2e` for CLI tests against the built `dist/cli.js`).

## Global Constraints

- Dedup is per-section only. The same host string in both `passthrough` and `terminate` is untouched — both entries survive.
- Duplicate definition: exact match of the trimmed line text. No case-folding or other normalization.
- First occurrence wins; array order for surviving entries otherwise matches source order.
- No console output when a duplicate is dropped (silent).
- `formatAllowlist` and `parsePolicyFile` are not touched by this plan.

---

### Task 1: Dedupe `parseAllowlist`

**Files:**
- Modify: `src/allowlist.ts:6-28` (the `parseAllowlist` function)
- Test: `tests/unit/allowlist.test.ts`

**Interfaces:**
- Consumes: nothing new — uses the existing `Allowlist` interface (`{ passthrough: string[]; terminate: string[] }`) already exported from `src/allowlist.ts`.
- Produces: `parseAllowlist(content: string): Allowlist` — same signature as today, but the returned arrays are deduped per-section. `generateEnvoyConfig` (Task 2's e2e test target) relies on this behavior without any code changes on its side.

- [ ] **Step 1: Write the failing unit test for within-section dedup**

Add this test to the `describe('parseAllowlist', ...)` block in `tests/unit/allowlist.test.ts` (after the existing `'round-trips through formatAllowlist'` test, still inside the same `describe`):

```ts
  it('drops an exact-duplicate line within a section, keeping first-occurrence order', () => {
    const content = [
      '# passthrough',
      'archive.ubuntu.com:80',
      '**.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
    });
  });

  it('keeps the same host in both passthrough and terminate independently', () => {
    const content = [
      '# passthrough',
      'shared.example.com:443',
      '',
      '# terminate',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['shared.example.com:443'],
      terminate: ['shared.example.com:443'],
    });
  });
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `pnpm test:unit -- allowlist`

Expected: The `'drops an exact-duplicate line within a section...'` test FAILS — actual `passthrough` is `['archive.ubuntu.com:80', '**.chatgpt.com:443', 'archive.ubuntu.com:80']` (3 entries, not 2), same for `terminate`. The `'keeps the same host...'` test PASSES already (cross-section behavior is unaffected by this change, since today's code doesn't dedupe at all).

- [ ] **Step 3: Implement the dedup in `parseAllowlist`**

Replace the full function body in `src/allowlist.ts`:

```ts
export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
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
    if (section === 'passthrough') passthrough.add(line);
    else if (section === 'terminate') terminate.add(line);
  }

  return { passthrough: [...passthrough], terminate: [...terminate] };
}
```

This is the only change in the file — `formatAllowlist` below it is untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:unit -- allowlist`

Expected: All tests in `tests/unit/allowlist.test.ts` PASS, including both new tests.

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts
git commit -m "fix: dedupe allowlist entries within a section in parseAllowlist"
```

---

### Task 2: Prove the fix end-to-end through `build-envoy-config`

**Files:**
- Modify: `tests/fixtures/sample-allowlist.txt`
- Modify: `tests/e2e/cli.test.ts:71-101` (the `'generates envoy.yaml into the environment by default with build-envoy-config'` test)

**Interfaces:**
- Consumes: `parseAllowlist` from Task 1 (indirectly, via the built `dist/cli.js`), and the existing `generateEnvoyConfig` output shape — `config.static_resources.clusters[].name` and `config.static_resources.listeners[].name` / `.filter_chains[].filter_chain_match.server_names`, both already used by the test being modified.
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Add a duplicate line to the fixture**

Read current content of `tests/fixtures/sample-allowlist.txt`:

```
# passthrough
**.chatgpt.com:443
archive.ubuntu.com:80

# terminate
api.anthropic.com:443
```

Replace it with (duplicating the `api.anthropic.com:443` line):

```
# passthrough
**.chatgpt.com:443
archive.ubuntu.com:80

# terminate
api.anthropic.com:443
api.anthropic.com:443
```

- [ ] **Step 2: Strengthen the e2e test assertions**

In `tests/e2e/cli.test.ts`, replace this block (currently lines 90-97):

```ts
      const outputPath = join(dir, '.configamatron', 'proxy', 'envoy.yaml');
      const config = parse(readFileSync(outputPath, 'utf8')) as any;
      const cluster = config.static_resources.clusters.find(
        (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(
        cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
```

with:

```ts
      const outputPath = join(dir, '.configamatron', 'proxy', 'envoy.yaml');
      const config = parse(readFileSync(outputPath, 'utf8')) as any;

      const matchingClusters = config.static_resources.clusters.filter(
        (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(matchingClusters).toHaveLength(1);
      const cluster = matchingClusters[0];
      expect(
        cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });

      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const matchingFilterChains = listener443.filter_chains.filter((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
      );
      expect(matchingFilterChains).toHaveLength(1);
```

The fixture now has `api.anthropic.com:443` listed twice under `# terminate`. Before Task 1's fix, this would have produced two clusters named `cluster_terminate_api_anthropic_com` and two filter chains matching `server_names: ['api.anthropic.com']` — exactly the invalid-Envoy-config scenario described in the design doc. The `toHaveLength(1)` assertions fail if that regresses.

- [ ] **Step 3: Build and run the e2e test to verify it passes**

Run: `pnpm build && pnpm test:e2e -- cli`

Expected: All tests in `tests/e2e/cli.test.ts` PASS, including the modified `'generates envoy.yaml into the environment by default with build-envoy-config'` test. (This test passes on first run since Task 1 already fixed `parseAllowlist` — its purpose here is proving the fix holds through the full command pipeline: file read, parse, Envoy config generation, and YAML serialization.)

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/sample-allowlist.txt tests/e2e/cli.test.ts
git commit -m "test: prove build-envoy-config tolerates duplicate allowlist entries"
```

---

### Task 3: Full verification run

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`

Expected: PASS — format check, lint, typecheck, unit tests, build, e2e tests, and integration tests all succeed. No output changes expected outside the files touched in Tasks 1 and 2.

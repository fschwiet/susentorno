# Single `*` Wildcard Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two equivalent allow-list wildcard spellings (`*.host` and `**.host`) down to a single `*.host` form across the codebase.

**Architecture:** `parseAllowlist` stops accepting `**.` — it now only recognizes `*.host` and reports `**.host` as an `invalid` entry (which `build-envoy-config` already rejects with exit 1). `import-sbx-network-policy` becomes the sole boundary that ingests upstream policy (which uses `**.`): its parser `parsePolicyFile` translates `**.host` → `*.host` and skips wildcard patterns it cannot support (e.g. `foo*.bar.com`), recording them in `invalid[]` so the command can warn.

**Tech Stack:** TypeScript, Node, commander, vitest, execa (e2e).

## Global Constraints

- A wildcard host is valid iff it matches `/^\*\.[^*]+$/`: a single leading `*.` followed by one or more non-`*` characters, no other `*` anywhere.
- `current-allow-list.txt` is NOT touched by this change (already hand-converted).
- Tests are TDD: write the failing test first, watch it fail, then implement.
- Run the full suite with `pnpm test` (fail-fast: format, lint, typecheck, unit, build, e2e, integration). Individual unit files: `pnpm vitest run <path>`.

---

### Task 1: `parseAllowlist` drops `**` support

**Files:**
- Modify: `src/allowlist.ts` (lines 7, 14–16, 60–67)
- Test: `tests/unit/allowlist.test.ts`

**Interfaces:**
- Produces: `export const WILDCARD_HOST_PATTERN = /^\*\.[^*]+$/` (Task 2 imports this). `parseAllowlist(content: string): Allowlist` unchanged in signature; behavior change is that `**.host` now lands in `invalid[]`.

- [ ] **Step 1: Update the unit tests to the new behavior**

In `tests/unit/allowlist.test.ts`, make these replacements so every `**.` input becomes either a `*.` input (for the normalization-independent cases) or an explicit invalid-case assertion.

Replace the `formatAllowlist` test's passthrough sample (lines ~11–27) so it uses `*.chatgpt.com:443` instead of `**.chatgpt.com:443` in both the input and the expected output.

Replace the `parseAllowlist` "splits entries" test (lines ~33–50) with:

```typescript
  it('splits entries into passthrough and terminate by section header', () => {
    const content = [
      '# passthrough',
      '*.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });
```

In the "round-trips through formatAllowlist" test (lines ~52–64), change the passthrough sample `'**.chatgpt.com:443'` to `'*.chatgpt.com:443'` and change the expected passthrough `'*.chatgpt.com:443'` (already `*.`) — result stays `['archive.ubuntu.com:80', '*.chatgpt.com:443']` after prune order; keep expected as `passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80']` sorted per current assertion. Concretely replace the block with:

```typescript
  it('round-trips through formatAllowlist', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };

    expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });
```

In the "drops an exact-duplicate line" test (lines ~66–85), change `'**.chatgpt.com:443'` to `'*.chatgpt.com:443'` and the expected passthrough `'*.chatgpt.com:443'`.

Replace the "normalizes **.host to Envoy-native *.host" test (lines ~104–119) with a test that `**.` is now invalid:

```typescript
  it('flags a **.host wildcard as invalid instead of normalizing it', () => {
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
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['**.ubuntu.com:80'],
    });
  });
```

Replace the "collapses **.host and *.host ..." test (lines ~121–137) with one asserting the `**.` spelling is invalid while the `*.` spelling is kept:

```typescript
  it('keeps *.host but flags the **.host spelling of the same host as invalid', () => {
    const content = [
      '# passthrough',
      '*.ubuntu.com:80',
      '**.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['**.ubuntu.com:80'],
    });
  });
```

In the four prune tests (lines ~139–208: "prunes an exact passthrough entry...", "does not prune an exact entry at a different port...", "does not prune the wildcard's own bare base domain...", "does not prune a terminate entry..."), change every `'**.ubuntu.com:80'` to `'*.ubuntu.com:80'` in both input and expected.

In the "flags any wildcard in the terminate section as invalid" test (lines ~228–244), change the terminate input `'**.anthropic.com:443'` to `'*.anthropic.com:443'` and the expected `invalid` to `['*.anthropic.com:443']` (proves even a valid-shape wildcard is invalid in the terminate section).

Leave the mid-string tests (`crl*.digicert.com:80`) unchanged — they stay invalid.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/allowlist.test.ts`
Expected: FAIL — `**.ubuntu.com:80` is still being normalized to `*.ubuntu.com:80` instead of appearing in `invalid`.

- [ ] **Step 3: Tighten the pattern and remove normalization**

In `src/allowlist.ts`:

Change line 7 to export a single-star pattern:

```typescript
export const WILDCARD_HOST_PATTERN = /^\*\.[^*]+$/;
```

Delete the `normalizeWildcardHost` function (lines 14–16):

```typescript
function normalizeWildcardHost(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}
```

Replace the entry-building block in `parseAllowlist` (currently lines 60–67):

```typescript
    if (hasWildcard && (section === 'terminate' || !WILDCARD_HOST_PATTERN.test(host))) {
      invalid.add(line);
      continue;
    }

    const entry = hasWildcard ? `${normalizeWildcardHost(host)}:${splitHostPort(line).port}` : line;
    if (section === 'passthrough') passthrough.add(entry);
    else terminate.add(entry);
```

with (no normalization — the line is already `*.host`):

```typescript
    if (hasWildcard && (section === 'terminate' || !WILDCARD_HOST_PATTERN.test(host))) {
      invalid.add(line);
      continue;
    }

    if (section === 'passthrough') passthrough.add(line);
    else terminate.add(line);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/allowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts
git commit -m "feat(allowlist): accept only *.host wildcards, reject **.host"
```

---

### Task 2: `parsePolicyFile` normalizes `**.` and skips unsupported wildcards

**Files:**
- Modify: `src/policyFile.ts`
- Test: `tests/unit/policyFile.test.ts`

**Interfaces:**
- Consumes: `WILDCARD_HOST_PATTERN` from `src/allowlist.ts` (Task 1).
- Produces: `parsePolicyFile(content: string): Allowlist` — wildcard hosts normalized `**.`→`*.` into `passthrough`; unsupported wildcard resources (e.g. `foo*.bar.com:443`) excluded from `passthrough`/`terminate` and returned sorted in `invalid[]`.

- [ ] **Step 1: Update and add the unit tests**

In `tests/unit/policyFile.test.ts`, change the first test's expected passthrough (line ~20) from `'**.chatgpt.com:443'` to `'*.chatgpt.com:443'`:

```typescript
    expect(parsePolicyFile(content)).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
```

Add a new test at the end of the `describe('parsePolicyFile', ...)` block:

```typescript
  it('normalizes **.host and skips unsupported wildcard patterns', () => {
    const content = [
      'PROVENANCE   APPLIES_TO   POLICY/RULE   TYPE      DECISION   RESOURCES',
      'local        all          svc           network   allow      **.chatgpt.com:443',
      '                                                             *.already.com:443',
      '                                                             foo*.bar.com:443',
      '                                                             api.anthropic.com:443',
    ].join('\n');

    expect(parsePolicyFile(content)).toEqual({
      passthrough: ['*.already.com:443', '*.chatgpt.com:443'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['foo*.bar.com:443'],
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/policyFile.test.ts`
Expected: FAIL — `**.chatgpt.com:443` is passed through verbatim and `foo*.bar.com:443` is not skipped.

- [ ] **Step 3: Implement normalization + skip**

Replace the top of `src/policyFile.ts` (the import and `TERMINATE_HOSTS`) so it imports the pattern and adds a local normalizer:

```typescript
import type { Allowlist } from './allowlist';
import { WILDCARD_HOST_PATTERN } from './allowlist';

const TERMINATE_HOSTS = new Set([
  'api.anthropic.com',
  'claude.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'downloads.claude.ai',
]);

function normalizeWildcardHost(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}
```

Add an `invalid` set alongside the other sets:

```typescript
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  const invalid = new Set<string>();
```

Replace the `addResource` body:

```typescript
  const addResource = (resource: string | undefined): void => {
    if (!resource) return;
    if (currentType !== 'network' || currentDecision !== 'allow') return;
    const host = resource.split(':')[0];
    if (host.includes('*')) {
      const normalizedHost = normalizeWildcardHost(host);
      if (!WILDCARD_HOST_PATTERN.test(normalizedHost)) {
        invalid.add(resource);
        return;
      }
      passthrough.add(`${normalizedHost}${resource.slice(host.length)}`);
      return;
    }
    if (TERMINATE_HOSTS.has(host)) terminate.add(resource);
    else passthrough.add(resource);
  };
```

Replace the return statement:

```typescript
  return {
    passthrough: [...passthrough].sort(),
    terminate: [...terminate].sort(),
    invalid: [...invalid].sort(),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/policyFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policyFile.ts tests/unit/policyFile.test.ts
git commit -m "feat(policy): normalize **.host to *.host and skip unsupported wildcards on import"
```

---

### Task 3: `import-sbx-network-policy` warns on skipped patterns

**Files:**
- Modify: `src/commands/importSbxNetworkPolicy.ts`
- Modify: `tests/fixtures/sample-policy.txt`
- Test: `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `parsePolicyFile` → `Allowlist.invalid[]` (Task 2).
- Produces: the command prints a stderr warning listing skipped patterns, still writes the output file, and exits 0.

- [ ] **Step 1: Update the fixture and the e2e tests**

Append an unsupported wildcard resource to `tests/fixtures/sample-policy.txt` as a continuation line under the first `network allow` rule. Change the file to:

```
PROVENANCE   APPLIES_TO      POLICY/RULE                    TYPE               DECISION   RESOURCES
local        all             default-ai-services            network            allow      **.chatgpt.com:443
                                                                                          api.anthropic.com:443
                                                                                          claude.com:443
                                                                                          foo*.bar.com:443

local        all             default-os-packages            network            allow      archive.ubuntu.com:80

local        all             default-fs-read-allow-all      filesystem:read    allow      **
```

In `tests/e2e/cli.test.ts`, update the existing "parses a policy file into current-allow-list.txt" test (lines ~42–69): change the expected `'**.chatgpt.com:443'` to `'*.chatgpt.com:443'` (the `foo*.bar.com:443` line must NOT appear in the output):

```typescript
      expect(exitCode).toBe(0);
      expect(readFileSync(join(dir, 'current-allow-list.txt'), 'utf8')).toBe(
        [
          '# passthrough',
          '*.chatgpt.com:443',
          'archive.ubuntu.com:80',
          '',
          '# terminate',
          'api.anthropic.com:443',
          'claude.com:443',
          '',
        ].join('\n'),
      );
```

Add a new test immediately after it:

```typescript
  it('warns and skips unsupported wildcard patterns but still writes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'import-sbx-network-policy', fixturePath],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toContain('foo*.bar.com:443');
      const written = readFileSync(join(dir, 'current-allow-list.txt'), 'utf8');
      expect(written).toContain('*.chatgpt.com:443');
      expect(written).not.toContain('foo*.bar.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Build and run the e2e tests to verify they fail**

Run: `pnpm build && pnpm vitest run tests/e2e/cli.test.ts`
Expected: FAIL — the import test still expects `**.chatgpt.com:443`, and the new test finds no `foo*.bar.com:443` on stderr (command emits no warning yet).

- [ ] **Step 3: Emit the warning in the command**

In `src/commands/importSbxNetworkPolicy.ts`, replace the action body (lines 15–18):

```typescript
    .action((policyFile: string, options: { output: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      writeFileSync(options.output, formatAllowlist(allowlist));
    });
```

with:

```typescript
    .action((policyFile: string, options: { output: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      if (allowlist.invalid.length > 0) {
        console.warn(
          'import-sbx-network-policy: skipping unsupported wildcard pattern(s):\n' +
            allowlist.invalid.map((entry) => `  - ${entry}`).join('\n'),
        );
      }
      writeFileSync(options.output, formatAllowlist(allowlist));
    });
```

- [ ] **Step 4: Build and run the e2e tests to verify they pass**

Run: `pnpm build && pnpm vitest run tests/e2e/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS (format, lint, typecheck, unit, build, e2e, integration all green).

- [ ] **Step 6: Commit**

```bash
git add src/commands/importSbxNetworkPolicy.ts tests/fixtures/sample-policy.txt tests/e2e/cli.test.ts
git commit -m "feat(import): warn and skip unsupported wildcard patterns on import-sbx-network-policy"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (parseAllowlist drops `**`) → Task 1.
- Spec §2 (parsePolicyFile normalizes at the boundary, skips unsupported) → Task 2.
- Spec §3 (import command warns + skips + continues, exit 0) → Task 3.
- Spec "Testing" bullets → covered across Tasks 1–3 (parsePolicyFile normalize/skip, parseAllowlist `**.`→invalid, CLI warn-but-writes).
- Spec non-goal (leave `current-allow-list.txt`) → no task touches it. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `WILDCARD_HOST_PATTERN` exported in Task 1, imported in Task 2. `Allowlist.invalid` used consistently. `normalizeWildcardHost` lives only in `policyFile.ts` after Task 2 (removed from `allowlist.ts` in Task 1). ✓

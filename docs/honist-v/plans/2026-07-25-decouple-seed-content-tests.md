# Decouple home-jq-transforms Tests From Seed Content — Implementation Plan

**Goal:** Replace two brittle tests that hardcode the literal output/content of the customizable seed `.jq` files with structural/behavioral tests that verify the *processing* of `home-jq-transforms` without pinning what settings the seed data produces.

**Architecture:** Both replacement tests reuse the existing production API in `src/homeJqTransforms.ts` (`loadManifest` and `previewTransforms`) instead of re-parsing YAML or shelling out to `jq` by hand — so the tests exercise the real code path and can't drift from production. The unit test asserts manifest↔file wiring (non-empty, duplicate-free, no orphans); the e2e test asserts every seed transform runs as valid jq and yields a JSON object.

**Tech Stack:** TypeScript, Vitest (unit config + `vitest.e2e.config.ts`), `jq` external binary (already installed: `jq-1.8.2`), `yaml` (used internally by `loadManifest`).

## Global Constraints

- **Do NOT modify `templates/home-jq-transforms/*`.** Both new tests must pass against the current *customized* seed files (which now include `chat.disableAIFeatures`). Copied verbatim from spec Testing section.
- **Reuse the production API** (`loadManifest`, `previewTransforms` from `src/homeJqTransforms.ts`) — no hand-rolled YAML parsing, no direct `spawnSync('jq', ...)` in the new tests.
- **Keep `expectedTemplateFiles` unchanged** in `tests/unit/templates.test.ts` — it still pins `vscode-settings.jq` and `claude-onboarding.jq` by name on purpose (filenames are stable packaging artifacts; only *contents* are decoupled).
- **Leave these unchanged (out of scope):** the vm-shared / vm-shared-windows script content tests in `templates.test.ts`, and the existing `'applies a transform to its target on this platform (real jq)'` e2e test in `vmApplier.test.ts`.
- **jq is an external prerequisite.** The e2e test must stay guarded by `it.skipIf(!hasJq)` (the `hasJq` const already exists in the file).

---

## File Structure

Two test files change; no production code changes.

- `tests/unit/templates.test.ts` — swap the seed-content unit test for a manifest-wiring test. Add imports: `readdirSync` (from `node:fs`), `loadManifest` (from `../../src/homeJqTransforms`).
- `tests/e2e/vmApplier.test.ts` — swap the seed-content e2e test for an object-shape test. Add import: `previewTransforms` (from `../../src/homeJqTransforms`). The `seedDir` const already exists in this file.

Tasks 1 and 2 are independent (different files, different test suites) and could be done in either order; they are ordered here to match the spec.

---

### Task 1: Structural wiring test in `tests/unit/templates.test.ts`

Replace the `'seed transforms reproduce the extracted inline jq programs'` test (currently `tests/unit/templates.test.ts:135-146`) with a manifest↔file consistency test that reuses `loadManifest`.

**Files:**

- Modify: `tests/unit/templates.test.ts` (imports at line 2; replace test body at lines 135-146)
- Test: `tests/unit/templates.test.ts` (this *is* the test file)

**Interfaces:**

- Consumes: `loadManifest(dir: string): TransformEntry[]` from `src/homeJqTransforms.ts`, where `TransformEntry = { transform: string; linux?: string; windows?: string }`. `loadManifest` reads `<dir>/manifest.yaml`, throws on malformed / non-list YAML, and (via `validateEntry`) throws if any entry's `transform` file does not exist on disk. It does **not** reject an empty list (`loadManifest` on a `[]` manifest returns `[]`).
- Consumes: `templatesDir(): string` (already imported in this file) — returns the packaged `templates/` directory.
- Produces: nothing consumed by later tasks (test-only change).

- [ ] **Step 1: Add the two new imports**

Edit the top of `tests/unit/templates.test.ts`.

Change line 2 from:

```ts
import { existsSync, readFileSync } from 'node:fs';
```

to:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
```

Then add this import immediately after the existing `import { packagedAllowlist, templatesDir } from '../../src/templates';` line (line 4):

```ts
import { loadManifest } from '../../src/homeJqTransforms';
```

- [ ] **Step 2: Replace the old test with the new wiring test**

In `tests/unit/templates.test.ts`, delete this entire test (currently lines 135-146):

```ts
  it('seed transforms reproduce the extracted inline jq programs', () => {
    const vscode = readFileSync(
      join(templatesDir(), 'home-jq-transforms', 'vscode-settings.jq'),
      'utf8',
    );
    expect(vscode).toContain('.["editor.defaultFormatter"] = "esbenp.prettier-vscode"');
    const claude = readFileSync(
      join(templatesDir(), 'home-jq-transforms', 'claude-onboarding.jq'),
      'utf8',
    );
    expect(claude).toContain('.hasCompletedOnboarding = true');
  });
```

and replace it with:

```ts
  it('home-jq-transforms manifest and .jq files are consistently wired', () => {
    const dir = join(templatesDir(), 'home-jq-transforms');
    // loadManifest parses manifest.yaml, throws on malformed/non-list YAML, and
    // asserts every entry's transform file exists on disk.
    const entries = loadManifest(dir);
    // Non-empty: loadManifest([]) returns [] without throwing, so an emptied
    // manifest must fail here rather than vacuously pass.
    expect(entries.length).toBeGreaterThan(0);
    const referenced = entries.map((e) => e.transform);
    // Duplicate-free: exactly one manifest entry per seed file.
    expect(new Set(referenced).size).toBe(referenced.length);
    // Exact set equality with the .jq files on disk: no orphaned (unreferenced)
    // files. Combined with loadManifest's existence check, this establishes a
    // one-entry-per-.jq-file relationship without asserting any settings.
    const jqFiles = readdirSync(dir).filter((f) => f.endsWith('.jq'));
    expect([...referenced].sort()).toEqual([...jqFiles].sort());
  });
```

- [ ] **Step 3: Run the new test to verify it passes against the current seed**

Run:

```bash
pnpm exec vitest run tests/unit/templates.test.ts -t "home-jq-transforms manifest and .jq files are consistently wired"
```

Expected: `Test Files 1 passed (1)`, `Tests 1 passed` (the other tests in the file are filtered out by `-t`).

- [ ] **Step 4: Prove the test has teeth (orphan detection)**

The old test was replaced with another passing test, so confirm the new assertion actually bites. Temporarily create an *unreferenced* `.jq` file in the seed folder:

```bash
printf '.\n' > templates/home-jq-transforms/_teeth-check.jq
```

Run:

```bash
pnpm exec vitest run tests/unit/templates.test.ts -t "home-jq-transforms manifest and .jq files are consistently wired"
```

Expected: FAIL. The set-equality assertion reports `_teeth-check.jq` present on disk but not referenced by the manifest (received array has an extra element vs. expected).

- [ ] **Step 5: Remove the teeth file and re-confirm green**

```bash
rm templates/home-jq-transforms/_teeth-check.jq
```

Run:

```bash
pnpm exec vitest run tests/unit/templates.test.ts -t "home-jq-transforms manifest and .jq files are consistently wired"
git status --porcelain templates/home-jq-transforms/
```

Expected: the test PASSES again, and `git status` prints nothing (the seed folder is untouched — Global Constraint satisfied).

- [ ] **Step 6: Format, lint, and typecheck the changed file**

The new imports must satisfy prettier/eslint/tsc before commit.

Run:

```bash
pnpm exec prettier --check tests/unit/templates.test.ts && pnpm exec eslint tests/unit/templates.test.ts && pnpm exec tsc --noEmit
```

Expected: all three pass with no output/errors. If prettier reports the file, run `pnpm exec prettier --write tests/unit/templates.test.ts` and re-run the check.

- [ ] **Step 7: Commit**

```bash
git add tests/unit/templates.test.ts
git commit -m "test: replace brittle home-jq seed unit test with manifest wiring check"
```

---

### Task 2: Object-shape behavioral test in `tests/e2e/vmApplier.test.ts`

Replace the `'seed transforms reproduce the former inline settings (real jq)'` test (currently `tests/e2e/vmApplier.test.ts:77-93`) — which is **currently failing** because the seed was customized with `chat.disableAIFeatures` — with a test that reuses `previewTransforms` to assert each seed transform is valid jq producing a JSON object.

**Files:**

- Modify: `tests/e2e/vmApplier.test.ts` (add import near lines 1-15; replace test body at lines 77-93)
- Test: `tests/e2e/vmApplier.test.ts` (this *is* the test file)

**Interfaces:**

- Consumes: `previewTransforms(opts: { dir: string; runJq?: JqRunner }): PreviewResult[]` from `src/homeJqTransforms.ts`. Defaults `runJq` to the real-`jq` runner. For each manifest entry it runs `jq -f <transform>` with input `'{}'` and returns a `PreviewResult`:
  `{ transform: string; linuxTarget: string | null; windowsTarget: string | null; output?: string; error?: string }`.
  On jq success `output` is set and `error` is absent; on jq failure `error` is set and `output` is absent. **`output` is typed `string | undefined`**, so a `JSON.parse` needs a non-null assertion or guard.
- Consumes: existing `seedDir` const (`tests/e2e/vmApplier.test.ts:32`) = `join(repoRoot, 'templates', 'home-jq-transforms')`, and existing `hasJq` const (line 37).
- Produces: nothing consumed by later tasks (test-only change).

- [ ] **Step 1: Observe the current failing state (starting red)**

Run the file to see the old seed test fail — this is the "previously-failing test" the spec's Testing section calls out:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/vmApplier.test.ts -t "seed transforms reproduce the former inline settings"
```

Expected: FAIL. The diff shows an unexpected `+ "chat.disableAIFeatures": true` key — the exact brittleness this change removes.

- [ ] **Step 2: Add the `previewTransforms` import**

In `tests/e2e/vmApplier.test.ts`, add this import immediately after the existing `import { join } from 'node:path';` line (line 15):

```ts
import { previewTransforms } from '../../src/homeJqTransforms';
```

(Leave the existing `spawnSync` import at line 14 in place — it is still used by the `hasJq`/`hasBash` probes at lines 37-38.)

- [ ] **Step 3: Replace the old test with the new object-shape test**

In `tests/e2e/vmApplier.test.ts`, delete this entire test (currently lines 77-93):

```ts
  it.skipIf(!hasJq)('seed transforms reproduce the former inline settings (real jq)', () => {
    const vscode = spawnSync('jq', ['-f', join(seedDir, 'vscode-settings.jq')], {
      input: '{}',
      encoding: 'utf8',
    });
    expect(JSON.parse(vscode.stdout)).toEqual({
      'files.autoSave': 'afterDelay',
      'editor.formatOnSave': true,
      'editor.defaultFormatter': 'esbenp.prettier-vscode',
      '[csharp]': { 'editor.defaultFormatter': 'csharpier.csharpier-vscode' },
    });
    const claude = spawnSync('jq', ['-f', join(seedDir, 'claude-onboarding.jq')], {
      input: '{}',
      encoding: 'utf8',
    });
    expect(JSON.parse(claude.stdout)).toEqual({ hasCompletedOnboarding: true });
  });
```

and replace it with:

```ts
  it.skipIf(!hasJq)('every seed transform is valid jq that produces a JSON object', () => {
    // previewTransforms loads manifest.yaml and runs each transform through real
    // jq with '{}' input, returning { output } on success or { error } on failure.
    const results = previewTransforms({ dir: seedDir });
    // Guard against a vacuous pass on an emptied manifest.
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      // jq exited 0 and produced output (no error path).
      expect(result.error).toBeUndefined();
      // output is typed `string | undefined`; assert it to both guard the
      // success case and satisfy the JSON.parse below.
      expect(result.output).toBeDefined();
      const parsed = JSON.parse(result.output!);
      // A settings file must be a JSON object. Reject null and arrays (both
      // report typeof 'object'), then reject scalars. No-op `.` and `{}` yield
      // the empty object and intentionally pass; no assertion on keys/values.
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
      expect(typeof parsed).toBe('object');
    }
  });
```

- [ ] **Step 4: Run the new test to verify it passes against the current seed**

Run:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/vmApplier.test.ts -t "every seed transform is valid jq that produces a JSON object"
```

Expected: `Test Files 1 passed (1)`, `Tests 1 passed`. (Both current seed transforms produce objects, so the test is green even though the seed now includes `chat.disableAIFeatures`.)

- [ ] **Step 5: Prove the test has teeth (non-object rejection)**

Confirm the object-shape assertion actually bites. Temporarily overwrite one seed transform so it emits an array instead of an object (this edit is reverted from git in Step 6, so the seed file is never permanently changed):

```bash
printf '[.hasCompletedOnboarding = true]\n' > templates/home-jq-transforms/claude-onboarding.jq
```

Run:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/vmApplier.test.ts -t "every seed transform is valid jq that produces a JSON object"
```

Expected: FAIL on `expect(Array.isArray(parsed)).toBe(false)` for the `claude-onboarding.jq` result — proving the object-shape check has teeth.

- [ ] **Step 6: Revert the seed edit and re-confirm green**

Restore the seed file from git (never hand-edit it back — Global Constraint forbids modifying `templates/home-jq-transforms/*`):

```bash
git checkout -- templates/home-jq-transforms/claude-onboarding.jq
```

Run:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/vmApplier.test.ts -t "every seed transform is valid jq that produces a JSON object"
git status --porcelain templates/home-jq-transforms/
```

Expected: the test PASSES again, and `git status` prints nothing (seed folder untouched).

- [ ] **Step 7: Format, lint, and typecheck the changed file**

Run:

```bash
pnpm exec prettier --check tests/e2e/vmApplier.test.ts && pnpm exec eslint tests/e2e/vmApplier.test.ts && pnpm exec tsc --noEmit
```

Expected: all three pass. If prettier reports the file, run `pnpm exec prettier --write tests/e2e/vmApplier.test.ts` and re-run.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/vmApplier.test.ts
git commit -m "test: replace brittle home-jq seed e2e test with object-shape check"
```

---

### Task 3: Full-suite verification

Confirm both changes integrate and the whole suite is green — including the previously-failing e2e test — per the spec's Testing section.

**Files:**

- None modified. This task is the integration gate across Tasks 1-2.

**Interfaces:**

- Consumes: the committed changes from Tasks 1 and 2.
- Produces: proof the full suite passes; no code deliverable.

- [ ] **Step 1: Confirm the working tree is clean**

```bash
git status --porcelain
```

Expected: no output (both test edits committed; no stray `_teeth-check.jq` or seed modifications left behind).

- [ ] **Step 2: Run the full test pipeline**

This runs format:check, lint, typecheck, unit tests, build, e2e tests, and integration tests (see `package.json` `test` script).

```bash
pnpm test
```

Expected: the entire pipeline passes. In particular the e2e suite is green (the `chat.disableAIFeatures` failure is gone) and `tests/unit/templates.test.ts` / `tests/e2e/vmApplier.test.ts` both report their new test names passing.

- [ ] **Step 3: No commit needed**

Task 3 changes no files. If `pnpm test` surfaced a formatting/lint issue that required an edit, fold that fix into the relevant task's commit (amend or a follow-up `test:` commit) rather than leaving the tree dirty.

---

## Notes for the implementer

- **Why reuse `loadManifest` / `previewTransforms` instead of parsing YAML or calling `jq` directly?** These are the exact functions production uses to load the manifest and run transforms. Reusing them means the tests validate the real code path and cannot drift from production behavior — and it keeps the tests short. Do not reintroduce `spawnSync('jq', ...)` or a `yaml` parse in the new tests.
- **Why not assert specific settings keys/values?** That is precisely the fragility being removed. The seed `.jq` files are a customizable surface maintainers edit over time (that is how `chat.disableAIFeatures` got added). The new tests assert only that processing works and the output is object-shaped.
- **Why does the teeth step (Task 1 Step 4, Task 2 Step 5) exist?** Both tasks replace a test with another test rather than adding new production code, so there is no natural red-before-green. The teeth steps temporarily violate the invariant to prove each new assertion actually fails when it should — the equivalent of TDD's "watch it fail." Always revert immediately (Task 1 Step 5, Task 2 Step 6) and confirm `git status` shows the seed folder untouched.

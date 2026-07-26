# Relocate Test Environment Implementation Plan

**Goal:** Move the integration and VM test suites' `.configamatron` environment from the repo root to `test-results/.configamatron`, sourced from one shared `tests/testEnvRoot.ts` helper, so coding agents stop mistaking test residue for a live deployment.

**Architecture:** A new `tests/testEnvRoot.ts` module becomes the single source of truth for the test environment location (`repoRoot`, `envParent`, `envRoot`). Every suite that today builds `.configamatron` at the repo root imports these constants, invokes the CLI with `cwd: envParent` (`<repo>/test-results`) instead of `cwd: repoRoot`, and creates `envParent` before use. No production code changes — `ENV_DIR_NAME` stays `.configamatron`; only the test working directory moves.

**Tech Stack:** TypeScript, Vitest, execa, Node's `node:fs`/`node:path`/`node:url`. Package scripts: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:integration`, `pnpm test:vm`, `pnpm test:unit`, `pnpm test:e2e`.

## Global Constraints

- The environment directory name is unchanged: `ENV_DIR_NAME = '.configamatron'` in `src/envPaths.ts`. Do **not** modify production code.
- The relocated environment root is exactly `<repo>/test-results/.configamatron`; its parent (`envParent`) is `<repo>/test-results`.
- `test-results/` and `.configamatron/` are already gitignored — no `.gitignore` change is required.
- Every CLI invocation (`init`, `generate-ca`, `run-proxy`) that currently passes `cwd: repoRoot` must move to `cwd: envParent` — including launch helpers defined outside `beforeAll`, not just the first setup call.
- `docker compose down` calls that pass `cwd: proxyDir` (or `stack.proxyDir`) stay unchanged — `proxyDir` already tracks the relocated env.
- `envParent` must exist before the first `execa`/`rmEnvRoot`: call `mkdirSync(envParent, { recursive: true })` first (execa errors on a missing `cwd`, and a clean checkout has no `test-results/`).
- The repo uses TypeScript `strict` and ESLint; remove any import or `const` that these edits leave unused so `pnpm lint`/`pnpm typecheck` stay green.

---

### Task 1: Create the shared `tests/testEnvRoot.ts` helper

**Files:**

- Create: `tests/testEnvRoot.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: three exported string constants — `repoRoot` (absolute path to the repo root), `envParent` (`<repoRoot>/test-results`), `envRoot` (`<envParent>/.configamatron`). All later tasks import from this module.

- [ ] **Step 1: Write the helper module**

`tests/testEnvRoot.ts`:

```typescript
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Single source of truth for where the integration and VM suites build their
 * `.configamatron` test environment. It lives under `test-results/` (already
 * gitignored, already the VM suite's artifact home) rather than the repo root,
 * so the residue plainly reads as throwaway test output instead of a live
 * configamatron deployment. See
 * docs/honist-v/specs/2026-07-25-relocate-test-environment-design.md.
 */

// This file is at <repo>/tests/, so one `..` reaches the repo root.
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const envParent = join(repoRoot, 'test-results');
export const envRoot = join(envParent, '.configamatron');
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add tests/testEnvRoot.ts
git commit -m "test: add shared testEnvRoot helper (test-results/.configamatron)"
```

---

### Task 2: Migrate `tests/proxyStack.ts` to the relocated environment

**Files:**

- Modify: `tests/proxyStack.ts`

**Interfaces:**

- Consumes: `repoRoot`, `envParent`, `envRoot` from `./testEnvRoot` (Task 1).
- Produces: no signature change. `startProxyStack()` still returns a `ProxyStack` whose `proxyDir` now resolves under `test-results/.configamatron/proxy`. The VM suite (Task 4) relies on this relocation.

- [ ] **Step 1: Replace the local path derivation with the shared import**

In `tests/proxyStack.ts`, delete the unused `node:url` import (line 4):

```typescript
import { fileURLToPath } from 'node:url';
```

Add `mkdirSync` to the `node:fs` import (line 3), changing:

```typescript
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
```

to:

```typescript
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
```

Add an import of the shared helper alongside the other imports (e.g. just below the `rmEnvRoot` import):

```typescript
import { repoRoot, envParent, envRoot } from './testEnvRoot';
```

Then delete the now-redundant local derivations (current lines 17 and 22):

```typescript
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
```

and

```typescript
const envRoot = join(repoRoot, '.configamatron');
```

Leave lines 18–21 (`cliPath`, `allowlistFixture`, `credentialsFixture`, `authFixture`) exactly as they are — they use the imported `repoRoot`.

- [ ] **Step 2: Create `envParent` before rebuilding the environment**

In `startProxyStack()`, find (current line ~124):

```typescript
  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  await rmEnvRoot(envRoot);
```

Change it to:

```typescript
  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
```

- [ ] **Step 3: Point the three CLI invocations at `envParent`**

In `startProxyStack()`, change the `cwd` of the `init` call (current line ~128) from `{ cwd: repoRoot }` to `{ cwd: envParent }`:

```typescript
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );
```

Change the `generate-ca` call (current line ~135):

```typescript
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });
```

Change the `run-proxy` call's options object (current line ~164) from `{ cwd: repoRoot, env: composeEnv, buffer: false, reject: false }` to:

```typescript
    { cwd: envParent, env: composeEnv, buffer: false, reject: false },
```

Leave the `docker compose down` call in `stopProxyStack()` (`cwd: stack.proxyDir`) unchanged.

- [ ] **Step 4: Verify typecheck and lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (no unused `repoRoot`/`fileURLToPath`, no type errors).

- [ ] **Step 5: Commit**

```bash
git add tests/proxyStack.ts
git commit -m "test: relocate proxyStack env to test-results/.configamatron"
```

---

### Task 3: Migrate the four integration test files

All four `tests/integration/*.test.ts` files self-initialize the environment (none uses `startProxyStack()`), so each gets the same treatment: import `envParent`/`envRoot`, remove the now-unused local `repoRoot`, add the `mkdirSync(envParent, …)` guard, and repoint every `cwd: repoRoot` CLI call to `cwd: envParent`. `proxyDir` stays `join(envRoot, 'proxy')` and every `docker compose down` (`cwd: proxyDir`) stays unchanged.

**Files:**

- Modify: `tests/integration/runProxy.test.ts`
- Modify: `tests/integration/runProxyRobustness.test.ts`
- Modify: `tests/integration/codexInjection.test.ts`
- Modify: `tests/integration/githubInjection.test.ts`

**Interfaces:**

- Consumes: `envParent`, `envRoot` from `../testEnvRoot` (Task 1).
- Produces: no exported interface (these are leaf test files).

- [ ] **Step 1: Migrate `runProxy.test.ts`**

Add `mkdirSync` to the `node:fs` import (line 4):

```typescript
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
```

Add the shared import near the other imports:

```typescript
import { envParent, envRoot } from '../testEnvRoot';
```

Delete the local `repoRoot` line (line 13) and the local `envRoot` line (line 18):

```typescript
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
```

and

```typescript
const envRoot = join(repoRoot, '.configamatron');
```

Keep line 19 (`const proxyDir = join(envRoot, 'proxy');`) — it now uses the imported `envRoot`. Note `cliPath`, `allowlistFixture`, `credentialsFixture`, `authFixture` (lines 14–17) already derive from `import.meta.url`, so removing `repoRoot` leaves them intact. `fileURLToPath` stays imported (still used by those lines).

In `beforeAll`, change (current line ~88):

```typescript
  await rmEnvRoot(envRoot);
```

to:

```typescript
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
```

Change the `init` call `cwd` (line ~92) from `{ cwd: repoRoot }` to `{ cwd: envParent }`; change the `generate-ca` call (line ~95) to `await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });`; and change the `run-proxy` options (line ~111) from `{ cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }` to `{ cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }`. Leave the `afterAll` `docker compose down` (`cwd: proxyDir`) unchanged.

- [ ] **Step 2: Migrate `runProxyRobustness.test.ts` (four CLI calls — two are launch helpers)**

Add `mkdirSync` to the `node:fs` import (line 4):

```typescript
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
```

Add the shared import:

```typescript
import { envParent, envRoot } from '../testEnvRoot';
```

Delete the local `repoRoot` line (line 13) and the local `envRoot` line (line 18), exactly as in Step 1. Keep `const proxyDir = join(envRoot, 'proxy');` (line 19).

Change the `run-proxy` options inside `spawnProxy()` (current line ~76) from `{ cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }` to `{ cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }`.

Change the `run-proxy` options inside `spawnProxyPlain()` (current line ~99) the same way, to `{ cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }`.

In `beforeAll`, change (current line ~141):

```typescript
  await rmEnvRoot(envRoot);
```

to:

```typescript
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
```

Change the `init` call `cwd` (line ~145) from `{ cwd: repoRoot }` to `{ cwd: envParent }`, and the `generate-ca` call (line ~148) to `await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });`. Leave both `afterEach`/`afterAll` `docker compose down` calls (`cwd: proxyDir`) unchanged.

- [ ] **Step 3: Migrate `codexInjection.test.ts`**

Add `mkdirSync` to the `node:fs` import (line 6):

```typescript
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
```

Add the shared import:

```typescript
import { envParent, envRoot } from '../testEnvRoot';
```

Delete the local `repoRoot` line (line 16) and the local `envRoot` line (line 20). Keep `const proxyDir = join(envRoot, 'proxy');` (line 21).

In `beforeAll`, change (current line ~125):

```typescript
  await rmEnvRoot(envRoot);
```

to:

```typescript
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
```

Change the `init` call `cwd` (line ~129) from `{ cwd: repoRoot }` to `{ cwd: envParent }`; change the `generate-ca` call (line ~143) to `await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });`; change the `run-proxy` options (line ~161) from `{ cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }` to `{ cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }`. Leave the `docker compose down` call (`cwd: proxyDir`) unchanged.

- [ ] **Step 4: Migrate `githubInjection.test.ts`**

The `node:fs` import (line 5) already includes `mkdirSync` — leave it. Add the shared import:

```typescript
import { envParent, envRoot } from '../testEnvRoot';
```

Delete the local `repoRoot` line (line 16) and the local `envRoot` line (line 20). Keep `const proxyDir = join(envRoot, 'proxy');` (line 21).

In `beforeAll`, change (current line ~114):

```typescript
  await rmEnvRoot(envRoot);
```

to:

```typescript
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
```

Change the `init` call `cwd` (line ~118) from `{ cwd: repoRoot }` to `{ cwd: envParent }`; change the `generate-ca` call (line ~127) to `await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });`; change the `run-proxy` options (line ~157) from `{ cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }` to `{ cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false }`. The mid-`beforeAll` `mkdirSync(join(proxyDir, 'secrets'), …)` and both `writeFileSync` secret writes stay as-is (they now resolve under the relocated `proxyDir`). Leave the `docker compose down` call (`cwd: proxyDir`) unchanged.

- [ ] **Step 5: Verify no repo-root env references remain and the suite compiles**

Run: `git grep -n "cwd: repoRoot" -- tests/integration/`
Expected: no output.

Run: `git grep -n "join(repoRoot, '.configamatron')" -- tests/integration/`
Expected: no output.

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Run the integration suite (requires Docker Desktop)**

Run: `pnpm test:integration`
Expected: PASS (all four integration files green).

If Docker is unavailable in this environment, skip the run and note it — Steps 5 (typecheck/lint/grep) are the mandatory gate; the integration run is verified in Task 6.

- [ ] **Step 7: Confirm the environment was built in the new location, not the repo root**

After a run (or during Task 6), verify (commands are PowerShell, the repo's primary shell):

Run: `Test-Path test-results/.configamatron/proxy/envoy.yaml`
Expected: `True` (environment built under `test-results/`).

Run: `if (Test-Path .configamatron) { 'PRESENT (investigate)' } else { 'absent (good)' }`
Expected: `absent (good)` — the run created no repo-root environment. A `.configamatron` that pre-existed this run is out of scope (see Task 6 Step 2): it means a manual or stale environment was already present, not that the test wrote to the repo root — do not delete it here.

- [ ] **Step 8: Commit**

```bash
git add tests/integration/runProxy.test.ts tests/integration/runProxyRobustness.test.ts tests/integration/codexInjection.test.ts tests/integration/githubInjection.test.ts
git commit -m "test: relocate integration env to test-results/.configamatron"
```

---

### Task 4: Migrate `tests/vm/vm.test.ts`

The VM suite builds its environment via `startProxyStack()` (already relocated in Task 2), then reads `vm-shared` back with a hardcoded repo-root path. Point that read at the shared `envRoot`.

**Files:**

- Modify: `tests/vm/vm.test.ts`

**Interfaces:**

- Consumes: `envRoot` from `../testEnvRoot` (Task 1); `startProxyStack` etc. from `../proxyStack` (unchanged import).
- Produces: no exported interface.

- [ ] **Step 1: Import the shared `envRoot`**

Add to the imports (e.g. just below the `../proxyStack` import block):

```typescript
import { envRoot } from '../testEnvRoot';
```

Leave the local `repoRoot` (line 19) as-is — it is still used to build `artifactsDir` (`join(repoRoot, 'test-results', 'vm', …)`).

- [ ] **Step 2: Read `vm-shared` from the relocated env**

Change (current line 84):

```typescript
  const wslVmShared = await wslPath(join(repoRoot, '.configamatron', 'vm-shared'));
```

to:

```typescript
  const wslVmShared = await wslPath(join(envRoot, 'vm-shared'));
```

- [ ] **Step 3: Verify no repo-root env reference remains and it compiles**

Run: `git grep -n "'.configamatron'" -- tests/vm/`
Expected: no output.

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Run the VM suite (requires WSL2 + Hyper-V; optional)**

Run: `pnpm test:vm`
Expected: PASS, with the guest's `vm-shared` share resolving from `test-results/.configamatron/vm-shared`.

If the VM environment is unavailable, skip the run and note it — Step 3 is the mandatory gate.

- [ ] **Step 5: Commit**

```bash
git add tests/vm/vm.test.ts
git commit -m "test: read vm-shared from relocated test-results/.configamatron"
```

---

### Task 5: Update the `AGENTS.md` residue note

**Files:**

- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: nothing.
- Produces: documentation only.

- [ ] **Step 1: Rewrite the residue note**

In `AGENTS.md`, replace this line:

```markdown
The .configamatron folder in this project does not represent a long-running deployment of configamatron- it is only test residue.
```

with:

```markdown
The test suites build their throwaway configamatron environment under `test-results/.configamatron` (gitignored test residue), not at the repository root. A bare `.configamatron` at the repository root is not created by normal test runs and does not represent a long-running deployment. If you find one, do not assume it is disposable — it may be an environment someone created by running the CLI manually. Leave it alone unless you know it is stale test residue.
```

- [ ] **Step 2: Verify formatting**

Run: `pnpm format:check`
Expected: PASS (or, if it flags `AGENTS.md`, run `pnpm format` to rewrite it, then re-run `pnpm format:check`).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: point AGENTS.md residue note at test-results/.configamatron"
```

---

### Task 6: Full-suite verification and repo-root cleanliness gate

Final gate confirming the whole change holds together and nothing writes to the repo root.

**Files:**

- None (verification only).

**Interfaces:**

- Consumes: all prior tasks.
- Produces: nothing.

- [ ] **Step 1: Global grep — no repo-root env derivation survives anywhere in tests**

Run: `git grep -n "join(repoRoot, '.configamatron')" -- tests/`
Expected: no output.

Run: `git grep -n "cwd: repoRoot" -- tests/proxyStack.ts tests/integration/ tests/vm/`
Expected: no output. (Scope is limited to the in-scope files on purpose: `tests/e2e/vmApplier.test.ts` legitimately keeps `cwd: repoRoot` for its `pnpm pack --dry-run` call, which builds no environment and must not be relocated — grepping all of `tests/` would flag it as a false positive.)

- [ ] **Step 2: Clear stale repo-root residue — only if you are sure it is stale**

If a `.configamatron` directory exists at the repo root **and** you are certain it is leftover test residue (not an environment someone created manually with the CLI), remove it so Step 4's check is meaningful:

Run (PowerShell): `if (Test-Path .configamatron) { Remove-Item -Recurse -Force .configamatron }`

It is gitignored and, if it was test residue, is rebuilt by the suites. If you are not certain it is stale, skip this step and account for the pre-existing directory when reading Step 4 — do not delete a directory you did not create.

- [ ] **Step 3: Run the Docker-free suites, then the integration suite**

Run: `pnpm test:unit && pnpm test:e2e`
Expected: PASS (these suites were already isolated in `tmpdir` and must be unaffected).

Run: `pnpm test:integration` (requires Docker Desktop)
Expected: PASS.

If Docker is unavailable, note it and rely on the typecheck/lint/grep gates plus the unit/e2e runs.

- [ ] **Step 4: Confirm the repo root stayed clean**

Run (PowerShell): `if (Test-Path .configamatron) { 'PRESENT (investigate)' } else { 'absent (good)' }`
Expected: `absent (good)` — the integration run built its environment under `test-results/.configamatron`, leaving the repo root clean. (If Step 2 was skipped because a manual environment already exists there, `PRESENT` is expected — confirm the run did not modify it rather than treating this as a failure.)

Run (PowerShell): `Get-ChildItem test-results/.configamatron`
Expected: the environment directory contents (e.g. `proxy/`, `vm-shared/`) exist.

- [ ] **Step 5: Commit (only if Step 2 or verification produced tracked changes)**

Normally there is nothing to commit here (all edits landed in Tasks 1–5, and `.configamatron`/`test-results` are gitignored). If `git status` shows tracked changes, review them before committing; otherwise this task is a verification-only gate with no commit.

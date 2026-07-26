# Relocate the test environment out of the repo root

## Problem

The integration and VM test suites build a real `.configamatron` environment at
the **repository root** (`<repo>/.configamatron`) and leave it there as residue.
Coding agents working in the repo mistake this folder for a live, ongoing
configamatron deployment: they inspect its health, or try to update its files,
outside of any test. `AGENTS.md` already documents that the folder "does not
represent a long-running deployment … it is only test residue," but that
doc-based mitigation is insufficient — the bare `.configamatron` at the repo
root still reads as an active environment.

## Goal

Stop the test suites from creating `.configamatron` at the repo root. Move the
test environment into `test-results/`, an already-gitignored directory that is
already the VM suite's artifact home — a location that plainly reads as
throwaway test output. A bare `.configamatron` should not appear at the repo
root during normal test runs.

## Scope

Only the two suites that write to the repo root are in scope:

- **Integration** — `tests/proxyStack.ts` and the four
  `tests/integration/*.test.ts` files (`runProxy`, `runProxyRobustness`,
  `codexInjection`, `githubInjection`).
- **VM** — `tests/vm/vm.test.ts`.

The **unit** and **e2e** suites already isolate into `mkdtempSync(tmpdir(), …)`
and never touch the repo root; they are unchanged. No production code changes:
`ENV_DIR_NAME` stays `.configamatron` — only the test working directory moves.

## Current state

The repo-root env path is computed independently in **six** places, each
recreating `join(repoRoot, '.configamatron')`:

- `tests/proxyStack.ts` — `envRoot`, then runs the CLI with `cwd: repoRoot`.
- `tests/integration/runProxy.test.ts` — own `envRoot`/`proxyDir`, own
  `rmEnvRoot(envRoot)` + `execa(init, { cwd: repoRoot })`.
- `tests/integration/runProxyRobustness.test.ts` — own `envRoot`/`proxyDir`,
  own setup with `cwd: repoRoot`.
- `tests/integration/codexInjection.test.ts` — own `envRoot`/`proxyDir`; uses
  `startProxyStack()` for setup and `envRoot` for assertions.
- `tests/integration/githubInjection.test.ts` — same shape as codexInjection.
- `tests/vm/vm.test.ts:84` — reads `join(repoRoot, '.configamatron', 'vm-shared')`
  back after `startProxyStack()` builds it.

This duplication is the drift risk: each file independently decides where the
env lives, so a future test can silently re-introduce a repo-root
`.configamatron`.

### Constraints that make the move safe

- `.configamatron/` is gitignored (never committed); this is purely on-disk
  residue.
- `templates/proxy/docker-compose.yml` uses **relative** bind mounts
  (`./envoy.yaml`, `./ca`, `./secrets`, …) resolved against the proxy dir, so
  the environment can physically live anywhere Docker Desktop can share
  (anywhere under `C:` with the WSL2 backend). The proxy dir moves with the env.
- The CLI derives everything from `envPaths(process.cwd())`; it reads no repo
  files relative to `cwd` (`cliPath` and all fixtures are absolute). So changing
  the invocation `cwd` only changes where `.configamatron` lands.

## Design

Relocate the environment to **`<repo>/test-results/.configamatron`** and
centralize the path in one shared helper so it cannot drift.

### New location

The suites invoke the CLI with `cwd = <repo>/test-results`, so `envPaths(cwd)`
drops `.configamatron` under `test-results/`. The environment root becomes
`<repo>/test-results/.configamatron`; the proxy dir becomes
`<repo>/test-results/.configamatron/proxy`.

- `test-results/` is already gitignored and already holds VM artifacts under
  `test-results/vm/<timestamp>`, so this reuses an established
  "throwaway test output" location. Placed directly at
  `test-results/.configamatron`, it sits beside `test-results/vm/`; the two
  never collide because the integration and VM suites run as separate,
  non-concurrent vitest invocations.
- **Parent must exist first:** `execa` errors when its `cwd` does not exist, and
  a clean checkout has no `test-results/`. Each setup therefore calls
  `mkdirSync(envParent, { recursive: true })` before the first `execa`
  (and before `rmEnvRoot`).

### Shared constants helper

Add `tests/testEnvRoot.ts` as the single source of truth:

```
// tests/testEnvRoot.ts
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const envParent = join(repoRoot, 'test-results');
export const envRoot = join(envParent, '.configamatron');
```

`proxyStack.ts`, the four integration test files, and `vm.test.ts` import
`envRoot`/`envParent` (and `repoRoot` where still needed) from this module
instead of recomputing `join(repoRoot, '.configamatron')`. This removes the
six-way duplication so the location cannot drift again, matching the existing
shared-test-helper pattern (`rmEnvRoot.ts`, `proxyStack.ts`).

Note the URL base: `testEnvRoot.ts` lives in `tests/`, so `new URL('..', …)`
resolves to the repo root — one `..`, unlike the integration files (in
`tests/integration/`, two levels down) which currently use `'../..'`. The helper
owns this so callers no longer count directory levels.

### Files touched

- **New — `tests/testEnvRoot.ts`:** exports `repoRoot`, `envParent`, `envRoot`.
- **`tests/proxyStack.ts`:** import `envRoot`/`envParent`; drop the local
  `repoRoot`/`envRoot` derivation used for the env path (keep `repoRoot`/absolute
  derivations for `cliPath` and fixtures, sourced from the helper's `repoRoot`);
  change the four `execa(… { cwd: repoRoot })` calls to `cwd: envParent`; add
  `mkdirSync(envParent, { recursive: true })` before `rmEnvRoot(envRoot)`.
- **`tests/integration/runProxy.test.ts` and `runProxyRobustness.test.ts`:**
  replace the local `const envRoot = join(repoRoot, '.configamatron')` with the
  import; change their setup `execa(… { cwd: repoRoot })` calls to
  `cwd: envParent`; add the `mkdirSync(envParent, …)` guard before their
  `rmEnvRoot`/init.
- **`tests/integration/codexInjection.test.ts` and `githubInjection.test.ts`:**
  replace the local `envRoot`/`proxyDir` derivation with the shared `envRoot`
  (these use `startProxyStack()` for setup, which already does the `mkdirSync`
  and `cwd: envParent`; they need `envRoot` only for assertions). Confirm they no
  longer keep a now-unused local `repoRoot`.
- **`tests/vm/vm.test.ts`:** derive the `vm-shared` path from the shared
  `envRoot` (`join(envRoot, 'vm-shared')`) instead of the hardcoded
  `join(repoRoot, '.configamatron', 'vm-shared')`. The `test-results/vm/…`
  artifact path is unrelated and stays.

### Documentation

- **`AGENTS.md`:** update the residue note to state that the suites now write
  the test environment to `test-results/.configamatron`, and that a bare
  `.configamatron` at the repo root should not appear during normal runs.
- **Root `.gitignore`:** keep the existing `.configamatron/` entry as
  belt-and-suspenders for a developer who runs the CLI manually at the repo root.
  `test-results/` already covers the new location.

## Trade-offs

- **Centralize vs. minimal per-file edit.** A shared helper is chosen over
  editing the string in each of the six spots. Both touch a similar number of
  lines, but the helper eliminates the duplication that let the path drift and
  prevents a future test from silently re-adding a repo-root `.configamatron` —
  worth the one new file.
- **Repo-local `test-results/` vs. fully out-of-repo `tmpdir`.** Placing the env
  under `test-results/` (rather than `os.tmpdir()`) keeps residue easy to inspect
  after a failing integration/VM run and close to the repo, at the cost of a
  `.configamatron` folder still existing on disk — nested under an
  obviously-ephemeral parent rather than bare at the root. This is the accepted
  balance: the confusion came from the *repo-root* placement, not from the
  folder existing at all.

## Testing

- Run `pnpm test:integration` and confirm: the environment is created under
  `test-results/.configamatron`, **no** `.configamatron` appears at the repo
  root, and the suite stays green.
- Where the environment allows, run the VM suite (`pnpm test:vm` or equivalent)
  and confirm the guest's `vm-shared` share resolves from
  `test-results/.configamatron/vm-shared` and the suite stays green.
- Confirm unit and e2e suites are unaffected (`pnpm test`).

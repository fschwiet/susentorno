# DNS Responder Read-Only Build Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shipped C# DNS responder inside the guest VM without writing to the read-only VMware share, and stop copying `bin`/`obj` build artifacts into the environment.

**Architecture:** Two independent changes. (1) `src/initEnv.ts` gains a `cpSync` filter that drops any `bin`/`obj` directory under `dns-responder` so stale local build output never reaches `.configamatron/vm-shared-windows`. (2) `07-setup-network.ps1` copies the responder source from the read-only share into a writable build dir (`C:\ProgramData\configamatron\dns-responder-build`) and runs `dotnet publish` from there, so all `obj`/`bin` intermediates land in a writable location.

**Tech Stack:** TypeScript (Node `fs.cpSync`), Vitest, PowerShell, .NET SDK (in-guest).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-dns-responder-readonly-build-design.md`.
- Install/publish output dir (unchanged): `C:\ProgramData\configamatron\dns-responder`.
- New writable build/scratch dir: `C:\ProgramData\configamatron\dns-responder-build`.
- The `cpSync` filter must KEEP `dns-responder/Program.cs` and `dns-responder/ConfigamatronDnsResponder.csproj` (asserted by `tests/unit/templates.test.ts` and `tests/unit/initEnv.test.ts`); only `bin`/`obj` are dropped.
- `07-setup-network.ps1` must retain these substrings (asserted by `templates.test.ts`): `Register-ScheduledTask`, `ConfigamatronDnsResponder`, `responder-config.txt`, `Set-DnsClientServerAddress`, `'127.0.0.1'`.
- Commit after each task. Repo commit style: lowercase `fix:` / `test:` prefixes.
- Run a single unit test file with: `pnpm exec vitest run <path>`.

---

### Task 1: Stop copying `bin`/`obj` into the environment

**Files:**
- Modify: `src/initEnv.ts:44-47` (the `vm-shared-windows` `cpSync` call)
- Test: `tests/unit/initEnv.test.ts`

**Interfaces:**
- Consumes: `initEnvironment(options)` — existing signature, unchanged.
- Produces: no new exports. Behavior change only: `cpSync` for `vm-shared-windows` now skips any path with a `bin` or `obj` segment beneath `dns-responder`.

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe('initEnvironment', ...)` block in `tests/unit/initEnv.test.ts`. It creates real `bin`/`obj` fixture dirs under the templates `dns-responder` folder (both are gitignored, so this does not dirty the tree), runs init, and asserts they were not copied. `mkdirSync` and `rmSync` are already imported at the top of the file except `mkdirSync` — add it to the existing `node:fs` import.

First extend the import line at the top of the file:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

Then add the test:

```ts
  it('does not copy dns-responder bin/obj build artifacts into vm-shared-windows', () => {
    const templateDnsDir = join(templatesDir(), 'vm-shared-windows', 'dns-responder');
    const binFixture = join(templateDnsDir, 'bin');
    const objFixture = join(templateDnsDir, 'obj');
    // bin/ and obj/ are gitignored, so creating them here does not dirty the repo.
    mkdirSync(binFixture, { recursive: true });
    mkdirSync(objFixture, { recursive: true });
    writeFileSync(join(binFixture, 'stale.dll'), 'x');
    writeFileSync(join(objFixture, 'stale.json'), 'x');
    try {
      initEnvironment(options());
      const copiedDns = join(dir, ENV_DIR_NAME, 'vm-shared-windows', 'dns-responder');
      expect(existsSync(join(copiedDns, 'bin')), 'bin should not be copied').toBe(false);
      expect(existsSync(join(copiedDns, 'obj')), 'obj should not be copied').toBe(false);
      // The source files must still be copied.
      expect(existsSync(join(copiedDns, 'Program.cs'))).toBe(true);
      expect(existsSync(join(copiedDns, 'ConfigamatronDnsResponder.csproj'))).toBe(true);
    } finally {
      rmSync(binFixture, { recursive: true, force: true });
      rmSync(objFixture, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/initEnv.test.ts`
Expected: FAIL — the new test errors on `expect(existsSync(join(copiedDns, 'bin'))).toBe(false)` because the current `cpSync` copies `bin`/`obj`.

- [ ] **Step 3: Add the filter to `initEnv.ts`**

Replace the `vm-shared-windows` copy call (currently `src/initEnv.ts:45-47`):

```ts
  cpSync(join(options.templatesDir, 'vm-shared-windows'), paths.vmSharedWindows, {
    recursive: true,
  });
```

with a filtered copy. Add this module-level helper just above the `initEnvironment` function (after the imports / interface):

```ts
/**
 * Reject dns-responder build artifacts (bin/obj) so a developer's local build output
 * never gets copied onto the read-only VM share. cpSync copies straight off disk and
 * ignores gitignore, so the filter is the only guard.
 */
export function isDnsResponderBuildArtifact(source: string): boolean {
  const segments = source.split(/[\\/]/);
  const dnsIdx = segments.indexOf('dns-responder');
  if (dnsIdx === -1) return false;
  return segments.slice(dnsIdx + 1).some((s) => s === 'bin' || s === 'obj');
}
```

and change the copy call to:

```ts
  cpSync(join(options.templatesDir, 'vm-shared-windows'), paths.vmSharedWindows, {
    recursive: true,
    filter: (source) => !isDnsResponderBuildArtifact(source),
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/initEnv.test.ts`
Expected: PASS — all initEnvironment tests, including the new artifact test.

Also run the templates test to confirm nothing regressed:
Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/initEnv.ts tests/unit/initEnv.test.ts
git commit -m "fix: stop copying dns-responder bin/obj into the VM share"
```

---

### Task 2: Publish the responder from a writable build dir

**Files:**
- Modify: `templates/vm-shared-windows/07-setup-network.ps1:18-21`
- Test: `tests/unit/templates.test.ts` (content assertion)

**Interfaces:**
- Consumes: nothing new. The script still reads its source from `$scriptDir\dns-responder` on the read-only share.
- Produces: publish output at `C:\ProgramData\configamatron\dns-responder` (unchanged); intermediate build output isolated in `C:\ProgramData\configamatron\dns-responder-build`.

- [ ] **Step 1: Write the failing test**

Add this assertion to the existing `it('windows DNS redirect wires responder to the host IP and adapter DNS', ...)` test in `tests/unit/templates.test.ts`, after the existing `net` assertions (the block that reads `07-setup-network.ps1` into `net`):

```ts
    // The responder is built from a writable scratch dir, not published directly from
    // the read-only share (which cannot hold dotnet's obj/ intermediates).
    expect(net).toContain('dns-responder-build');
    expect(net).toContain('Copy-Item');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: FAIL — `expect(net).toContain('dns-responder-build')` fails; the script does not yet reference the build dir.

- [ ] **Step 3: Edit `07-setup-network.ps1`**

Replace the current block (`templates/vm-shared-windows/07-setup-network.ps1:18-21`):

```powershell
# 1) Publish the shipped C# catch-all DNS responder to a stable location.
$installDir = 'C:\ProgramData\configamatron\dns-responder'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
dotnet publish (Join-Path $scriptDir 'dns-responder') -c Release -o $installDir
```

with:

```powershell
# 1) Publish the shipped C# catch-all DNS responder to a stable location.
#    dotnet publish writes obj/ intermediates into the *source* project dir, but this
#    script runs from the read-only VMware share. Copy the source to a writable build
#    dir first and publish from there, so nothing writes back to the share.
$installDir = 'C:\ProgramData\configamatron\dns-responder'
$buildDir = 'C:\ProgramData\configamatron\dns-responder-build'
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path (Join-Path $scriptDir 'dns-responder') '*') -Destination $buildDir
# Defense in depth: drop any bin/obj that slipped onto the share (initEnv filters these).
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
  (Join-Path $buildDir 'bin'), (Join-Path $buildDir 'obj')
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
dotnet publish $buildDir -c Release -o $installDir
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: PASS — including the new `dns-responder-build` / `Copy-Item` assertions, and all pre-existing substring assertions (`Register-ScheduledTask`, `ConfigamatronDnsResponder`, `responder-config.txt`, `Set-DnsClientServerAddress`, `'127.0.0.1'`).

- [ ] **Step 5: Commit**

```bash
git add templates/vm-shared-windows/07-setup-network.ps1 tests/unit/templates.test.ts
git commit -m "fix: build DNS responder from a writable dir off the read-only share"
```

---

### Task 3: Full unit suite green

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test:unit`
Expected: PASS — all unit tests green.

- [ ] **Step 2: Confirm the tree is clean**

Run: `git status --porcelain`
Expected: empty output (the bin/obj fixtures created in Task 1's test are removed in its `finally` block; no stray files remain).

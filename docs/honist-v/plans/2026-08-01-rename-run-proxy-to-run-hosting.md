# Rename `run-proxy` to `run-hosting` Implementation Plan

**Goal:** Rename the `run-proxy` CLI command to `run-hosting` across source, tests, docs, and ADRs (no back-compat alias), and fold a redundant Windows Firewall rule set into the existing rules while touching the affected script.

**Architecture:** This is a mechanical rename with one small, coupled simplification — no new runtime behavior. Every step either (a) moves/renames a file and fixes its consumers, (b) substitutes literal text, or (c) restructures the firewall-rule script the rename already touches. The full test suite (`pnpm test`) is the safety net throughout: it must report the same pass count before and after every task.

**Tech Stack:** TypeScript (Node/Commander CLI), Vitest, PowerShell (Windows Firewall scripts), Markdown (docs/ADRs).

## Global Constraints

- No back-compat alias — old name is fully removed, not aliased (per spec "Scope").
- The domain term **"Proxy stack"** (`CONTEXT.md`), the `tests/proxy-stack/` directory name, `vitest.proxy-stack.config.ts`, and `tests/checkNoRunningProxy.ts` are **not** renamed — distinct concept (per spec "Scope").
- `docs/honist-v/plans/*.md` and `docs/adr/_drafts/IMPORT-LOG.md` are historical records and are **not** rewritten (per spec "Scope").
- The dedicated node.exe copy is renamed to `node-copy-with-custom-firewall-rules.exe` — a name decoupled from the CLI command (per spec "Dedicated node.exe rename + firewall rule merge").
- No automated firewall-rule migration/cleanup is added — the old rule and old `.exe` are removed by hand on the one affected machine (per spec "Manual follow-up").

---

## File Structure

| Path | Responsibility after this change |
|---|---|
| `src/runHosting/` (renamed from `src/runProxy/`) | Same 37 files, same responsibilities, new directory name |
| `src/runHosting/runHostingLoop.ts` (renamed from `runProxyLoop.ts`) | Long-running orchestrator — same logic, `RunHostingConfig`/`RunHostingDeps`/`runHostingLoop` |
| `src/commands/runHosting.ts` (renamed from `runProxy.ts`) | CLI command registration — `registerRunHosting`, command string `'run-hosting'` |
| `docs/adr/0008-run-hosting-owns-hosting-lifecycle.md` (renamed from `0008-run-proxy-owns-proxy-lifecycle.md`) | Same ADR content, renamed |
| `docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md` (renamed from `0019-run-proxy-speaks-on-abnormal-exit.md`) | Same ADR content, renamed |
| `templates/proxy/host-allow-vm-inbound.ps1` | 3 merged, program-scoped rules instead of 3 unrestricted + 3 program-scoped |
| `templates/proxy/verify-proxy.ps1` | 4 `Test-RuleSet` calls instead of 5; new dedicated-node filename |

No new files are created; nothing is deleted except the redundant firewall-rule-creation lines inside `host-allow-vm-inbound.ps1` and the redundant `Test-RuleSet` call inside `verify-proxy.ps1`.

---

### Task 1: Rename the `src/runProxy/` module and fix every import site

**Files:**

- Move: `src/runProxy/` → `src/runHosting/` (37 files, git mv preserves history)
- Move: `src/runHosting/runProxyLoop.ts` → `src/runHosting/runHostingLoop.ts`
- Modify: `src/runHosting/runHostingLoop.ts`, `src/runHosting/credentialChannel.ts`, `src/runHosting/abnormalExitAlert.ts`, `src/runHosting/isColorRunning.ts`, `src/runHosting/logStream.ts`, `src/runHosting/nudgeCodexRefresh.ts`, `src/runHosting/relaunchViaDedicatedNode.ts` (comment/log-prefix text only — the dedicated node.exe path itself is Task 6)
- Modify: every file listed in the import-path table below
- Test: full existing suite (`pnpm test`) — no test file content changes in this task beyond import paths

**Interfaces:**

- Consumes: nothing new
- Produces: `RunHostingConfig`, `RunHostingDeps`, `runHostingLoop(config: RunHostingConfig, deps: RunHostingDeps): Promise<number>` — same shapes as the old `RunProxyConfig`/`RunProxyDeps`/`runProxyLoop`, just renamed. `src/commands/runProxy.ts` (not yet renamed — Task 2) will import these under their new names.

- [ ] **Step 1: Establish the baseline**

Run: `pnpm test`
Expected: passes (this is your "before" state — note the pass count so Step 8 can be compared against it)

- [ ] **Step 2: Move the directory and rename the orchestrator file**

```bash
git mv src/runProxy src/runHosting
git mv src/runHosting/runProxyLoop.ts src/runHosting/runHostingLoop.ts
```

- [ ] **Step 3: Rename identifiers and log prefixes inside `runHostingLoop.ts`**

In `src/runHosting/runHostingLoop.ts`, apply these exact substitutions:

| Line (pre-edit) | Old | New |
|---|---|---|
| 15 | `export interface RunProxyConfig {` | `export interface RunHostingConfig {` |
| 29 | `export interface RunProxyDeps {` | `export interface RunHostingDeps {` |
| 84 | `export function runProxyLoop(config: RunProxyConfig, deps: RunProxyDeps): Promise<number> {` | `export function runHostingLoop(config: RunHostingConfig, deps: RunHostingDeps): Promise<number> {` |

Then replace every literal occurrence of the substring `run-proxy:` with `run-hosting:` in this same file — there are 14 occurrences, on lines 126, 145, 177, 182, 188, 239, 249, 261, 277, 278, 293, 309, 349, and 424 (two lines, 126 and 145, share the identical template `` `run-proxy: ${message}` ``; the rest are distinct messages). Each is a simple substring replacement inside an existing template literal — do not otherwise change the surrounding text.

- [ ] **Step 4: Update the six other files with comment/log-prefix mentions**

In `src/runHosting/credentialChannel.ts` line 32:
- Old: `* Claude-only runProxyLoop: watched file -> secret write -> restart signalling, plus`
- New: `* Claude-only runHostingLoop: watched file -> secret write -> restart signalling, plus`

In `src/runHosting/abnormalExitAlert.ts`, replace `run-proxy's` with `run-hosting's` on lines 27, 43, and 45 (each reads `...affect run-proxy's exit result`, `...change run-proxy's own exit`, and `...run-proxy happened to be running from` respectively).

In `src/runHosting/isColorRunning.ts` line 7: replace `run-proxy uses to fast-fail` with `run-hosting uses to fast-fail`.

In `src/runHosting/logStream.ts` line 11: replace `run-proxy starts a fresh follow` with `run-hosting starts a fresh follow`.

In `src/runHosting/nudgeCodexRefresh.ts` line 16: replace `run-proxy's own long-lived` with `run-hosting's own long-lived`.

In `src/runHosting/relaunchViaDedicatedNode.ts` lines 138 and 140, replace the `run-proxy:` prefix with `run-hosting:` (the dedicated-node *path* on lines 55–68 is intentionally left alone here — that's Task 6):
- Line 138: `` deps.error(`run-proxy: dedicated node.exe copy was terminated by signal ${result.signal}`); `` → `` deps.error(`run-hosting: dedicated node.exe copy was terminated by signal ${result.signal}`); ``
- Line 140: `deps.error('run-proxy: failed to launch the dedicated node.exe copy');` → `deps.error('run-hosting: failed to launch the dedicated node.exe copy');`

- [ ] **Step 5: Fix every import site referencing the old directory**

Replace every occurrence of the path segment `/runProxy/` with `/runHosting/` inside `from '...'` import specifiers, across every file below (the relative-path prefix before `runProxy` varies by file depth; only the `runProxy` → `runHosting` segment changes):

`src/commands/runProxy.ts` (not yet renamed — Task 2 renames the file itself; here only fix its import: `from '../runProxy/runProxyLoop'` → `from '../runHosting/runHostingLoop'`, and update the named import `runProxyLoop, type RunProxyDeps` → `runHostingLoop, type RunHostingDeps` at that same import site), and every one of these test files:

```
tests/unit/abortableSleep.test.ts
tests/unit/abnormalExitAlert.test.ts
tests/unit/dhcpMessage.test.ts
tests/unit/dhcpLeases.test.ts
tests/unit/dhcpHandler.test.ts
tests/unit/credentialChannel.test.ts
tests/unit/gateway.test.ts
tests/unit/outputFormatting.test.ts
tests/unit/logLineParsing.test.ts
tests/unit/dhcpServer.test.ts
tests/unit/mcpProcess.test.ts
tests/unit/forwarder.test.ts
tests/unit/mcpSupervisor.test.ts
tests/unit/dnsMessage.test.ts
tests/unit/logLineClassification.test.ts
tests/unit/ip.test.ts
tests/unit/mcpPortAllocation.test.ts
tests/unit/dnsResponder.test.ts
tests/unit/processTermination.test.ts
tests/unit/readiness.test.ts
tests/unit/serviceStack.test.ts
tests/unit/proxyConfigWriting.test.ts
tests/unit/portAllocation.test.ts
tests/unit/uniqueTracker.test.ts
tests/unit/writeSecret.test.ts
tests/unit/supervisionPlanning.test.ts
tests/proxy-stack/codexInjection.test.ts
tests/proxy-stack/mcpServer.test.ts
tests/proxy-stack/stackRobustness.test.ts
tests/proxy-stack/servingStateDetection.test.ts
tests/proxy-stack/stackLifecycle.test.ts
tests/proxy-stack/githubInjection.test.ts
tests/proxyStack.ts
```

(`tests/unit/proxyStackSupervisor.test.ts`, `tests/unit/readCredentials.test.ts`, `tests/unit/readCodexCredentials.test.ts`, `tests/unit/templates.test.ts`, and `tests/unit/runtimeRelaunch.test.ts` also need their import fixed, but have additional content changes handled in later steps/tasks below — fix their import path here too, in this same step, since it's the same mechanical substitution.)

In `tests/unit/proxyStackSupervisor.test.ts`, additionally rename every use of the imported symbols to match Step 3: `runProxyLoop` → `runHostingLoop` (34 call sites: lines 213, 232, 252, 271, 283, 296, 313, 336, 355, 388, 411, 439, 456, 469, 494, 514, 539, 567, 609, 626, 649, 668, 687, 711, 739, 801, 823, 852, 868, 889, 905, 923, 946, 972), `RunProxyConfig` → `RunHostingConfig` (line 60), `RunProxyDeps` → `RunHostingDeps` (lines 70, 150), and the import list itself (lines 3–6). Also replace the `run-proxy:` log-message prefixes this file asserts against on lines 370, 376, 425, 427, 445, 450, and 777 (e.g. `'run-proxy: restarting proxy — allowlist changed'` → `'run-hosting: restarting proxy — allowlist changed'`) to match Step 3's renamed log output.

- [ ] **Step 6: Verify the build**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors (a leftover `/runProxy/` import would fail here first)

- [ ] **Step 7: Verify no old references remain outside the explicitly-excluded files**

Run: `grep -rn "runProxy\|RunProxy" src tests --include="*.ts" | grep -v "checkNoRunningProxy\|proxy-stack"`
Expected: no output (empty)

- [ ] **Step 8: Run the full suite and compare to baseline**

Run: `pnpm test`
Expected: passes, same pass count as Step 1

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Rename src/runProxy module to src/runHosting"
```

---

### Task 2: Rename the CLI command file and registration

**Files:**

- Move: `src/commands/runProxy.ts` → `src/commands/runHosting.ts`
- Modify: `src/cli.ts`
- Move: `tests/unit/commands/runProxy.test.ts` → `tests/unit/commands/runHosting.test.ts`
- Modify: `tests/cli/cli.test.ts`

**Interfaces:**

- Consumes: `runHostingLoop`, `RunHostingConfig`, `RunHostingDeps` from Task 1
- Produces: `registerRunHosting(program: Command): void`, registered CLI command string `'run-hosting'`

- [ ] **Step 1: Move the command file**

```bash
git mv src/commands/runProxy.ts src/commands/runHosting.ts
```

- [ ] **Step 2: Rename identifiers and the command string in `src/commands/runHosting.ts`**

| Old | New |
|---|---|
| `export function registerRunProxy(program: Command): void {` (line 85) | `export function registerRunHosting(program: Command): void {` |
| `.command('run-proxy')` (line 87) | `.command('run-hosting')` |
| `interface RunProxyOptions {` (line 39) | `interface RunHostingOptions {` |
| `.action(async (options: RunProxyOptions) => {` (line 132) | `.action(async (options: RunHostingOptions) => {` |

Replace every literal occurrence of the substring `run-proxy:` with `run-hosting:` in this file — there are 15 occurrences, on lines 74, 79, 145, 159, 170, 188, 204, 209, 219, 224, 229, 237, 238, 243, and 249 (e.g. `` `run-proxy: uncaught exception: ${String(err)}` `` on line 74, `` `run-proxy: gateway listening on ${listenAddresses.join(', ')} :${httpPort}/${httpsPort}` `` on line 209). Each is a simple substring replacement — do not otherwise change the surrounding text.

The command's `.description(...)` text does not contain the literal string `run-proxy` — it refers to "the Envoy proxy" (the domain concept, out of scope for this rename per the spec), so it needs no change.

- [ ] **Step 3: Update `src/cli.ts`**

| Old | New |
|---|---|
| `import { registerRunProxy } from './commands/runProxy';` | `import { registerRunHosting } from './commands/runHosting';` |
| `registerRunProxy(program);` | `registerRunHosting(program);` |

- [ ] **Step 4: Move and rewrite the command's unit test**

```bash
git mv tests/unit/commands/runProxy.test.ts tests/unit/commands/runHosting.test.ts
```

Replace the full content of `tests/unit/commands/runHosting.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunHosting } from '../../../src/commands/runHosting';

describe('run-hosting command option surface', () => {
  it('no longer exposes --forward-ports', () => {
    const program = new Command();
    registerRunHosting(program);
    const runHostingCommand = program.commands.find((cmd) => cmd.name() === 'run-hosting');
    expect(runHostingCommand).toBeDefined();
    const flags = runHostingCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--forward-ports'))).toBe(false);
  });
});
```

- [ ] **Step 5: Update `tests/cli/cli.test.ts`**

Replace the four `run-proxy` references (the two test descriptions and two `execa(...)` argv arrays) with `run-hosting`:

| Old | New |
|---|---|
| `it('lists run-proxy with its flags in help output', async () => {` | `it('lists run-hosting with its flags in help output', async () => {` |
| `await execa('node', [cliPath, 'run-proxy', '--help']);` | `await execa('node', [cliPath, 'run-hosting', '--help']);` |
| `it('run-proxy names the missing prerequisite command', async () => {` | `it('run-hosting names the missing prerequisite command', async () => {` |
| `await execa('node', [cliPath, 'run-proxy'], {` | `await execa('node', [cliPath, 'run-hosting'], {` |

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: passes, same pass count as Task 1's final run

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Rename run-proxy command to run-hosting"
```

---

### Task 3: Update proxy-stack integration tests' literal CLI invocations

The `run-proxy` command name is passed as a literal argv element to spawn the actual CLI in these integration tests — after Task 2, a leftover `'run-proxy'` argv would fail at runtime (no such command exists anymore), not just look stale.

**Files:**

- Modify: `tests/proxyStack.ts`
- Modify: `tests/proxy-stack/codexInjection.test.ts`, `tests/proxy-stack/mcpServer.test.ts`, `tests/proxy-stack/stackRobustness.test.ts`, `tests/proxy-stack/stackLifecycle.test.ts`, `tests/proxy-stack/githubInjection.test.ts`, `tests/proxy-stack/allowlistEnforcement.test.ts`, `tests/proxy-stack/globalSetup.ts`
- Modify: `tests/guest/globalSetup.ts`, `tests/guest/wsl.ts`, `tests/guest/harness/net.sh`, `tests/checkDockerRunning.ts`

**Interfaces:**

- Consumes: the `run-hosting` command from Task 2 (these tests spawn it as a subprocess)
- Produces: nothing new

- [ ] **Step 1: Update `tests/proxyStack.ts`**

This shared helper is used by every `tests/proxy-stack/*.test.ts` file. Apply these substitutions:

| Line (pre-edit) | Old | New |
|---|---|---|
| 28 | `/** Every stdout/stderr line run-proxy has produced so far, in order. */` | `/** Every stdout/stderr line run-hosting has produced so far, in order. */` |
| 32 | `/** The mutable credentials file run-proxy watches — rotate it to trigger a restart. */` | `/** The mutable credentials file run-hosting watches — rotate it to trigger a restart. */` |
| 72 | `* Wait until run-proxy prints a line containing \`needle\` at index >= fromIndex.` | `* Wait until run-hosting prints a line containing \`needle\` at index >= fromIndex.` |
| 89–90 | `` `timed out waiting for run-proxy output containing '${needle}'\n` + `--- run-proxy output ---\n${stack.stdoutLines.join('\n')}`, `` | `` `timed out waiting for run-hosting output containing '${needle}'\n` + `--- run-hosting output ---\n${stack.stdoutLines.join('\n')}`, `` |
| 108 | `` `run-proxy never logged '${needle}'\n--- run-proxy output ---\n${lines.join('\n')}`, `` | `` `run-hosting never logged '${needle}'\n--- run-hosting output ---\n${lines.join('\n')}`, `` |
| 131 | `// the leaf SANs derive from it; run-proxy then builds envoy.yaml from it too.` | `// the leaf SANs derive from it; run-hosting then builds envoy.yaml from it too.` |
| 136 | `// run-proxy owns the SDS secret now: the token in this mutable credentials` | `// run-hosting owns the SDS secret now: the token in this mutable credentials` |
| 138 | `const credentialsPath = join(envRoot, 'run-proxy-credentials.json');` | `const credentialsPath = join(envRoot, 'run-hosting-credentials.json');` |
| 141 | `const codexCredentialsPath = join(envRoot, 'run-proxy-auth.json');` | `const codexCredentialsPath = join(envRoot, 'run-hosting-auth.json');` |
| 151 | `'run-proxy',` (an argv element in the spawned command array) | `'run-hosting',` |
| 171 | `console.log(\`run-proxy| ${line}\`);` | `console.log(\`run-hosting| ${line}\`);` |
| 175 | `// run-proxy builds envoy.yaml, writes the secret, and force-recreates; ready` | `// run-hosting builds envoy.yaml, writes the secret, and force-recreates; ready` |
| 192 | `// Kill the whole tree: run-proxy's docker-logs child holds a stdout pipe` | `// Kill the whole tree: run-hosting's docker-logs child holds a stdout pipe` |

- [ ] **Step 2: Update the individual proxy-stack test files**

| File | Line | Old | New |
|---|---|---|---|
| `tests/proxy-stack/codexInjection.test.ts` | 149 | `'run-proxy',` (argv element) | `'run-hosting',` |
| `tests/proxy-stack/mcpServer.test.ts` | 60 | `// Written BEFORE run-proxy is spawned: run-proxy reads credentials synchronously` | `// Written BEFORE run-hosting is spawned: run-hosting reads credentials synchronously` |
| `tests/proxy-stack/mcpServer.test.ts` | 105 | `'run-proxy',` (argv element) | `'run-hosting',` |
| `tests/proxy-stack/mcpServer.test.ts` | 121 | `// not just that run-proxy itself started.` | `// not just that run-hosting itself started.` |
| `tests/proxy-stack/mcpServer.test.ts` | 127 | `// run-proxy's own SIGINT shutdown kills the faketool child it spawned (Task 10);` | `// run-hosting's own SIGINT shutdown kills the faketool child it spawned (Task 10);` |
| `tests/proxy-stack/stackRobustness.test.ts` | 20 | `// Distinct from runProxy.test.ts's ports to avoid any lingering-socket overlap.` | `// Distinct from runHosting.test.ts's ports to avoid any lingering-socket overlap.` |
| `tests/proxy-stack/stackRobustness.test.ts` | 65, 90 | `'run-proxy',` (argv elements) | `'run-hosting',` |
| `tests/proxy-stack/stackRobustness.test.ts` | 113 | `` `timed out waiting for run-proxy output containing '${needle}'\n` + `` | `` `timed out waiting for run-hosting output containing '${needle}'\n` + `` |
| `tests/proxy-stack/stackRobustness.test.ts` | 131 | `tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-robust-'));` | `tempDir = mkdtempSync(join(tmpdir(), 'run-hosting-robust-'));` |
| `tests/proxy-stack/stackRobustness.test.ts` | 184 | `// Once the container is running, run-proxy is parked in the startup waitColorReady.` | `// Once the container is running, run-hosting is parked in the startup waitColorReady.` |
| `tests/proxy-stack/stackLifecycle.test.ts` | 68–69 | `` `timed out waiting for run-proxy output containing '${needle}'\n` + `--- run-proxy output ---\n${stdoutLines.join('\n')}`, `` | `` `timed out waiting for run-hosting output containing '${needle}'\n` + `--- run-hosting output ---\n${stdoutLines.join('\n')}`, `` |
| `tests/proxy-stack/stackLifecycle.test.ts` | 78 | `tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-int-'));` | `tempDir = mkdtempSync(join(tmpdir(), 'run-hosting-int-'));` |
| `tests/proxy-stack/stackLifecycle.test.ts` | 101 | `'run-proxy',` (argv element) | `'run-hosting',` |
| `tests/proxy-stack/githubInjection.test.ts` | 122 | `// puts them in the leaf SANs and run-proxy builds the two injection chains.` | `// puts them in the leaf SANs and run-hosting builds the two injection chains.` |
| `tests/proxy-stack/githubInjection.test.ts` | 145 | `'run-proxy',` (argv element) | `'run-hosting',` |
| `tests/proxy-stack/allowlistEnforcement.test.ts` | 294 | `// it stays on the color run-proxy always starts with.` | `// it stays on the color run-hosting always starts with.` |
| `tests/proxy-stack/globalSetup.ts` | 7, 9 | `// a live run-proxy fighting this suite...` / `// down\` on the same stack, so a live run-proxy is left serving :80/:443 with` | `run-proxy` → `run-hosting` in both comments |

- [ ] **Step 3: Update comment-only mentions in guest tests and the Docker check**

| File | Line | Old | New |
|---|---|---|---|
| `tests/guest/globalSetup.ts` | 12 | `// self-inflicted failures — Docker Desktop not running, or a live run-proxy` | `// self-inflicted failures — Docker Desktop not running, or a live run-hosting` |
| `tests/guest/wsl.ts` | 53 | `// Prerequisites). Under NAT mode WSL cannot reach run-proxy's gateway at all` | `// Prerequisites). Under NAT mode WSL cannot reach run-hosting's gateway at all` |
| `tests/guest/harness/net.sh` | 42 | `        # Mirror run-proxy's host-side DHCP and DNS behaviour on the isolated` | `        # Mirror run-hosting's host-side DHCP and DNS behaviour on the isolated` |
| `tests/checkDockerRunning.ts` | 5 | `* \`docker\`/\`docker compose\` (directly or via run-proxy). If the Docker Desktop` | `* \`docker\`/\`docker compose\` (directly or via run-hosting). If the Docker Desktop` |

- [ ] **Step 4: Verify no old references remain in the touched test trees**

Run: `grep -rn "run-proxy" tests --include="*.ts" --include="*.sh" | grep -v "checkNoRunningProxy\|proxy-stack/servingStateDetection"`
Expected: no output (empty) — if anything remains, it should only be inside `tests/checkNoRunningProxy.ts`, which is explicitly out of scope

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: passes, same pass count as Task 2

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Update proxy-stack/guest test references from run-proxy to run-hosting"
```

---

### Task 4: Update user-facing docs and the template script comment

**Files:**

- Modify: `README.md`, `setup-environment.md`, `setup-guest.md`, `setup-machine.md`, `diagnostics.md`, `testing.md`
- Modify: `templates/vm-shared-linux/pre-scripts/nn-configure-network.sh`

**Interfaces:** none (prose-only changes)

- [ ] **Step 1: Update `README.md`**

Line 19: `Only one susentorno environment can run on the host at a time (the run-proxy command to the necessary ports on the network endpoint dedicated to susentorno environments). Starting any environment — or running this repo's test suite — replaces whichever proxy container was running. Run one environment at a time; running \`susentorno run-proxy\` in an environment's directory restores its proxy.` → replace `run-proxy` (bare) with `run-hosting` and `` `susentorno run-proxy` `` with `` `susentorno run-hosting` ``.

Line 65: replace the `run-proxy` mention (in the VMWare Workstation discussion, "where run-proxy bound its proxy") with `run-hosting`.

- [ ] **Step 2: Update `setup-environment.md`**

Line 10: `` `run-proxy` reissues the per-host leaf certificate automatically `` → `` `run-hosting` reissues the per-host leaf certificate automatically ``.

Line 12: `` 4. `susentorno run-proxy` — builds `proxy/envoy.yaml`... `` → `` 4. `susentorno run-hosting` — builds `proxy/envoy.yaml`... `` (replace every `run-proxy` mention in this paragraph, including the `--no-forward`/`--forward-listen` flag descriptions, which stay on the same command).

- [ ] **Step 3: Update `setup-guest.md`**

| Line | Old | New |
|---|---|---|
| 5 | `` they lease from `run-proxy` once isolated `` | `` they lease from `run-hosting` once isolated `` |
| 118 | `` `susentorno-internal` uses `run-proxy` with the host as router and DNS `` | `` `susentorno-internal` uses `run-hosting` with the host as router and DNS `` |
| 129 | Every `run-proxy` mention (4 occurrences in this paragraph) | `run-hosting` |
| 130–131 | Every `run-proxy` mention (2 occurrences, including `` `run-proxy` `node.exe` ``) | `run-hosting` (the node.exe filename itself is Task 6 — here just fix the prose word "run-proxy") |
| 136 | `New-NetFirewallRule -DisplayName 'susentorno run-proxy node (VM inbound)' -Direction Inbound \`` | `New-NetFirewallRule -DisplayName 'susentorno run-hosting node (VM inbound)' -Direction Inbound \`` |
| 158 | `` with `run-proxy` already running `` | `` with `run-hosting` already running `` |
| 166 | `` Confirm the host firewall is open and `run-proxy` is running `` | `` Confirm the host firewall is open and `run-hosting` is running `` |
| 170 | `susentorno run-proxy` (in a code block) | `susentorno run-hosting` |

- [ ] **Step 4: Update `setup-machine.md`**

Line 7: `` `susentorno run-proxy` supplies DHCP and DNS on it `` → `` `susentorno run-hosting` supplies DHCP and DNS on it ``.

Line 9: `` the `run-proxy --forward-listen` target `` → `` the `run-hosting --forward-listen` target ``.

Line 37: `` It runs `run-proxy` from a dedicated private copy of `node.exe` `` → `` It runs `run-hosting` from a dedicated private copy of `node.exe` ``.

- [ ] **Step 5: Update `diagnostics.md`**

Line 15: `` `susentorno run-proxy` streams how the proxy handled each host `` → `` `susentorno run-hosting` streams how the proxy handled each host ``.

Line 31: `` a running `susentorno run-proxy` picks the edit up live `` → `` a running `susentorno run-hosting` picks the edit up live ``.

- [ ] **Step 6: Update `testing.md`**

Line 47: `` Stop any live `susentorno run-proxy` process first. `` → `` Stop any live `susentorno run-hosting` process first. ``.

Line 48: `` Stop any live `susentorno run-proxy` process first — it manages the same docker-compose Envoy stack, so leaving it running gets its Envoy torn down mid-suite (the reachability guard then reports \`000\`, which looks like a Docker/WSL problem) while `run-proxy` itself is left serving with no backend. `` → replace both `run-proxy` mentions with `run-hosting`.

Line 52: `` Both live tiers fail fast when Docker is unavailable or `run-proxy` would conflict with their shared proxy stack. `` → `` ...or `run-hosting` would conflict... ``.

- [ ] **Step 7: Update the template script comment**

`templates/vm-shared-linux/pre-scripts/nn-configure-network.sh` line 67: `# run-proxy, which supplies the host as both router (option 3) and DNS (option 6).` → `# run-hosting, which supplies the host as both router (option 3) and DNS (option 6).`

- [ ] **Step 8: Verify no old references remain in these docs**

Run: `grep -rln "run-proxy" README.md setup-environment.md setup-guest.md setup-machine.md diagnostics.md testing.md templates/vm-shared-linux/pre-scripts/nn-configure-network.sh`
Expected: no output (empty)

- [ ] **Step 9: Commit**

```bash
git add README.md setup-environment.md setup-guest.md setup-machine.md diagnostics.md testing.md templates/vm-shared-linux/pre-scripts/nn-configure-network.sh
git commit -m "Update user-facing docs from run-proxy to run-hosting"
```

---

### Task 5: Rename and update the ADRs and the MCP design spec

**Files:**

- Move: `docs/adr/0008-run-proxy-owns-proxy-lifecycle.md` → `docs/adr/0008-run-hosting-owns-hosting-lifecycle.md`
- Move: `docs/adr/0019-run-proxy-speaks-on-abnormal-exit.md` → `docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md`
- Modify: `docs/adr/0002-credential-injection-at-proxy.md`, `0003-transparent-interception-and-network-isolation-boundary.md`, `0004-no-oauth-refresh-piggyback-host-cli.md`, `0005-allowlist-format-and-parse-trust-boundary.md`, `0007-per-directory-environment-model.md`, `0009-envoy-access-log-contract.md`, `0010-vm-tests-via-qemu-in-wsl2.md`, `0011-loopback-publish-with-node-forwarder.md`, `0012-blue-green-container-swap-for-restarts.md`, `0014-host-side-dns-and-dhcp.md`, `0020-host-run-mcp-servers.md`
- Modify: `docs/honist-v/specs/2026-07-31-host-run-mcp-servers-design.md`

**Interfaces:** none (prose changes; ADR content describes behavior, not code the rest of the plan depends on)

- [ ] **Step 1: Rename the two title-bearing ADRs**

```bash
git mv docs/adr/0008-run-proxy-owns-proxy-lifecycle.md docs/adr/0008-run-hosting-owns-hosting-lifecycle.md
git mv docs/adr/0019-run-proxy-speaks-on-abnormal-exit.md docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md
```

In `docs/adr/0008-run-hosting-owns-hosting-lifecycle.md`: change the `# ` title heading from `` `run-proxy` owns the whole proxy lifecycle as one long-running command `` to `` `run-hosting` owns the whole hosting lifecycle as one long-running command ``, and replace every remaining body mention of `run-proxy` with `run-hosting`.

In `docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md`: replace the title and every body mention of `run-proxy` with `run-hosting` the same way.

- [ ] **Step 2: Update prose mentions in the other eleven ADRs**

For each of these files, replace every occurrence of `run-proxy` (prose) and `src/runProxy/` (code-path references) with `run-hosting` and `src/runHosting/` respectively — preserve meaning, don't reword surrounding sentences:

```
docs/adr/0002-credential-injection-at-proxy.md         (line 7: src/runProxy/credentialChannel.ts)
docs/adr/0003-transparent-interception-and-network-isolation-boundary.md
docs/adr/0004-no-oauth-refresh-piggyback-host-cli.md
docs/adr/0005-allowlist-format-and-parse-trust-boundary.md
docs/adr/0007-per-directory-environment-model.md
docs/adr/0009-envoy-access-log-contract.md
docs/adr/0010-vm-tests-via-qemu-in-wsl2.md
docs/adr/0011-loopback-publish-with-node-forwarder.md
docs/adr/0012-blue-green-container-swap-for-restarts.md
docs/adr/0014-host-side-dns-and-dhcp.md
docs/adr/0020-host-run-mcp-servers.md
```

- [ ] **Step 3: Update the MCP design spec**

In `docs/honist-v/specs/2026-07-31-host-run-mcp-servers-design.md`, replace every mention of `run-proxy` with `run-hosting` throughout (this file describes current, still-accurate behavior — same "living reference" treatment as the ADRs, not the "historical record" treatment that excludes `docs/honist-v/plans/`).

- [ ] **Step 4: Verify no old references remain**

Run: `grep -rln "run-proxy\|runProxy" docs/adr docs/honist-v/specs | grep -v "_drafts"`
Expected: no output (empty)

- [ ] **Step 5: Commit**

```bash
git add docs/adr docs/honist-v/specs
git commit -m "Rename run-proxy to run-hosting in ADRs and the MCP design spec"
```

---

### Task 6: Rename the dedicated node.exe path and its embedded README

**Files:**

- Modify: `src/runHosting/relaunchViaDedicatedNode.ts`
- Modify: `templates/proxy/verify-proxy.ps1`
- Modify: `tests/unit/runtimeRelaunch.test.ts`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: nothing new
- Produces: `getDedicatedNodePath(homedir: string): string` now returns a path ending in `node-copy-with-custom-firewall-rules.exe` instead of `run-proxy-node.exe` — Task 7/8 (the firewall scripts) consume this new filename via their own mirrored path construction, not by importing this function directly (they're PowerShell, not TypeScript).

- [ ] **Step 1: Rewrite the embedded README and path constant in `relaunchViaDedicatedNode.ts`**

Replace lines 54–64 (the `README_CONTENT` array) with:

```typescript
const README_CONTENT = [
  'node-copy-with-custom-firewall-rules.exe is a plain copy of the node.exe',
  'that ran susentorno run-hosting, kept here so a Windows Firewall rule can',
  'be scoped to a binary that only ever runs run-hosting — not the shared',
  'system node.exe, which any other script or tool might also run through.',
  '',
  'It is not a customized build. Deleting this file is safe: the next',
  '`susentorno run-hosting` (with forwarding enabled, the default) recreates',
  'it from whatever node.exe is currently running the CLI.',
  '',
].join('\n');
```

Replace line 68:
- Old: `return join(homedir, '.susentorno-host', 'run-proxy-node.exe');`
- New: `return join(homedir, '.susentorno-host', 'node-copy-with-custom-firewall-rules.exe');`

- [ ] **Step 2: Update the mirrored path function in `verify-proxy.ps1`**

Line 65: `Join-Path $env:USERPROFILE ".susentorno-host\run-proxy-node.exe"` → `Join-Path $env:USERPROFILE ".susentorno-host\node-copy-with-custom-firewall-rules.exe"`

Line 63 (the comment above it): `# mirrors the convention in src/runProxy/relaunchViaDedicatedNode.ts.` → `# mirrors the convention in src/runHosting/relaunchViaDedicatedNode.ts.`

- [ ] **Step 3: Update `tests/unit/runtimeRelaunch.test.ts`**

| Line | Old | New |
|---|---|---|
| 15 | `'C:\\Users\\alice\\.susentorno-host\\run-proxy-node.exe',` | `'C:\\Users\\alice\\.susentorno-host\\node-copy-with-custom-firewall-rules.exe',` |
| 21 | `const DEDICATED = 'C:\\Users\\alice\\.susentorno-host\\run-proxy-node.exe';` | `const DEDICATED = 'C:\\Users\\alice\\.susentorno-host\\node-copy-with-custom-firewall-rules.exe';` |
| 90 | `const DEDICATED = 'C:\\Users\\alice\\.susentorno-host\\run-proxy-node.exe';` | `const DEDICATED = 'C:\\Users\\alice\\.susentorno-host\\node-copy-with-custom-firewall-rules.exe';` |
| 98 | `argv: [SOURCE, 'C:\\cli\\cli.js', 'run-proxy'],` | `argv: [SOURCE, 'C:\\cli\\cli.js', 'run-hosting'],` |
| 130 | `execPath: 'C:\\USERS\\ALICE\\.susentorno-HOST\\RUN-PROXY-NODE.EXE',` | `execPath: 'C:\\USERS\\ALICE\\.susentorno-HOST\\NODE-COPY-WITH-CUSTOM-FIREWALL-RULES.EXE',` |
| 146 | `expect(deps.spawn).toHaveBeenCalledWith(DEDICATED, ['C:\\cli\\cli.js', 'run-proxy'], {` | `expect(deps.spawn).toHaveBeenCalledWith(DEDICATED, ['C:\\cli\\cli.js', 'run-hosting'], {` |

- [ ] **Step 4: Update the dedicated-node.exe assertion in `tests/unit/templates.test.ts`**

Line 96: `expect(script).toContain('.susentorno-host\\run-proxy-node.exe');` → `expect(script).toContain('.susentorno-host\\node-copy-with-custom-firewall-rules.exe');`

(Leave the rest of this test file's assertions alone here — the `-LocalAddress $hostIp` count and `Test-RuleSet -Label` count are Tasks 7 and 8.)

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: `tests/unit/runtimeRelaunch.test.ts` and `tests/unit/templates.test.ts` still pass; overall pass count unchanged from Task 5 (Tasks 7/8 haven't touched the firewall rule bodies yet, so `host-allow-vm-inbound.ps1`'s own rule counts are still the pre-merge shape at this point — only the filename inside it needs to still read correctly, which it does since Step 2 above only touched `verify-proxy.ps1`, not `host-allow-vm-inbound.ps1`)

Note: `host-allow-vm-inbound.ps1` still contains its own copy of the literal string `run-proxy-node.exe` (in its header comment and `$nodePath` construction) at this point — that's fixed in Task 7 alongside the rule merge, since both changes touch the same lines.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Rename dedicated node.exe to node-copy-with-custom-firewall-rules.exe"
```

---

### Task 7: Merge the firewall rules in `host-allow-vm-inbound.ps1`

**Files:**

- Modify: `templates/proxy/host-allow-vm-inbound.ps1`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: the renamed dedicated-node filename from Task 6 (`node-copy-with-custom-firewall-rules.exe`)
- Produces: three firewall rules (TCP 80/443, UDP 53, UDP 67) each now carrying `-Program $nodePath`, instead of three unrestricted + three separately-named program-scoped rules

- [ ] **Step 1: Rewrite the header comment's rationale**

Replace the paragraph starting `It also establishes three program-scoped rules for a dedicated copy of` (through `...this script can run before that first start.`, roughly lines 30–50) with:

```
Each of the three rules below (TCP 80/443, DNS 53, DHCP 67) also carries
-Program, scoped to a dedicated copy of node.exe that run-hosting relaunches
itself through on Windows (src/runHosting/relaunchViaDedicatedNode.ts),
rather than the shared system node.exe. Without this, the first run-hosting
start on an Internal switch raises Windows' "allow node.exe on public
networks?" dialog - an Internal switch has no gateway, so Windows can never
identify it as anything but Public - and writes a "Query User{GUID}<path>"
rule from whatever gets clicked. Both answers are wrong: Allow grants any
port on any local address and masks whether these rules are present at all
(this is what happened at the 2026-07-23 Windows checkpoint), while
dismissing it writes a Block of the same breadth that silently overrides
them, since Windows evaluates Block before Allow. Pre-empting the dialog is
what makes the environment deterministic.

The dedicated node.exe lives at a fixed, host-wide path
(%USERPROFILE%\.susentorno-host\node-copy-with-custom-firewall-rules.exe)
that run-hosting creates on its first forwarded start. The path is a known
constant, not discovered - New-NetFirewallRule -Program does not require the
file to exist yet, so this script can run before that first start.
```

- [ ] **Step 2: Update the rule-name variables and remove the separate node rule set**

Replace:

```powershell
$tcpRuleName = "susentorno Envoy Proxy (VM inbound)"
$dnsRuleName = "susentorno DNS stub (VM inbound)"
$dhcpRuleName = "susentorno DHCP (VM inbound)"
$smbRuleName = "susentorno share (VM inbound)"
$nodeRuleName = "susentorno run-proxy node (VM inbound)"

foreach ($name in @($tcpRuleName, $dnsRuleName, $dhcpRuleName, $smbRuleName, $nodeRuleName)) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
```

with:

```powershell
$tcpRuleName = "susentorno Envoy Proxy (VM inbound)"
$dnsRuleName = "susentorno DNS stub (VM inbound)"
$dhcpRuleName = "susentorno DHCP (VM inbound)"
$smbRuleName = "susentorno share (VM inbound)"

foreach ($name in @($tcpRuleName, $dnsRuleName, $dhcpRuleName, $smbRuleName)) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
```

Update `$nodePath`'s own line: `$nodePath = Join-Path $env:USERPROFILE ".susentorno-host\run-proxy-node.exe"` → `$nodePath = Join-Path $env:USERPROFILE ".susentorno-host\node-copy-with-custom-firewall-rules.exe"`

- [ ] **Step 3: Fold `-Program $nodePath` into the three existing rules and delete the separate rule set**

Replace:

```powershell
New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dnsRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $NatAdapterAlias -LocalAddress $natHostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -Program $nodePath -InterfaceAlias $AdapterAlias -Action Allow | Out-Null
```

with:

```powershell
New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dnsRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -Program $nodePath -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $NatAdapterAlias -LocalAddress $natHostIp -Action Allow | Out-Null
```

Update the closing `Write-Host` lines (`"Firewall rules created, scoped to interface '$AdapterAlias'."`, `"Host IP for this network: $hostIp"`, `"Program rules created for $nodePath"`) — these reference `$nodePath` and stay correct as-is; no change needed.

- [ ] **Step 4: Update the affected assertion in `tests/unit/templates.test.ts`**

Line 92: `expect((script.match(/-LocalAddress \$hostIp/g) ?? []).length).toBeGreaterThanOrEqual(4);` → `expect((script.match(/-LocalAddress \$hostIp/g) ?? []).length).toBeGreaterThanOrEqual(3);`

(Reasoning: before the merge, `-LocalAddress $hostIp` appeared on the TCP, DNS, SMB, node-TCP, and node-DNS rules = 5 times. After the merge, it appears on the TCP, DNS, and SMB rules = 3 times, since the DHCP rules — merged or not — never carry `-LocalAddress`. The `-Program $nodePath` assertion on line 95, `expect((script.match(/-Program \$nodePath/g) ?? []).length).toBe(3);`, needs **no change** — it was already exactly 3 before the merge (the three separate node rules) and stays exactly 3 after (now folded into the TCP/DNS/DHCP rules instead).)

- [ ] **Step 5: Verify no old references remain in this file**

Run: `grep -n "run-proxy\|nodeRuleName" templates/proxy/host-allow-vm-inbound.ps1`
Expected: no output (empty)

- [ ] **Step 6: Run the PowerShell lint and full suite**

Run: `pnpm lint:ps1`
Expected: passes

Run: `pnpm test`
Expected: passes, same pass count as Task 6

- [ ] **Step 7: Commit**

```bash
git add templates/proxy/host-allow-vm-inbound.ps1 tests/unit/templates.test.ts
git commit -m "Merge program-scoped firewall rules into the existing three rules"
```

---

### Task 8: Update `verify-proxy.ps1` to match the merged rules

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: the merged rule shape from Task 7 (three `Program`-scoped rules instead of three unrestricted + a separate fourth-labeled set)
- Produces: nothing new (verification script only)

- [ ] **Step 1: Fold `Program = $nodePath` into the three `Test-RuleSet` calls and delete the fifth**

Replace:

```powershell
Test-RuleSet -Label 'TCP 80/443' -DisplayName 'susentorno Envoy Proxy (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 80, 443; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
)
Test-RuleSet -Label 'DNS 53' -DisplayName 'susentorno DNS stub (VM inbound)' -Expected @(
    @{ Protocol = 'UDP'; LocalPort = 53; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
)
Test-RuleSet -Label 'DHCP 67' -DisplayName 'susentorno DHCP (VM inbound)' -Expected @(
    @{ Protocol = 'UDP'; LocalPort = 67; InterfaceAlias = $AdapterAlias; LocalAddress = $null }
)
Test-RuleSet -Label 'SMB 445' -DisplayName 'susentorno share (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 445; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'TCP'; LocalPort = 445; InterfaceAlias = $NatAdapterAlias; LocalAddress = $natHostIp; SkipAddress = (-not $natHostIp) }
)
Test-RuleSet -Label 'run-proxy node.exe' -DisplayName 'susentorno run-proxy node (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 80, 443; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; Program = $nodePath; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'UDP'; LocalPort = 53; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; Program = $nodePath; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'UDP'; LocalPort = 67; InterfaceAlias = $AdapterAlias; LocalAddress = $null; Program = $nodePath }
)
```

with:

```powershell
Test-RuleSet -Label 'TCP 80/443' -DisplayName 'susentorno Envoy Proxy (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 80, 443; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; Program = $nodePath; SkipAddress = $hostIpUnresolved }
)
Test-RuleSet -Label 'DNS 53' -DisplayName 'susentorno DNS stub (VM inbound)' -Expected @(
    @{ Protocol = 'UDP'; LocalPort = 53; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; Program = $nodePath; SkipAddress = $hostIpUnresolved }
)
Test-RuleSet -Label 'DHCP 67' -DisplayName 'susentorno DHCP (VM inbound)' -Expected @(
    @{ Protocol = 'UDP'; LocalPort = 67; InterfaceAlias = $AdapterAlias; LocalAddress = $null; Program = $nodePath }
)
Test-RuleSet -Label 'SMB 445' -DisplayName 'susentorno share (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 445; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'TCP'; LocalPort = 445; InterfaceAlias = $NatAdapterAlias; LocalAddress = $natHostIp; SkipAddress = (-not $natHostIp) }
)
```

(Recall from `Test-RuleTuple`'s existing logic, lines 94–99: `$Expected.Program` of `$null` means "expected unrestricted," not "don't care" — so adding `Program = $nodePath` to the TCP/DNS/DHCP tuples correctly asserts they're now program-scoped, while SMB's tuples correctly keep no `Program` key at all, meaning still-unrestricted.)

- [ ] **Step 2: Update the affected assertion in `tests/unit/templates.test.ts`**

Line 118: `expect((script.match(/Test-RuleSet -Label/g) ?? []).length).toBe(5);` → `expect((script.match(/Test-RuleSet -Label/g) ?? []).length).toBe(4);`

- [ ] **Step 3: Verify no old references remain in this file**

Run: `grep -n "run-proxy" templates/proxy/verify-proxy.ps1`
Expected: no output (empty)

- [ ] **Step 4: Run the PowerShell lint and full suite**

Run: `pnpm lint:ps1`
Expected: passes

Run: `pnpm test`
Expected: passes, same pass count as Task 7

- [ ] **Step 5: Commit**

```bash
git add templates/proxy/verify-proxy.ps1 tests/unit/templates.test.ts
git commit -m "Update verify-proxy.ps1 to match the merged firewall rules"
```

---

### Task 9: Final verification sweep and manual follow-up reminder

**Files:** none modified — verification only

**Interfaces:** none

- [ ] **Step 1: Grep the whole repo for any remaining reference**

Run: `grep -rln "run-proxy\|runProxy\|RunProxy" --include="*.ts" --include="*.md" --include="*.ps1" --include="*.sh" .`
Expected: only these files, all intentionally excluded per the spec's scope:
- `tests/checkNoRunningProxy.ts` (checks the Envoy container, not the command)
- anything under `tests/proxy-stack/` or `vitest.proxy-stack.config.ts` whose match is the directory/config name itself, not a leftover `run-proxy` command reference (re-check any hit here individually — a hit on the literal string `run-proxy` inside a `proxy-stack` file would be a real miss from Tasks 3/5, not an intentional exclusion)
- `docs/honist-v/plans/*.md` (historical, e.g. `2026-07-30-run-proxy-abnormal-exit-alert.md`, `2026-07-31-host-run-mcp-servers.md`)
- `docs/adr/_drafts/IMPORT-LOG.md`
- `docs/honist-v/specs/2026-08-01-rename-run-proxy-to-run-hosting-design.md` and this plan file itself (they document the rename, so naturally mention the old name)

If anything else appears, go back and fix it in the relevant task above before proceeding.

- [ ] **Step 2: Full verification**

Run: `pnpm test`
Expected: passes (format check, lint, typecheck, unit tests, build, cli tests, proxy-stack tests all green)

- [ ] **Step 3: Manual follow-up (not automated — do this by hand on this machine after merging)**

1. Re-run `host-allow-vm-inbound.ps1` (as admin) to create the new merged, renamed rules:
   ```powershell
   powershell -File .susentorno\proxy\host-allow-vm-inbound.ps1
   ```
2. Manually remove the old `"susentorno run-proxy node (VM inbound)"` firewall rule (the pre-merge, program-scoped one) — it's now orphaned:
   ```powershell
   Get-NetFirewallRule -DisplayName "susentorno run-proxy node (VM inbound)" | Remove-NetFirewallRule
   ```
3. Manually delete the orphaned `%USERPROFILE%\.susentorno-host\run-proxy-node.exe` once `node-copy-with-custom-firewall-rules.exe` exists in its place. Leave `readme.txt` alone — `run-hosting` will already have overwritten it to describe the new copy on its first start.

- [ ] **Step 4: Final commit (if Step 1 required any fixes)**

```bash
git add -A
git commit -m "Fix remaining run-proxy references found in final verification sweep"
```

(Skip this step if Step 1 found nothing to fix.)

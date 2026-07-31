# `run-proxy` Abnormal-Exit Audible Alert Implementation Plan

**Goal:** `run-proxy` speaks "Configamatron is down" once through Windows SAPI whenever it exits
abnormally (startup failure or runtime crash), and stays silent on a clean Ctrl-C/SIGINT or
SIGTERM shutdown.

**Architecture:** A small injectable-deps module (`src/runProxy/abnormalExitAlert.ts`) owns the
guarded "speak at most once" alert and the detached, unref'd PowerShell/SAPI spawn. It is wired in
at exactly one place — the `run-proxy` command's `.action()` in `src/commands/runProxy.ts` — via a
top-level try/finally plus `process.on('uncaughtException')`/`('unhandledRejection')` handlers,
so every current and future failure path is covered without touching each of the command's early
exit sites individually. `runProxyLoop` gains a second clean-shutdown signal (SIGTERM, alongside
the existing SIGINT) so both resolve with exit code 0 and never trigger the alert. The relaunch
mechanism (`relaunchViaDedicatedNode.ts`) gains a `childRan` field so the top-level wrapper can
tell "the child ran and already had its own chance to speak" apart from "the relaunch mechanism
itself failed and no child ever started" — the latter must still speak.

**Tech Stack:** TypeScript (ESM, `tsup` build), Vitest for unit tests, `execa` for process
spawning, Windows `powershell.exe` + `SAPI.SpVoice` COM object for speech.

## Global Constraints

- Spoken message is exactly: `Configamatron is down` — spoken once via the native Windows **SAPI
  COM** voice (`SAPI.SpVoice`), not the managed `System.Speech` synthesizer.
- The alert is spawned as a **detached PowerShell one-liner that Node does not wait on**.
- A clean shutdown — **Ctrl-C/SIGINT, or SIGTERM** — stays silent.
- The alert fires for every abnormal exit: startup failures (Docker unavailable, unreadable/invalid
  config, certificate error, port conflict, failed relaunch) and runtime crashes.
- Implemented as **one top-level choke point** — wrapping the whole command action plus
  `process.on('uncaughtException')`/`('unhandledRejection')` — not a call added at each early-exit
  site.
- In the relaunch topology, only the process that actually reached the failure ever speaks; a
  parent that merely mirrors a child's exit code must not speak again for the same failure.
- Speaking is **best-effort and bounded**: a failed or slow SAPI spawn must never change, delay, or
  replace `run-proxy`'s original exit result. There is no confirmation the speech was heard or even
  started.
- A **single in-process guard** ensures the alert speaks at most once per process, even if multiple
  failure signals fire in sequence.
- Windows-host-specific, consistent with the project's Hyper-V-only host target.

---

## File Structure

- **Create** `src/runProxy/abnormalExitAlert.ts` — the guarded alert (`createAbnormalExitAlert`),
  the SAPI command builder (`buildSpeakCommand`), the real detached spawn (`speakAlert`), and the
  real-deps factory (`createRealAbnormalExitAlert`). Mirrors the existing
  `relaunchViaDedicatedNode.ts` split between a pure, injectable-deps function and a "wires real
  process access" factory that itself stays untested.
- **Create** `tests/unit/abnormalExitAlert.test.ts` — unit tests for the guard, the command
  builder, and (with `execa` mocked) the real spawn's shape (detached, unref'd, never awaited).
- **Modify** `src/runProxy/relaunchViaDedicatedNode.ts` — add `childRan` to `RelaunchResult` and a
  `relaunchFailedWithNoChild` predicate so the caller can tell the two `relaunched: true` cases
  apart.
- **Modify** `tests/unit/runtimeRelaunch.test.ts` — update the three `relaunched: true` assertions
  for the new field; add tests for `relaunchFailedWithNoChild`.
- **Modify** `src/runProxy/runProxyLoop.ts` — add `onSigterm` to `RunProxyDeps` and register it
  alongside `onSigint` as a second, equally-clean shutdown signal (`shutdown(0)`).
- **Modify** `tests/unit/proxyStackSupervisor.test.ts` — extend the harness with `fireSigterm`;
  add a SIGTERM shutdown test mirroring the existing SIGINT one.
- **Modify** `src/commands/runProxy.ts` — wire the real `onSigterm` dep, install the alert +
  process-level exception handlers, and make the relaunch branch and the rest of the action trigger
  the alert exactly when required.

---

### Task 1: Distinguish "child ran" from "relaunch mechanism failed" in `RelaunchResult`

**Files:**

- Modify: `src/runProxy/relaunchViaDedicatedNode.ts:37` (type), `:121-129` (return sites)
- Test: `tests/unit/runtimeRelaunch.test.ts`

**Interfaces:**

- Produces: `RelaunchResult` gains a `childRan: boolean` field on the `relaunched: true` branch;
  new `relaunchFailedWithNoChild(result: RelaunchResult): boolean` — later tasks use this exported
  predicate to decide whether the top-level alert must fire for a relaunch outcome.

Today `relaunchIfNeeded` returns `{ relaunched: true, exitCode }` for *both* "the dedicated child
process actually ran and exited" and "the child was signal-killed or never spawned at all" — the
ADR's silence rule ("stay silent whenever `relaunchIfNeeded` reports a child actually ran") can't
be implemented correctly against the current 2-branch union, because both cases report
`relaunched: true`. Only the first case had a chance to speak for itself; the second must still
trigger the top-level alert.

- [ ] **Step 1: Write the failing tests for the new field**

Edit `tests/unit/runtimeRelaunch.test.ts`. Update the three existing assertions in the
`'relaunch decision'` describe block that check `relaunched: true` results, and add the new
predicate tests at the end of that block:

```ts
    it('ensures the copy, installs a SIGINT listener, and spawns argv.slice(1) on the dedicated path', async () => {
      const deps = makeDeps({
        fileSize: vi.fn((path: string) => (path === SOURCE ? 100 : null)),
      });

      const result = await relaunchIfNeeded(deps);

      expect(deps.copyFile).toHaveBeenCalledWith(SOURCE, DEDICATED);
      expect(deps.onSigint).toHaveBeenCalledTimes(1);
      expect(deps.spawn).toHaveBeenCalledWith(DEDICATED, ['C:\\cli\\cli.js', 'run-proxy'], {
        cwd: 'C:\\project',
        env: { FOO: 'bar' },
      });
      expect(result).toEqual({ relaunched: true, childRan: true, exitCode: 0 });
    });

    it('propagates a non-zero exit code', async () => {
      const deps = makeDeps({ spawn: vi.fn(async () => ({ exitCode: 7 })) });
      const result = await relaunchIfNeeded(deps);
      expect(result).toEqual({ relaunched: true, childRan: true, exitCode: 7 });
    });

    it('falls back to a fixed exit code when the child was terminated by signal', async () => {
      const deps = makeDeps({ spawn: vi.fn(async () => ({ signal: 'SIGTERM' })) });
      const result = await relaunchIfNeeded(deps);
      expect(result).toEqual({ relaunched: true, childRan: false, exitCode: 1 });
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining('terminated by signal SIGTERM'),
      );
    });

    it('falls back to a fixed exit code when spawn could not launch the process at all', async () => {
      const deps = makeDeps({ spawn: vi.fn(async () => ({})) });
      const result = await relaunchIfNeeded(deps);
      expect(result).toEqual({ relaunched: true, childRan: false, exitCode: 1 });
      expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('failed to launch'));
    });
  });

  describe('relaunchFailedWithNoChild', () => {
    it('is false when relaunch did not happen at all', () => {
      expect(relaunchFailedWithNoChild({ relaunched: false })).toBe(false);
    });

    it('is false when a child actually ran', () => {
      expect(relaunchFailedWithNoChild({ relaunched: true, childRan: true, exitCode: 0 })).toBe(
        false,
      );
    });

    it('is true when the relaunch mechanism failed before any child ran', () => {
      expect(relaunchFailedWithNoChild({ relaunched: true, childRan: false, exitCode: 1 })).toBe(
        true,
      );
    });
  });
```

Also update the import at the top of the file to pull in `relaunchFailedWithNoChild`:

```ts
import {
  getDedicatedNodePath,
  ensureDedicatedNodeCopy,
  relaunchIfNeeded,
  relaunchFailedWithNoChild,
  type EnsureCopyDeps,
  type RelaunchDeps,
} from '../../src/runProxy/relaunchViaDedicatedNode';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/runtimeRelaunch.test.ts`
Expected: FAIL — `childRan` is missing from the actual results, and
`relaunchFailedWithNoChild` is not exported (TypeScript/import error).

- [ ] **Step 3: Implement the field and predicate**

Edit `src/runProxy/relaunchViaDedicatedNode.ts`. Replace the `RelaunchResult` type at line 37:

```ts
export type RelaunchResult =
  | { relaunched: true; childRan: true; exitCode: number }
  | { relaunched: true; childRan: false; exitCode: number }
  | { relaunched: false };

/**
 * True only when a relaunch was attempted but no child process ever ran — the child
 * itself had no chance to speak for its own failure, so the caller must.
 */
export function relaunchFailedWithNoChild(result: RelaunchResult): boolean {
  return result.relaunched && !result.childRan;
}
```

Replace the tail of `relaunchIfNeeded` (lines 121-129):

```ts
  if (result.exitCode !== undefined) {
    return { relaunched: true, childRan: true, exitCode: result.exitCode };
  }
  if (result.signal !== undefined) {
    deps.error(`run-proxy: dedicated node.exe copy was terminated by signal ${result.signal}`);
  } else {
    deps.error('run-proxy: failed to launch the dedicated node.exe copy');
  }
  return { relaunched: true, childRan: false, exitCode: FALLBACK_EXIT_CODE };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runtimeRelaunch.test.ts`
Expected: PASS (all tests in the file, including the three pre-existing describe blocks).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (the `RelaunchResult` union change is exhaustive; no other file destructures
it yet — that happens in Task 5).

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/relaunchViaDedicatedNode.ts tests/unit/runtimeRelaunch.test.ts
git commit -m "run-proxy: distinguish a relaunched child from a relaunch mechanism failure"
```

---

### Task 2: `createAbnormalExitAlert` — the guarded, injectable trigger

**Files:**

- Create: `src/runProxy/abnormalExitAlert.ts`
- Test: `tests/unit/abnormalExitAlert.test.ts`

**Interfaces:**

- Produces: `AbnormalExitAlertDeps { platform: NodeJS.Platform; speak: () => void }`,
  `AbnormalExitAlert { trigger: () => void }`, `createAbnormalExitAlert(deps: AbnormalExitAlertDeps): AbnormalExitAlert`.
  Task 5 constructs one of these per `run-proxy` invocation and calls `.trigger()` from every
  failure path.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/abnormalExitAlert.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createAbnormalExitAlert, type AbnormalExitAlertDeps } from '../../src/runProxy/abnormalExitAlert';

function makeDeps(overrides: Partial<AbnormalExitAlertDeps> = {}): AbnormalExitAlertDeps {
  return {
    platform: 'win32',
    speak: vi.fn(),
    ...overrides,
  };
}

describe('createAbnormalExitAlert', () => {
  it('speaks on the first trigger', () => {
    const deps = makeDeps();
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();

    expect(deps.speak).toHaveBeenCalledTimes(1);
  });

  it('never speaks a second time in the same process', () => {
    const deps = makeDeps();
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();
    alert.trigger();
    alert.trigger();

    expect(deps.speak).toHaveBeenCalledTimes(1);
  });

  it('does not speak on a non-Windows platform', () => {
    const deps = makeDeps({ platform: 'linux' });
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();

    expect(deps.speak).not.toHaveBeenCalled();
  });

  it('swallows an exception from a failing speak call instead of throwing', () => {
    const deps = makeDeps({
      speak: vi.fn(() => {
        throw new Error('spawn exploded');
      }),
    });
    const alert = createAbnormalExitAlert(deps);

    expect(() => alert.trigger()).not.toThrow();
  });

  it('still counts a throwing speak call as having triggered, so it is not retried', () => {
    const deps = makeDeps({
      speak: vi.fn(() => {
        throw new Error('spawn exploded');
      }),
    });
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();
    alert.trigger();

    expect(deps.speak).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/abnormalExitAlert.test.ts`
Expected: FAIL — cannot find module `../../src/runProxy/abnormalExitAlert`.

- [ ] **Step 3: Implement `createAbnormalExitAlert`**

Create `src/runProxy/abnormalExitAlert.ts`:

```ts
export interface AbnormalExitAlertDeps {
  platform: NodeJS.Platform;
  speak: () => void;
}

export interface AbnormalExitAlert {
  trigger: () => void;
}

/**
 * Speaks at most once per process, even if multiple failure signals fire in sequence
 * (e.g. a caught fatal error followed by an uncaughtException during teardown).
 * Windows-only: the SAPI voice this drives has no non-Windows equivalent in this project.
 */
export function createAbnormalExitAlert(deps: AbnormalExitAlertDeps): AbnormalExitAlert {
  let spoken = false;
  return {
    trigger(): void {
      if (spoken || deps.platform !== 'win32') return;
      spoken = true;
      try {
        deps.speak();
      } catch {
        // best-effort: a failed/slow alert must never affect run-proxy's exit result
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/abnormalExitAlert.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/abnormalExitAlert.ts tests/unit/abnormalExitAlert.test.ts
git commit -m "run-proxy: add the guarded abnormal-exit alert trigger"
```

---

### Task 3: `buildSpeakCommand` + `speakAlert` — the real detached SAPI spawn

**Files:**

- Modify: `src/runProxy/abnormalExitAlert.ts`
- Modify: `tests/unit/abnormalExitAlert.test.ts`

**Interfaces:**

- Consumes: `execa` from the `execa` package (already a project dependency, `^9.6.1`).
- Produces: `buildSpeakCommand(message: string): string`; `speakAlert(): void`;
  `createRealAbnormalExitAlert(): AbnormalExitAlert` — the real-deps factory Task 5 calls once per
  `run-proxy` invocation.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/abnormalExitAlert.test.ts`. First extend the top-of-file imports and add a
mock for `execa` (must be declared before any `describe` block — `vi.mock` calls are hoisted, but
keep it at the top for clarity):

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  createAbnormalExitAlert,
  buildSpeakCommand,
  speakAlert,
  type AbnormalExitAlertDeps,
} from '../../src/runProxy/abnormalExitAlert';

const mockUnref = vi.fn();
const mockExeca = vi.fn(() => ({ unref: mockUnref }));
vi.mock('execa', () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));
```

Then add two new `describe` blocks at the end of the file:

```ts
describe('buildSpeakCommand', () => {
  it('drives the SAPI COM voice, not System.Speech', () => {
    const command = buildSpeakCommand('Configamatron is down');

    expect(command).toContain('New-Object -ComObject SAPI.SpVoice');
    expect(command).toContain(".Speak('Configamatron is down')");
  });

  it('escapes an embedded single quote for PowerShell single-quoted strings', () => {
    const command = buildSpeakCommand("it's down");

    expect(command).toContain(".Speak('it''s down')");
  });
});

describe('speakAlert', () => {
  it('spawns a detached, unreferenced powershell.exe that is never awaited', () => {
    mockExeca.mockClear();
    mockUnref.mockClear();

    speakAlert();

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExeca.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-Command');
    expect(args[args.length - 1]).toContain('SAPI.SpVoice');
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/abnormalExitAlert.test.ts`
Expected: FAIL — `buildSpeakCommand` and `speakAlert` are not exported.

- [ ] **Step 3: Implement**

Append to `src/runProxy/abnormalExitAlert.ts` (add the `execa` import at the top of the file):

```ts
import { execa } from 'execa';
```

```ts
const SPOKEN_MESSAGE = 'Configamatron is down';

/** Builds the PowerShell one-liner that drives the SAPI COM voice (not System.Speech: SAPI needs no NuGet package under pwsh 7). */
export function buildSpeakCommand(message: string): string {
  const escaped = message.replace(/'/g, "''");
  return `(New-Object -ComObject SAPI.SpVoice).Speak('${escaped}')`;
}

/**
 * Fires a detached, unreferenced PowerShell process and returns immediately — never
 * awaited, so a slow or failed spawn cannot delay or change run-proxy's own exit.
 */
export function speakAlert(): void {
  const child = execa(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      buildSpeakCommand(SPOKEN_MESSAGE),
    ],
    { detached: true, stdio: 'ignore', reject: false },
  );
  child.unref();
}

/** Wires real process.platform + the real SAPI spawn; the only non-test caller. */
export function createRealAbnormalExitAlert(): AbnormalExitAlert {
  return createAbnormalExitAlert({ platform: process.platform, speak: speakAlert });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/abnormalExitAlert.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/abnormalExitAlert.ts tests/unit/abnormalExitAlert.test.ts
git commit -m "run-proxy: spawn the detached SAPI voice alert via powershell.exe"
```

---

### Task 4: SIGTERM is a second clean, silent shutdown signal in `runProxyLoop`

**Files:**

- Modify: `src/runProxy/runProxyLoop.ts:21-54` (interface), `:70,252-257,284` (shutdown wiring)
- Test: `tests/unit/proxyStackSupervisor.test.ts`

**Interfaces:**

- Consumes: none new.
- Produces: `RunProxyDeps.onSigterm: (handler: () => void) => void` — Task 5's real deps object in
  `src/commands/runProxy.ts` must supply this alongside the existing `onSigint`.

`runProxyLoop` already resolves with exit code `0` for SIGINT via `onSigintOnce`/`shutdown(0)`.
SIGTERM must resolve the same way — same log line shape, same "container left running" behavior —
so that Task 5's top-level wrapper (which only speaks when the final `process.exitCode` is
nonzero) naturally stays silent for it too, with no separate case to remember.

- [ ] **Step 1: Write the failing test**

In `tests/unit/proxyStackSupervisor.test.ts`, extend the `Harness` interface (after
`fireSigint: () => void;` at line 76):

```ts
  fireSigint: () => void;
  fireSigterm: () => void;
```

In `makeHarness`, declare a second callback slot next to `sigintCb` (near line 105):

```ts
  let sigintCb: (() => void) | null = null;
  let sigtermCb: (() => void) | null = null;
```

Wire it into the `deps` object next to `onSigint` (near line 152-154):

```ts
    onSigint: (handler) => {
      sigintCb = handler;
    },
    onSigterm: (handler) => {
      sigtermCb = handler;
    },
```

And return it from `makeHarness` next to `fireSigint` (near line 166):

```ts
    fireSigint: () => sigintCb?.(),
    fireSigterm: () => sigtermCb?.(),
```

Add a new test in the `describe('shutdown', ...)` block, right after the existing
`'SIGINT tears everything down once and exits 0; a second SIGINT is a no-op'` test (after line 641):

```ts
    it('SIGTERM tears everything down once and exits 0, same as SIGINT', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.log.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.fireSigterm();
      h.fireSigterm();
      await flush();

      await expect(exit).resolves.toBe(0);
      const sigtermLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGTERM'));
      expect(sigtermLogs).toHaveLength(1);
      expect(h.mocks.watchClose).toHaveBeenCalledTimes(2);
      expect(h.mocks.stopLogStream).toHaveBeenCalled();
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('a SIGINT after a SIGTERM (or vice versa) is a no-op — only the first shutdown signal wins', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runProxyLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      h.fireSigterm();
      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      const stopLogs = h.mocks.log.mock.calls.filter(
        (c) => String(c[0]).includes('SIGTERM') || String(c[0]).includes('SIGINT'),
      );
      expect(stopLogs).toHaveLength(1);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/proxyStackSupervisor.test.ts`
Expected: FAIL — TypeScript error (`onSigterm` missing from `RunProxyDeps`) and/or the new tests
timing out because `fireSigterm` never resolves anything.

- [ ] **Step 3: Implement**

Edit `src/runProxy/runProxyLoop.ts`. In the `RunProxyDeps` interface, add `onSigterm` right after
`onSigint` (line 50):

```ts
  onSigint: (handler: () => void) => void;
  onSigterm: (handler: () => void) => void;
```

Replace the single-signal shutdown handler. Change the `sigintSeen` flag and `onSigintOnce`
function (lines 70, 252-257) to a signal-name-aware version that either signal can trigger once:

```ts
    let stopSignalSeen = false;
```

```ts
    const onStopSignal = (signalName: 'SIGINT' | 'SIGTERM'): void => {
      if (stopSignalSeen || settled) return;
      stopSignalSeen = true;
      deps.log(`run-proxy: ${signalName} received, stopping (container left running)`);
      shutdown(0);
    };
```

Register both signals where `deps.onSigint(onSigintOnce)` was called (line 284):

```ts
      deps.onSigint(() => onStopSignal('SIGINT'));
      deps.onSigterm(() => onStopSignal('SIGTERM'));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/proxyStackSupervisor.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL at this point — `src/commands/runProxy.ts` builds a `RunProxyDeps` object that is
now missing the required `onSigterm` field. This is expected; Task 5 supplies it. Confirm the
*only* error reported is the missing `onSigterm` property in `src/commands/runProxy.ts`, to make
sure Step 3 didn't introduce anything else.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/runProxyLoop.ts tests/unit/proxyStackSupervisor.test.ts
git commit -m "run-proxy: treat SIGTERM as a second clean, silent shutdown signal"
```

---

### Task 5: Wire the alert into the `run-proxy` command

**Files:**

- Modify: `src/commands/runProxy.ts`

**Interfaces:**

- Consumes: `createRealAbnormalExitAlert` and `AbnormalExitAlert` from
  `../runProxy/abnormalExitAlert` (Tasks 2-3); `relaunchFailedWithNoChild` from
  `../runProxy/relaunchViaDedicatedNode` (Task 1); `RunProxyDeps.onSigterm` (Task 4).
- Produces: nothing new for other tasks — this is the outermost wiring layer.

This task has no new automated test. The pure decision logic it uses
(`createAbnormalExitAlert`'s guard, `relaunchFailedWithNoChild`, and SIGTERM's silent exit code)
is already unit-tested in Tasks 1, 2, and 4; `createRealAbnormalExitAlert` and the `process.on(...)`
registration are real-deps wiring in the same spirit as `createRelaunchDeps` (line 155 of
`relaunchViaDedicatedNode.ts`), which today also has no dedicated unit test — invoking
`registerRunProxy(...).action(...)` for real would spawn Docker and touch the filesystem, which is
out of scope for a unit test and is instead covered by the project's `test:proxy-stack` /
`test:cli` suites and the manual verification in Step 5 below. Keep the existing
`tests/unit/commands/runProxy.test.ts` option-surface test passing as a smoke check that
`registerRunProxy` still builds a valid command.

- [ ] **Step 1: Add the two new imports**

Edit `src/commands/runProxy.ts`. Add to the import block (after line 28,
`import { relaunchIfNeeded, createRelaunchDeps } from '../runProxy/relaunchViaDedicatedNode';`):

```ts
import {
  relaunchIfNeeded,
  createRelaunchDeps,
  relaunchFailedWithNoChild,
} from '../runProxy/relaunchViaDedicatedNode';
import { createRealAbnormalExitAlert, type AbnormalExitAlert } from '../runProxy/abnormalExitAlert';
```

(Replace the existing single-line import for `relaunchViaDedicatedNode` with the first block above,
and add the second line right after it.)

- [ ] **Step 2: Install the alert + process-level exception handlers at the top of the action**

Replace the start of the `.action(async (options: RunProxyOptions) => {` body (lines 97-110) with:

```ts
    .action(async (options: RunProxyOptions) => {
      const alert = createRealAbnormalExitAlert();
      installAbnormalExitHandlers(alert);

      try {
        const relaunch = await relaunchIfNeeded(createRelaunchDeps(options.forward));
        if (relaunch.relaunched) {
          process.exitCode = relaunch.exitCode;
          if (relaunchFailedWithNoChild(relaunch)) alert.trigger();
          return;
        }
      } catch (err) {
        console.error(
          `run-proxy: failed to relaunch through the dedicated node.exe copy: ${String(err)}`,
        );
        process.exitCode = 1;
        alert.trigger();
        return;
      }
```

- [ ] **Step 3: Wrap the rest of the action so any nonzero final exit code speaks**

The remainder of the action (everything from `const paths = requireEnvPathsOrExit('run-proxy');` at
line 112 through the closing of the `try { ... } finally { await services.closeAll(); }` block at
line 298) already runs to completion via a mix of early `return`s (each already sets
`process.exitCode = 1`) and the final `runProxyLoop` result (which sets `process.exitCode` to
whatever `runProxyLoop` resolved with — `0` for SIGINT/SIGTERM, `1` for any fatal error). Wrap that
entire remainder in one more `try/finally` so a single check after it settles catches every one of
those paths, plus anything that throws and isn't already caught:

```ts
      try {
        const paths = requireEnvPathsOrExit('run-proxy');
        if (!paths) return;
        // ... (unchanged: everything from the current line 114 through line 298) ...
      } finally {
        if ((process.exitCode ?? 0) !== 0) alert.trigger();
      }
    });
```

Concretely: indent the existing body (lines 112-298) one level inside a new `try { ... } finally {
if ((process.exitCode ?? 0) !== 0) alert.trigger(); }`, leaving every statement inside it — the CA
check, the gateway/DNS/DHCP bind failures, the `deps` object, the channel configs, and the final
`runProxyLoop` call with its own `try { ... } finally { await services.closeAll(); }` — otherwise
untouched. Do not add a `catch` clause here: any exception that isn't already handled by an inner
`try/catch` should still propagate up to the `process.on('uncaughtException')`/`('unhandledRejection')`
handlers installed in Step 4, and the outer `finally` still runs before that propagation completes,
so `process.exitCode` may not yet be set in that case — that's fine, because the exception handlers
themselves call `alert.trigger()` too (Step 4) and the guard from Task 2 makes a duplicate call
harmless.

- [ ] **Step 4: Add `installAbnormalExitHandlers`**

Add this new function above `registerRunProxy` (after the `collectOverride` function, before line
50):

```ts
/**
 * `uncaughtException`/`unhandledRejection` are the catch-all beneath every other guard: any
 * future failure path that doesn't set process.exitCode itself, or that throws where nothing
 * local catches it, still speaks the alert instead of failing silently.
 */
function installAbnormalExitHandlers(alert: AbnormalExitAlert): void {
  process.on('uncaughtException', (err) => {
    console.error(`run-proxy: uncaught exception: ${String(err)}`);
    process.exitCode = 1;
    alert.trigger();
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`run-proxy: unhandled rejection: ${String(reason)}`);
    process.exitCode = 1;
    alert.trigger();
  });
}
```

- [ ] **Step 5: Add the real `onSigterm` dep**

In the `deps: RunProxyDeps` object literal (around line 249), add `onSigterm` right after
`onSigint`:

```ts
        onSigint: (handler) => process.on('SIGINT', handler),
        onSigterm: (handler) => process.on('SIGTERM', handler),
```

- [ ] **Step 6: Run the existing command test and typecheck**

Run: `pnpm exec vitest run tests/unit/commands/runProxy.test.ts && pnpm typecheck`
Expected: PASS — the option-surface test still passes, and the `RunProxyDeps` object now satisfies
the interface (no missing `onSigterm`, resolving the expected Task 4 typecheck failure).

- [ ] **Step 7: Run the full unit suite**

Run: `pnpm test:unit`
Expected: PASS — all unit tests across the project, including every test added in Tasks 1-4.

- [ ] **Step 8: Lint and format**

Run: `pnpm lint && pnpm format:check`
Expected: no errors. If `format:check` fails, run `pnpm format` and re-check.

- [ ] **Step 9: Commit**

```bash
git add src/commands/runProxy.ts
git commit -m "run-proxy: speak an audible alert on abnormal exit"
```

---

### Task 6: Manual verification on a real Windows host

**Files:** none (verification only).

Automated coverage stops at the unit-tested building blocks — there is no way to assert "the
Windows SAPI voice was actually heard" in CI, and the ADR itself notes there is no confirmation
that the speech was heard or even started. Verify by ear on a real Windows host with a working
`.configamatron` environment (`configamatron init` already run) and Docker Desktop available.

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: succeeds, `dist/cli.js` is produced.

- [ ] **Step 2: Trigger a startup failure and confirm it speaks**

Run: `node dist/cli.js run-proxy --credentials C:\does\not\exist.json`
Expected: the console prints `run-proxy: could not read claude credentials at
C:\does\not\exist.json` (from `runProxyLoop`'s `fatal()`), the process exits with a nonzero code,
and — audibly — you hear "Configamatron is down" spoken once shortly after.

- [ ] **Step 3: Confirm a clean Ctrl-C stays silent**

Run: `node dist/cli.js run-proxy` in a working environment, wait for
`run-proxy: watching credentials and allowlist; ...`, then press Ctrl-C.
Expected: the console prints the SIGINT log line, the process exits 0, the container is left
running (per the command's own description), and no speech is heard.

- [ ] **Step 4: Confirm a SIGTERM sent by another Node process stays silent**

Windows has no native signals; `taskkill`/`Stop-Process` do not trigger Node's `'SIGTERM'` event on
Windows — only `process.kill(pid, 'SIGTERM')` from another Node/libuv process does. Start
`node dist/cli.js run-proxy` in one terminal, note its PID from Task Manager or
`Get-Process node | Select-Object Id,StartTime`, then in a second terminal run:

`node -e "process.kill(<PID>, 'SIGTERM')"`

Expected: same as Step 3 — SIGTERM log line, exit 0, no speech.

- [ ] **Step 5: Confirm a runtime crash still speaks**

With `run-proxy` running normally, stop Docker Desktop entirely (or otherwise force a runtime
failure the loop's `fatal()` will hit, e.g. deleting `envoy.yaml`'s directory permissions).
Expected: the failure is logged, the process exits nonzero, and you hear "Configamatron is down"
once.

- [ ] **Step 6: Confirm the message never repeats within one process**

In any of the failure scenarios above, note that only one utterance is heard even though a fatal
error can be followed by teardown-time noise (e.g. `services.closeAll()` failures) — the guard from
Task 2 ensures at most one `Speak(...)` call per process.

Report the outcome of Steps 2-6 back before considering this ADR's behavior verified end to end.

---

## Notes on scope not covered by this plan

- The relaunch **parent** process installs a no-op `SIGINT` listener purely to survive Windows'
  `CTRL_C_EVENT` (see the comment at `relaunchViaDedicatedNode.ts:109-113`); it has no equivalent
  `SIGTERM` handling and none is added here. Windows does not deliver `SIGTERM` to a process tree
  the way `CTRL_C_EVENT` is delivered, so the same premature-death risk does not apply — this is
  consistent with [[loopback-publish-with-node-forwarder]] and out of scope for this ADR, which is
  about alerting, not relaunch-topology signal propagation.

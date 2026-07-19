# run-proxy Robustness Implementation Plan

**Goal:** Make `run-proxy` respond to Ctrl+C immediately during a readiness/drain wait, and fast-fail when a freshly-started color's container has exited — instead of wedging or waiting out the 60 s timeout.

**Architecture:** A single `AbortController` owned by `runProxyLoop` is threaded (as an `AbortSignal`) into the two long-poll dependencies (`waitColorReady`, gateway `drain`); `shutdown()` aborts it so every in-flight sleep resolves at once. `waitColorReady` additionally consults an injected liveness check (backed by a new `docker inspect` probe) and returns a discriminated `WaitResult` so a dead container is reported as `'exited'` rather than `'timeout'`. A test-only `--inject-fault` option mutates the rendered `envoy.yaml` to deterministically reproduce a crashing config or a never-ready color.

**Tech Stack:** TypeScript (ESM, strict), Node ≥18 (global `AbortController`/`AbortSignal`), `execa` for docker, `vitest` (unit + integration configs), `commander` for CLI, `yaml` for config rendering, Envoy `v1.31-latest` in docker compose.

## Global Constraints

- Node engine floor: `>=18` (`AbortController`/`AbortSignal` are Node globals — no import, no polyfill).
- Envoy image is pinned to `envoyproxy/envoy:v1.31-latest` (`templates/proxy/docker-compose.yml:4`); fault behavior is verified against it.
- Container names are `configamatron-envoy-blue` / `configamatron-envoy-green` (explicit `container_name:` in compose) — **not** the service names `envoy_blue`/`envoy_green`. `docker inspect` must use the container name.
- `crash-config` fault sets admin `port_value` to `70000` (> 65535 → Envoy bootstrap proto validation rejects it and the container exits non-zero before binding a listener).
- `never-ready` fault sets admin `port_value` to `9902` (off container port `9901`, the only admin port compose maps) — Envoy stays healthy but the host admin probe is refused forever.
- With no `--inject-fault`, the rendered `envoy.yaml` must be **byte-for-byte unchanged** (admin `port_value` stays `9901`).
- The distinguishing failure log for a dead container must contain the exact substring `exited during startup` (asserted by the e2e suite).
- The CLI option is `--inject-fault <crash-config|never-ready>` and its help text ends with `(test use only)`, mirroring the existing `--upstream-override` convention.
- Drain-on-abort **returns early without force-closing**; connection teardown is deferred to `gateway.close()` (called in `src/commands/runProxy.ts` `finally`).
- Integration tests run serially (`vitest.integration.config.ts` sets `fileParallelism: false`); each file does its own `docker compose down`.
- Every task ends green: `pnpm typecheck` and `pnpm lint` pass, and the task's tests pass.

---

## File Structure

**New files**

- `src/runProxy/abortableSleep.ts` — a `sleep(ms, signal?)` helper that also resolves (non-throwing) the moment `signal` aborts. Shared by `waitColorReady` and gateway `drain` (DRY; both previously had their own `setTimeout` sleep).
- `src/runProxy/isColorRunning.ts` — `isColorRunning(color, composeDir)`, a `docker inspect` liveness probe returning `false` for exited/missing containers.
- `tests/unit/runProxy/abortableSleep.test.ts`
- `tests/integration/isColorRunning.test.ts`
- `tests/integration/runProxyRobustness.test.ts`

**Modified files**

- `src/runProxy/waitColorReady.ts` — use the abortable sleep, add the abort check, add the injected liveness check, widen the return to `WaitResult`.
- `src/runProxy/gateway.ts` — `drain` gains an `AbortSignal`; abort → early return, no force-close.
- `src/runProxy/runProxyLoop.ts` — own an `AbortController`, abort in `shutdown()`, thread `signal` (and, for `waitColorReady`, `color`) into the deps, handle `WaitResult`, emit the distinguishing log; update `RunProxyDeps`.
- `src/commands/runProxy.ts` — `--inject-fault` option; dep wrappers pass `signal`, `color`, the `isColorRunning`-backed liveness check, and the fault.
- `src/envoyConfig.ts` — `InjectFault` type; `fault` option applied as a render-time admin-port mutation.
- `src/runProxy/buildConfig.ts` — `writeEnvoyConfig` gains a `fault` parameter.
- `tests/unit/runProxy/waitColorReady.test.ts`, `tests/unit/runProxy/gateway.test.ts`, `tests/unit/runProxy/runProxyLoop.test.ts`, `tests/unit/envoyConfig.test.ts` — updated/extended.

**Task dependency order:** 1 → 2 → 3 → 4 (needs 1, 2) → 5 → 6 (needs 2, 3, 4, 5). Tasks 3 and 4 both touch `waitColorReady`/`runProxyLoop`/the command, but each is a distinct, independently-reviewable feature (Goal 1 shutdown-abort vs. Goal 2 fast-fail) and each leaves the tree typechecking and green.

---

### Task 1: Abortable sleep helper

**Files:**

- Create: `src/runProxy/abortableSleep.ts`
- Test: `tests/unit/runProxy/abortableSleep.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `sleep(ms: number, signal?: AbortSignal): Promise<void>` — resolves after `ms`, or immediately (without throwing) if `signal` is already aborted or aborts during the wait.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/abortableSleep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sleep } from '../../../src/runProxy/abortableSleep';

describe('sleep', () => {
  it('resolves after the delay when there is no signal', async () => {
    const start = Date.now();
    await sleep(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('resolves promptly when the signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/abortableSleep.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/abortableSleep`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/abortableSleep.ts`:

```ts
/**
 * Sleep that also resolves — without throwing — the moment `signal` aborts, so a
 * poll loop built on it bails out immediately on shutdown instead of waiting out
 * the full delay. With no signal (or a signal that never aborts) it behaves like
 * a plain setTimeout.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/abortableSleep.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/runProxy/abortableSleep.ts tests/unit/runProxy/abortableSleep.test.ts
git commit -m "feat(run-proxy): add abortable sleep helper"
```

---

### Task 2: Container liveness probe (`isColorRunning`)

**Files:**

- Create: `src/runProxy/isColorRunning.ts`
- Test: `tests/integration/isColorRunning.test.ts`

**Interfaces:**

- Consumes: `Color` from `src/runProxy/types.ts`.
- Produces: `isColorRunning(color: Color, composeDir: string): Promise<boolean>` — `true` only when `configamatron-envoy-<color>` is running; `false` when it has exited or does not exist.

Note: this is a thin `docker inspect` wrapper, so it is gated by a real-docker integration test (not a unit test). The `false`-for-missing-container case is where the container-name subtlety bites, so it is worth an explicit test.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/isColorRunning.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import { isColorRunning } from '../../src/runProxy/isColorRunning';

// Guarantee the containers do not exist, regardless of other integration tests.
beforeAll(async () => {
  for (const name of ['configamatron-envoy-blue', 'configamatron-envoy-green']) {
    await execa('docker', ['rm', '-f', name], { reject: false });
  }
});

describe('isColorRunning', () => {
  it('returns false when the container does not exist', async () => {
    expect(await isColorRunning('blue', tmpdir())).toBe(false);
    expect(await isColorRunning('green', tmpdir())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/isColorRunning.test.ts`
Expected: FAIL — cannot resolve `../../src/runProxy/isColorRunning`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/isColorRunning.ts`:

```ts
import { execa } from 'execa';
import type { Color } from './types';

/**
 * True only when this color's Envoy container is currently running. A container
 * that has exited (e.g. Envoy rejected its config and quit) or that does not
 * exist yields false — the signal run-proxy uses to fast-fail instead of waiting
 * out the readiness timeout. Any inspect failure is treated as "not running".
 *
 * The container is named `configamatron-envoy-<color>` (an explicit
 * container_name in the compose template), which is what `docker inspect`
 * matches — the compose *service* name `envoy_<color>` would not resolve here.
 */
export async function isColorRunning(color: Color, composeDir: string): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'docker',
      ['inspect', '--format', '{{.State.Running}}', `configamatron-envoy-${color}`],
      { cwd: composeDir },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/isColorRunning.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/runProxy/isColorRunning.ts tests/integration/isColorRunning.test.ts
git commit -m "feat(run-proxy): add docker container liveness probe"
```

---

### Task 3: Shutdown abort (AbortSignal threading)

Threads a single `AbortController` from `runProxyLoop.shutdown()` into `waitColorReady` and gateway `drain` so Ctrl+C interrupts an in-flight wait immediately. `waitColorReady` keeps its `boolean` return in this task (Task 4 widens it).

**Files:**

- Modify: `src/runProxy/waitColorReady.ts:22,30-41`
- Modify: `src/runProxy/gateway.ts:22,95-99,1`
- Modify: `src/runProxy/runProxyLoop.ts:38,42,101-108,293,310,385`
- Modify: `src/commands/runProxy.ts:152-157`
- Test: `tests/unit/runProxy/waitColorReady.test.ts`, `tests/unit/runProxy/gateway.test.ts`, `tests/unit/runProxy/runProxyLoop.test.ts`

**Interfaces:**

- Consumes: `sleep` (Task 1).
- Produces (this task's shapes):
  - `waitColorReady(adminPort: number, timeoutMs: number, signal: AbortSignal, sleepMs?: number): Promise<boolean>`
  - `GatewayHandle.drain(target: GatewayTarget, timeoutMs: number, signal: AbortSignal): Promise<void>`
  - `RunProxyDeps.waitColorReady: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<boolean>`
  - `RunProxyDeps.drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<void>`

- [ ] **Step 1: Write the failing unit tests**

Update `tests/unit/runProxy/waitColorReady.test.ts` — replace the two existing test bodies to pass a signal, and add an abort test. Full new file:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitColorReady } from '../../../src/runProxy/waitColorReady';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function listen(handler: (n: number) => number): Promise<number> {
  let hits = 0;
  server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = handler(hits);
    res.end();
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

describe('waitColorReady', () => {
  it('resolves true once /ready returns 200 (after a few 503s)', async () => {
    const port = await listen((hits) => (hits >= 3 ? 200 : 503));
    const ac = new AbortController();
    expect(await waitColorReady(port, 5000, ac.signal, 20)).toBe(true);
  });

  it('resolves false when readiness never arrives before the timeout', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    expect(await waitColorReady(port, 300, ac.signal, 20)).toBe(false);
  });

  it('resolves false promptly when the signal is already aborted', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    expect(await waitColorReady(port, 10_000, ac.signal, 20)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
```

Update `tests/unit/runProxy/gateway.test.ts` — the two existing `gw.drain(...)` calls (lines 94 and 128) need a signal argument, and add an abort test. First patch the existing calls:

```ts
// line ~94 — was: gw.drain({ httpsPort: echo1.port, httpPort: 1 }, 2000)
const dp = gw
  .drain({ httpsPort: echo1.port, httpPort: 1 }, 2000, new AbortController().signal)
  .then(() => {
    drained = true;
  });
```

```ts
// line ~128 — was: await gw.drain({ httpsPort: echo.port, httpPort: 1 }, 300)
await gw.drain({ httpsPort: echo.port, httpPort: 1 }, 300, new AbortController().signal);
```

Then add this test inside the `describe('startGateway', ...)` block:

```ts
it('drain returns promptly on abort and does not force-close the lingering connection', async () => {
  const echo = await startTaggedEcho('one');
  const httpsListen = await freePort();
  const gw = await startGateway({
    listenAddresses: ['127.0.0.1'],
    httpsListenPort: httpsListen,
    httpListenPort: await freePort(),
    initialTarget: { httpsPort: echo.port, httpPort: 1 },
  });

  const sock = net.connect(httpsListen, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));
  await send(sock, 'x');

  const ac = new AbortController();
  ac.abort();
  const start = Date.now();
  await gw.drain({ httpsPort: echo.port, httpPort: 1 }, 30_000, ac.signal);
  expect(Date.now() - start).toBeLessThan(1000);
  expect(sock.destroyed).toBe(false); // teardown deferred to close()

  await gw.close();
  await echo.close();
});
```

Add the shutdown-abort test to `tests/unit/runProxy/runProxyLoop.test.ts` inside `describe('runProxyLoop shutdown', ...)`:

```ts
it('SIGINT while waiting for a color to become ready aborts the wait and exits 0', async () => {
  const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
  h.mocks.waitColorReady.mockImplementationOnce(
    (_ports: ColorPorts, _timeoutMs: number, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
  );
  const exit = runProxyLoop(baseConfig(), h.deps);
  await flush(); // parked in the startup waitColorReady

  h.fireSigint();
  await flush();

  await expect(exit).resolves.toBe(0);
  expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/runProxy/waitColorReady.test.ts tests/unit/runProxy/gateway.test.ts tests/unit/runProxy/runProxyLoop.test.ts`
Expected: FAIL — `waitColorReady` still takes `(adminPort, timeoutMs, sleepMs)`; `drain` takes 2 args; the loop never aborts the signal so the new shutdown test hangs/times out.

- [ ] **Step 3: Update `waitColorReady`**

In `src/runProxy/waitColorReady.ts`: remove the local `const sleep = ...` line (line 22), import the shared helper, and rewrite the function. Full new file:

```ts
import { request } from 'node:http';
import { sleep } from './abortableSleep';

/** One probe of a color's admin /ready; true iff it answers HTTP 200. */
export function adminReadyOnce(adminPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: adminPort, path: '/ready', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Poll a color's OWN admin /ready until it answers 200 (returns true) or the
 * timeout elapses (returns false). The signal short-circuits the wait: when it
 * aborts, the next check returns false immediately and the abortable sleep
 * resolves at once, so a Ctrl+C during startup is never blocked for the full
 * timeout.
 */
export async function waitColorReady(
  adminPort: number,
  timeoutMs: number,
  signal: AbortSignal,
  sleepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adminReadyOnce(adminPort)) return true;
    if (signal.aborted) return false;
    if (Date.now() >= deadline) return false;
    await sleep(sleepMs, signal);
  }
}
```

- [ ] **Step 4: Update gateway `drain`**

In `src/runProxy/gateway.ts`, add the import at the top:

```ts
import net from 'node:net';
import { sleep } from './abortableSleep';
```

Update the `GatewayHandle.drain` signature (line ~22):

```ts
  /** Resolve once no connections remain on `target`'s ports, or force-close at timeout. On abort, stop waiting and return (teardown is left to close()). */
  drain(target: GatewayTarget, timeoutMs: number, signal: AbortSignal): Promise<void>;
```

Replace the `drain` implementation (lines ~95-111):

```ts
      drain: async (t: GatewayTarget, timeoutMs: number, signal: AbortSignal): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (onTarget(t).length > 0 && Date.now() < deadline) {
          if (signal.aborted) return; // stop waiting; close() will destroy what remains
          await sleep(100, signal);
        }
        if (signal.aborted) return;
        await Promise.all(
          onTarget(t).map(
            (c) =>
              new Promise<void>((resolve) => {
                c.client.once('close', () => resolve());
                conns.delete(c);
                c.client.destroy();
                c.upstream.destroy();
              }),
          ),
        );
      },
```

- [ ] **Step 5: Update `RunProxyDeps` and thread the signal in `runProxyLoop`**

In `src/runProxy/runProxyLoop.ts`, update the two dep signatures (lines 37-42):

```ts
  /** Poll the color's own admin /ready; true once it serves, false on timeout/abort. */
  waitColorReady: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
  /** Point the gateway forwarder at this color's backend ports (the flip). */
  setActiveBackend: (ports: ColorPorts) => void;
  /** Wait for the old color's connections to drain, force-closing at timeout. */
  drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<void>;
```

Add the controller near the other loop state (just after `const unique = new UniqueTracker();`, line ~82):

```ts
    const unique = new UniqueTracker();
    const shutdownAbort = new AbortController();
```

Abort inside `shutdown()` (lines 101-108) — add the abort right after `settled = true;`:

```ts
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      shutdownAbort.abort();
      clearTimer();
      credentialsWatcher?.close();
      allowlistWatcher?.close();
      void deps.stopLogStream().then(() => resolve(code));
    };
```

Pass the signal at the three call sites. Swap-path readiness (line ~293):

```ts
              const ready = await deps.waitColorReady(idlePorts, config.readyTimeoutMs, shutdownAbort.signal);
```

Swap-path drain (line ~310):

```ts
                await deps.drainBackend(oldPorts, config.drainTimeoutMs, shutdownAbort.signal);
```

Startup readiness (line ~385):

```ts
        const ready = await deps.waitColorReady(ports, config.readyTimeoutMs, shutdownAbort.signal);
```

- [ ] **Step 6: Update the command dep wrappers**

In `src/commands/runProxy.ts` (lines 152-157):

```ts
        waitColorReady: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) =>
          waitColorReady(ports.adminPort, timeoutMs, signal),
        setActiveBackend: (ports: ColorPorts) =>
          gateway.setTarget({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }),
        drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) =>
          gateway.drain({ httpsPort: ports.httpsPort, httpPort: ports.httpPort }, timeoutMs, signal),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runProxy/waitColorReady.test.ts tests/unit/runProxy/gateway.test.ts tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS (all files, including the new abort tests).

- [ ] **Step 8: Full unit suite, typecheck, lint, commit**

```bash
pnpm test:unit
pnpm typecheck
pnpm lint
git add src/runProxy/waitColorReady.ts src/runProxy/gateway.ts src/runProxy/runProxyLoop.ts src/commands/runProxy.ts tests/unit/runProxy/waitColorReady.test.ts tests/unit/runProxy/gateway.test.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "feat(run-proxy): abort in-flight readiness/drain waits on shutdown"
```

---

### Task 4: Container-exit fast-fail (`WaitResult` + liveness)

Widens `waitColorReady` to return a `WaitResult`, consult an injected liveness check, and lets `runProxyLoop` emit a distinguishing log for a dead container.

**Files:**

- Modify: `src/runProxy/waitColorReady.ts`
- Modify: `src/runProxy/runProxyLoop.ts:1-8,38,293-299,385-390`
- Modify: `src/commands/runProxy.ts:19,152-153`
- Test: `tests/unit/runProxy/waitColorReady.test.ts`, `tests/unit/runProxy/runProxyLoop.test.ts`

**Interfaces:**

- Consumes: `isColorRunning` (Task 2), the abortable `waitColorReady` (Task 3).
- Produces:
  - `type WaitResult = { ready: true } | { ready: false; reason: 'exited' | 'timeout' }` (exported from `waitColorReady.ts`).
  - `waitColorReady(adminPort: number, timeoutMs: number, signal: AbortSignal, isAlive: () => Promise<boolean>, sleepMs?: number): Promise<WaitResult>`
  - `RunProxyDeps.waitColorReady: (color: Color, ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<WaitResult>`

- [ ] **Step 1: Write the failing unit tests**

Rewrite `tests/unit/runProxy/waitColorReady.test.ts` to the new signature and return shape. Full new file:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitColorReady } from '../../../src/runProxy/waitColorReady';

let server: Server | undefined;
const alive = async (): Promise<boolean> => true;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function listen(handler: (n: number) => number): Promise<number> {
  let hits = 0;
  server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = handler(hits);
    res.end();
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

describe('waitColorReady', () => {
  it('resolves ready once /ready returns 200 (after a few 503s)', async () => {
    const port = await listen((hits) => (hits >= 3 ? 200 : 503));
    const ac = new AbortController();
    expect(await waitColorReady(port, 5000, ac.signal, alive, 20)).toEqual({ ready: true });
  });

  it('resolves timeout when readiness never arrives (container stays alive)', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    expect(await waitColorReady(port, 300, ac.signal, alive, 20)).toEqual({
      ready: false,
      reason: 'timeout',
    });
  });

  it('resolves timeout promptly when the signal is already aborted', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    expect(await waitColorReady(port, 10_000, ac.signal, alive, 20)).toEqual({
      ready: false,
      reason: 'timeout',
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves exited promptly when the container is not running', async () => {
    const port = await listen(() => 503);
    const ac = new AbortController();
    const dead = async (): Promise<boolean> => false;
    const start = Date.now();
    expect(await waitColorReady(port, 10_000, ac.signal, dead, 20)).toEqual({
      ready: false,
      reason: 'exited',
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
```

Update `tests/unit/runProxy/runProxyLoop.test.ts`:

1. Harness default (line ~90): `waitColorReady: vi.fn().mockResolvedValue({ ready: true }),`
2. Startup never-ready test (line ~201): `h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'timeout' });`
3. Swap never-ready test (line ~383): `h.mocks.waitColorReady.mockResolvedValueOnce({ ready: false, reason: 'timeout' });`
4. Task 3's shutdown-abort test mock now resolves the new shape on abort:

```ts
  h.mocks.waitColorReady.mockImplementationOnce(
    (_color: Color, _ports: ColorPorts, _timeoutMs: number, signal: AbortSignal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ready: false, reason: 'timeout' }), {
          once: true,
        });
      }),
  );
```

(Add `Color` to the type import at the top: `import type { Credentials, ColorPorts, Color } from '../../../src/runProxy/types';`.)

5. Add the swap-path exit test to `describe('runProxyLoop credential changes', ...)` (it is driven by a credential rotation) and the startup exit test to `describe('runProxyLoop startup', ...)`:

```ts
  it('keeps the previous proxy and logs the exit hint when a swap color exits during startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.mocks.waitColorReady.mockResolvedValueOnce({ ready: false, reason: 'exited' });
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('exited during startup'));
    expect(h.mocks.stopColor).toHaveBeenCalledWith('green');
    let settled = false;
    void exit.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false); // non-fatal on a restart
  });
```

```ts
  it('exits 1 with the exit hint when blue exits during startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'exited' });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('exited during startup'));
    expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
  });
```

Also update the `mocks.waitColorReady` type comment/shape is inferred; the `waitColorReady` entry in the `mocks` interface (line ~53) stays `ReturnType<typeof vi.fn>` — no change needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/runProxy/waitColorReady.test.ts tests/unit/runProxy/runProxyLoop.test.ts`
Expected: FAIL — `waitColorReady` returns `boolean`, has no `isAlive` param; the loop treats the result as a boolean so the exit-hint assertions and `WaitResult` shapes don't match.

- [ ] **Step 3: Widen `waitColorReady`**

Rewrite `src/runProxy/waitColorReady.ts`'s `waitColorReady` (keep `adminReadyOnce` and the `sleep` import unchanged):

```ts
export type WaitResult = { ready: true } | { ready: false; reason: 'exited' | 'timeout' };

/**
 * Poll a color's OWN admin /ready until it answers 200 (`{ ready: true }`), the
 * container exits (`reason: 'exited'` — reported fast, no need to wait out the
 * timeout), the signal aborts, or the deadline passes (`reason: 'timeout'`).
 * `isAlive` is injected so this stays unit-testable without docker.
 */
export async function waitColorReady(
  adminPort: number,
  timeoutMs: number,
  signal: AbortSignal,
  isAlive: () => Promise<boolean>,
  sleepMs = 250,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adminReadyOnce(adminPort)) return { ready: true };
    if (signal.aborted) return { ready: false, reason: 'timeout' };
    if (!(await isAlive())) return { ready: false, reason: 'exited' };
    if (Date.now() >= deadline) return { ready: false, reason: 'timeout' };
    await sleep(sleepMs, signal);
  }
}
```

- [ ] **Step 4: Update `runProxyLoop` — dep type, WaitResult handling, distinguishing log**

In `src/runProxy/runProxyLoop.ts`, add the import (top of file):

```ts
import type { WaitResult } from './waitColorReady';
```

Update the `waitColorReady` dep signature (line ~38):

```ts
  /** Poll the color's own admin /ready; ready once it serves, else exited/timeout. */
  waitColorReady: (
    color: Color,
    ports: ColorPorts,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<WaitResult>;
```

Replace the swap-path readiness block (lines ~293-299):

```ts
              const result = await deps.waitColorReady(
                idle,
                idlePorts,
                config.readyTimeoutMs,
                shutdownAbort.signal,
              );
              if (settled) return;
              if (!result.ready) {
                deps.error(
                  result.reason === 'exited'
                    ? `run-proxy: new proxy (${idle}) exited during startup — likely config issue, check the logs`
                    : `run-proxy: new proxy (${idle}) did not become ready — keeping the current proxy`,
                );
                await deps.stopColor(idle).catch(() => {});
              } else {
```

(The `else {` opens the existing flip block — its body and closing brace are unchanged.)

Replace the startup readiness block (lines ~385-390):

```ts
        const result = await deps.waitColorReady('blue', ports, config.readyTimeoutMs, shutdownAbort.signal);
        if (settled) return;
        if (!result.ready) {
          fatal(
            result.reason === 'exited'
              ? 'proxy exited during startup — likely config issue, check the logs'
              : 'proxy did not become ready on startup',
          );
          return;
        }
```

- [ ] **Step 5: Update the command wrapper to inject the liveness check**

In `src/commands/runProxy.ts`, add the import (near line 19):

```ts
import { waitColorReady } from '../runProxy/waitColorReady';
import { isColorRunning } from '../runProxy/isColorRunning';
```

Replace the `waitColorReady` wrapper (lines ~152-153):

```ts
        waitColorReady: (color: Color, ports: ColorPorts, timeoutMs: number, signal: AbortSignal) =>
          waitColorReady(ports.adminPort, timeoutMs, signal, () =>
            isColorRunning(color, paths.proxy),
          ),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/runProxy/waitColorReady.test.ts tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS (all, including the exit-hint tests).

- [ ] **Step 7: Full unit suite, typecheck, lint, commit**

```bash
pnpm test:unit
pnpm typecheck
pnpm lint
git add src/runProxy/waitColorReady.ts src/runProxy/runProxyLoop.ts src/commands/runProxy.ts tests/unit/runProxy/waitColorReady.test.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "feat(run-proxy): fast-fail when a color's container exits during startup"
```

---

### Task 5: Fault injection (`--inject-fault`)

Adds the test-only render-time config mutation and wires it through `run-proxy → buildConfig → writeEnvoyConfig → generateEnvoyConfig`.

**Files:**

- Modify: `src/envoyConfig.ts:3-10,339-365`
- Modify: `src/runProxy/buildConfig.ts`
- Modify: `src/commands/runProxy.ts:22-33,72-77,141-142`
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `type InjectFault = 'crash-config' | 'never-ready'` (exported from `envoyConfig.ts`).
  - `BuildEnvoyConfigOptions.fault?: InjectFault`.
  - `writeEnvoyConfig(allowlist: Allowlist, outputPath: string, overrides: UpstreamOverride[], fault?: InjectFault): void`.

- [ ] **Step 1: Write the failing unit tests**

Add to `tests/unit/envoyConfig.test.ts` (inside `describe('generateEnvoyConfig', ...)`):

```ts
  it('leaves the admin port at 9901 with no fault', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    expect(config.admin.address.socket_address.port_value).toBe(9901);
  });

  it('crash-config sets the admin port out of range (70000)', () => {
    const config = generateEnvoyConfig(allowlist, { fault: 'crash-config' }) as any;
    expect(config.admin.address.socket_address.port_value).toBe(70000);
  });

  it('never-ready moves the admin port off 9901 (to 9902)', () => {
    const config = generateEnvoyConfig(allowlist, { fault: 'never-ready' }) as any;
    expect(config.admin.address.socket_address.port_value).toBe(9902);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts`
Expected: FAIL — `generateEnvoyConfig` ignores `fault`; the crash/never-ready cases still yield `9901`.

- [ ] **Step 3: Add the `InjectFault` type and the render-time mutation**

In `src/envoyConfig.ts`, extend the options interface (lines 3-10):

```ts
export interface UpstreamOverride {
  sniHost: string;
  target: string;
}

/** Test-only config faults, applied as render-time mutations of envoy.yaml. */
export type InjectFault = 'crash-config' | 'never-ready';

export interface BuildEnvoyConfigOptions {
  overrides?: UpstreamOverride[];
  /**
   * Test-only. `crash-config` sets the admin port out of range so Envoy rejects
   * the bootstrap and exits; `never-ready` moves admin off container port 9901
   * so Envoy stays healthy but the admin probe is refused forever.
   */
  fault?: InjectFault;
}
```

Inside `generateEnvoyConfig`, compute the admin port near the top of the function body (after `const overrides = options.overrides ?? [];`, line ~343):

```ts
  const overrides = options.overrides ?? [];
  const adminPortValue =
    options.fault === 'crash-config' ? 70000 : options.fault === 'never-ready' ? 9902 : 9901;
```

Replace the `admin` block in the returned object (lines 363-365):

```ts
    admin: {
      address: { socket_address: { address: '0.0.0.0', port_value: adminPortValue } },
    },
```

- [ ] **Step 4: Thread `fault` through `writeEnvoyConfig`**

Rewrite `src/runProxy/buildConfig.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { generateEnvoyConfig, type UpstreamOverride, type InjectFault } from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist and
 * write it to outputPath. Validation of `allowlist.invalid` is the caller's job.
 * `fault` is a test-only render mutation; when omitted the output is unchanged.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
  fault?: InjectFault,
): void {
  writeFileSync(outputPath, stringify(generateEnvoyConfig(allowlist, { overrides, fault })));
}
```

- [ ] **Step 5: Add the `--inject-fault` CLI option and wire it into `buildConfig`**

In `src/commands/runProxy.ts`, extend the import (line 14) and `RunProxyOptions` (lines 22-33):

```ts
import type { UpstreamOverride, InjectFault } from '../envoyConfig';
```

```ts
interface RunProxyOptions {
  credentials: string;
  secret?: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  forwardPorts?: string;
  upstreamOverride: UpstreamOverride[];
  injectFault?: InjectFault;
}
```

Add the option after the `--upstream-override` option (after line 77):

```ts
    .option(
      '--inject-fault <crash-config|never-ready>',
      'render a deliberately broken envoy.yaml to exercise proxy robustness (test use only)',
    )
```

Update the `buildConfig` dep (line ~141-142):

```ts
        buildConfig: (allowlist) =>
          writeEnvoyConfig(allowlist, paths.envoyConfig, options.upstreamOverride, options.injectFault),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts tests/unit/runProxy/buildConfig.test.ts`
Expected: PASS (the existing `buildConfig` test still passes — the new 4th arg is optional).

- [ ] **Step 7: Full unit suite, typecheck, lint, commit**

```bash
pnpm test:unit
pnpm typecheck
pnpm lint
git add src/envoyConfig.ts src/runProxy/buildConfig.ts src/commands/runProxy.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(run-proxy): add --inject-fault render-time config faults (test only)"
```

---

### Task 6: E2E robustness tests

Two docker-backed tests proving the headline behaviors end-to-end. They spawn their own `run-proxy` processes (the fault-injected proxies fight over the same `configamatron-envoy-*` containers as any other proxy, so they must run in isolation — integration files already run serially).

**Files:**

- Create: `tests/integration/runProxyRobustness.test.ts`

**Interfaces:**

- Consumes: the built CLI (`dist/cli.js`), `killProcessTree`, `isColorRunning` (Task 2), `rmEnvRoot`.
- Produces: no code; verifies behavior.

- [ ] **Step 1: Write the e2e test file**

Create `tests/integration/runProxyRobustness.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { isColorRunning } from '../../src/runProxy/isColorRunning';
import { rmEnvRoot } from '../rmEnvRoot';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

// Distinct from runProxy.test.ts's ports to avoid any lingering-socket overlap.
const HTTPS_PORT = 18545;
const HTTP_PORT = 18182;
const envoyEnv = {
  ENVOY_HTTPS_PORT: String(HTTPS_PORT),
  ENVOY_HTTP_PORT: String(HTTP_PORT),
};

let tempDir: string;
let credentialsPath: string;
let proxyProc: ResultPromise | null = null;
let lines: string[] = [];

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

function spawnProxy(fault: 'crash-config' | 'never-ready'): ResultPromise {
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
      '--inject-fault',
      fault,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => lines.push(line));
  }
  return proc;
}

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (lines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for run-proxy output containing '${needle}'\n` +
          `--- output ---\n${lines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-robust-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-robust');

  await rmEnvRoot(envRoot);
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });
}, 120000);

afterEach(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
    try {
      await proxyProc;
    } catch {
      // ignore kill/non-zero
    }
  }
  proxyProc = null;
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('run-proxy robustness', () => {
  it('fast-fails with a config-issue hint when the color exits during startup', async () => {
    proxyProc = spawnProxy('crash-config');
    await waitForLine('exited during startup', 30000); // a regression would wait ~60s
    const result = await proxyProc;
    proxyProc = null; // already exited; skip afterEach kill
    expect(result.exitCode).not.toBe(0);
  }, 60000);

  it('responds to SIGINT promptly while parked waiting for a never-ready color', async () => {
    proxyProc = spawnProxy('never-ready');
    // Once the container is running, run-proxy is parked in the startup waitColorReady.
    await waitFor(() => isColorRunning('blue', proxyDir), 60000);

    const t0 = Date.now();
    await killProcessTree(proxyProc.pid!, 'SIGINT');
    await proxyProc; // reject:false -> resolves on exit
    proxyProc = null;
    expect(Date.now() - t0).toBeLessThan(10000); // a regression would hang ~60s
  }, 120000);
});
```

- [ ] **Step 2: Build the CLI (the e2e execs `dist/cli.js`)**

Run: `pnpm build`
Expected: `dist/cli.js` is produced with all Task 1–5 changes.

- [ ] **Step 3: Run the e2e tests**

Run: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/runProxyRobustness.test.ts`
Expected: PASS (2 tests). The crash-config test surfaces `exited during startup` within a few seconds; the never-ready test exits within seconds of SIGINT.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/runProxyRobustness.test.ts
git commit -m "test(run-proxy): e2e crash-config fast-fail and never-ready shutdown abort"
```

- [ ] **Step 5: Full pipeline**

Run: `pnpm test`
Expected: format, lint, typecheck, unit, build, e2e, and integration all pass.

---

## Notes for the implementer

- **`AbortController`/`AbortSignal` are Node globals** (Node ≥18) — do not import them, do not add a dependency.
- **Container name vs. service name:** `docker inspect` needs `configamatron-envoy-<color>` (the `container_name`), while `docker compose <cmd> envoy_<color>` uses the service name. Don't mix them.
- **Byte-for-byte guarantee:** the no-fault admin port must remain `9901`; the existing `envoyConfig.test.ts` "exposes an admin endpoint" test (asserts `9901`) is your regression guard — keep it green.
- **Drain-on-abort must not force-close.** The gateway test asserts `sock.destroyed === false` after an aborted drain; teardown is `gateway.close()`'s job.
- **Fake-timer tests** (`runProxyLoop.test.ts`) rely on `flush()` to drain microtasks; the abort path is synchronous (`addEventListener('abort', …)` fires inside `abort()`), so no timer advance is needed for the shutdown-abort test.

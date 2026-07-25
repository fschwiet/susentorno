# Handoff: extend the run-proxy guard to every suite that touches the Envoy stack

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Blocked on:** nothing. Test configuration and one moved helper; no guest, no host
services.

## What this is

`checkNoRunningProxy()` fails fast when a live `run-proxy` is holding the Envoy
containers. It is wired into **`pnpm test:vm` only**. But the integration suite
tears the same stack down, and `pnpm test` runs it with no guard at all.

The diagnosis is already written in the codebase. `tests/vm/wsl.ts:108-113`:

> `run-proxy` and this suite both manage the same docker-compose Envoy stack, and
> startProxyStack REPLACES any running proxy container. With run-proxy live the two
> clobber each other — the suite's Envoy is torn down underneath it, the
> Envoy-reachability guard in vm.test.ts then reports '000' and blames Docker WSL
> integration, and **run-proxy is left serving :80/:443 with no backend (so the
> real VM silently loses egress too).**

That last clause is precisely what happened on 2026-07-25 — via `pnpm test`, which
that guard never sees.

## The incident, as evidence

During the Ubuntu checkpoint session, with `run-proxy` serving a live guest:

| Time | Event |
|---|---|
| ~00:07 | guest healthy — `verify-config.sh` **18 passed, 0 failed** |
| 00:10 | `pnpm test` run (twice) — all suites green |
| ~00:2x | guest broken — **14 passed, 4 failed**, every `Live egress` check `code=000` |
| after | `docker ps -a` **completely empty** |

DNS, routing, CA trust and the placeholder credential all still passed — only
egress died, exactly the signature of `run-proxy` serving `:80`/`:443` with no
backend behind it.

Mechanism: `tests/integration/runProxy.test.ts:130` runs `docker compose down`.
The suite cleans up after itself correctly; it just has no idea another owner is
using the stack.

**Cost when it bites:** the failure is silent and delayed. The test run passes,
`run-proxy` keeps running and logs nothing wrong, and the damage only surfaces the
next time something in the guest makes a request. It is very easy to mistake for a
guest-side or proxy-config problem — which is the same misattribution the `wsl.ts`
comment warns about for the VM suite.

## Current state

`tests/vm/globalSetup.ts` calls the guard first, deliberately:

```ts
// First: instant, needs nothing installed, and it is the most common
// self-inflicted failure — a live run-proxy fighting this suite for the Envoy
// containers. Everything below is slower and some of it is destructive.
await checkNoRunningProxy();
```

Wired only through `vitest.vm.config.ts` (`globalSetup: ['tests/vm/globalSetup.ts']`).
**`vitest.config.ts`, `vitest.integration.config.ts` and `vitest.e2e.config.ts`
have no `globalSetup` at all.**

## Suggested fix

**1. Move the helper out of the VM harness.** `checkNoRunningProxy` is already
labelled "(host-side, not WSL)" and `loopbackPortAccepts` is plain `node:net` — no
`wsl.exe`, nothing platform-specific. But it lives in `tests/vm/wsl.ts`, whose
module scope is WSL-oriented, and non-VM suites should not import from
`tests/vm/`. Move it to a shared test module and re-export or import it from
`tests/vm/wsl.ts`.

**2. Add a `globalSetup` to `vitest.integration.config.ts`** that calls it. This is
the suite that actually runs `docker compose down`.

**3. Decide about e2e and unit.** `tests/e2e/updateShares.test.ts` matched a grep
for docker/compose/envoy but was not investigated — check whether it manages the
stack before deciding. The unit suite does not touch Docker and should stay
guard-free so it remains fast and dependency-free.

**4. Keep the existing error message.** It already tells the reader exactly what to
do, including the part people forget:

> Stop run-proxy and re-run; start it again afterwards to restore the VM's proxy.

## Worth considering, not required

**The detection is a heuristic.** It infers `run-proxy` from *both* `127.0.0.1:80`
and `:443` accepting connections. That is cheap and portable, and it also catches an
orphaned stack from a previous run, which is arguably a feature. But it cannot name
what it found, and it would fire on any unrelated local service holding both ports.

Detecting the `run-proxy` process directly (a `node.exe` whose command line
contains `run-proxy` — see `templates/proxy/host-allow-vm-inbound.ps1`'s
`Resolve-RunProxyNode` for a working example of that lookup) would let the message
name the PID. Best as an *addition* to the port check rather than a replacement:
the port check catches the orphaned-container case that a process check would miss.

**Consider making it non-fatal in CI.** If CI never has a `run-proxy`, the guard
costs two connection attempts and nothing else — no reason to special-case it. Left
here only so the next person does not wonder whether it was considered.

## What this does NOT cover

Nothing prevents the reverse order — starting `run-proxy` while a suite is
mid-flight. The guard is a precondition check at suite startup, not a lock. A real
mutex over the stack would be the complete fix and is almost certainly not worth
it; `usage-hyper-v.md` and `technical-notes.md:53` already tell operators to stop
`run-proxy` first, and this change is about making the failure loud rather than
making it impossible.

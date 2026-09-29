# Test tiers

susentorno's automated tests are divided into five tiers: `unit`, `cli`, `host-network`, `proxy-stack`, and `guest`. Each tier is named for the **highest observable interface it crosses**—its test surface—not for its size or importance. This makes both test placement and runtime prerequisites predictable.

The tier names use the project's domain vocabulary (see [CONTEXT.md](CONTEXT.md)). In particular, `guest` names the domain actor whose behavior is observed, not the virtualization mechanism used by the harness.

| Tier | Package command | Directory | Vitest config | Observable surface |
| --- | --- | --- | --- | --- |
| `unit` | `pnpm test:unit` | `tests/unit/` | `vitest.config.ts` | In-process behavior through a module interface or an intentional internal seam |
| `cli` | `pnpm test:cli` | `tests/cli/` | `vitest.cli.config.ts` | The packaged CLI (`dist/cli.js`) and the filesystem artifacts it generates |
| `host-network` | `pnpm test:host-network` | `tests/host-network/` | `vitest.host-network.config.ts` | Real Hyper-V switch/firewall state created and torn down through the host-network orchestration |
| `proxy-stack` | `pnpm test:proxy-stack` | `tests/proxy-stack/` | `vitest.proxy-stack.config.ts` | The live proxy stack (Docker plus local upstream adapters), without entering a guest |
| `guest` | `pnpm test:guest` | `tests/guest/` | `vitest.guest.config.ts` | Behavior observed through a disposable guest |

## What each tier exercises

- **`unit`** tests call an in-process module interface or intentional internal seam. Using an in-memory or stub adapter does not change the tier because the observation is still made through the module. Unit tests require no external services.

- **`cli`** tests invoke the built, user-facing `susentorno` command and assert on its behavior or generated artifacts. Several in-process modules may participate, but the observable interface is the packaged command.

- **`host-network`** tests invoke the host-network orchestration against real Hyper-V and real Windows Firewall state — not mocked — always scoped to the `test` isolation name so they never touch a developer's real `susentorno-internal` switch. The packaged CLI's parsing, registration, and output remain covered by the CLI tier/manual verification. This is a deliberate, narrow exception to the "avoid creating new tiers" guidance below and to [ADR-0010](docs/adr/0010-vm-tests-via-qemu-in-wsl2.md)'s "Hyper-V is not the test runtime" stance — see [ADR-0023](docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md) for why this specific surface is safe to test for real where guest-boot behavior isn't.

- **`proxy-stack`** tests bring up the real proxy stack, including Envoy in Docker, networking, and local mock upstreams. They observe stack behavior without booting a guest.

- **`guest`** tests make their observations from inside a disposable guest. They generally cross the CLI and proxy stack too, but the guest is the highest exercised surface. The harness boots real Hyper-V VMs from differencing disks off a golden image it builds itself, on a real Internal switch served by the real `run-hosting` (see [ADR-0025](docs/adr/0025-guest-layer-tested-against-real-hyperv.md)); the only substitution left is a stub `gh`. On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/guest/<timestamp>/<role>/`.

  The Windows role, `windowsE2e`, runs the packaged `setup-guest-windows` against a disposable Windows 11 guest on the Default Switch, twice. Run 1 deliberately fails at the last post-isolation step (a customized `99-fail.ps1`) and checks the real residual-state footer; run 2 removes that step and must exit `0`. The role then makes its assertions from inside the isolated guest and scans both runs' logs and every artifact for the two passwords. The one substitution is a `gh.cmd` shim (exit `0` for any arguments) at the front of the guest's machine PATH, which shadows the real GitHub.cli that step 01 still installs; Git and everything else arrive from the shipped steps. The golden Windows image carries only a WinGet-ready App Installer. The role takes roughly 25-30 minutes once the image exists (the beforeAll budget is 2 hours), because run 1 installs the whole toolchain and run 2 replays every step, and it writes `reboot-evidence.txt` and both run logs beside the diagnostics.

## Placing a new test

Place a test in the tier for the highest stable interface through which its behavior is observed:

- Direct module call or intentional internal seam → `unit`
- Packaged CLI invocation → `cli`
- Live proxy stack without entering a guest → `proxy-stack`
- Behavior driven or observed inside a disposable guest → `guest`

Composition depth, number of modules involved, line count, and runtime do not determine the tier. Prefer assertions at the highest stable interface that directly exposes the behavior, and do not reach through that interface to inspect private state.

Within a tier, add the test to the file whose existing interface or capability it extends. Create a new file only for a distinct capability. A focused internal seam belongs in `unit` when its contract is independently useful and stable, such as a protocol codec, deterministic state machine, parser, formatter, or adapter with meaningful failure behavior.

Avoid creating new tiers. If a test seems not to fit, first restate the behavior in terms of the highest surface that observes it.

## Prerequisites per tier

Install the project's Node dependencies before running any tier.

| Tier | Additional prerequisites |
| --- | --- |
| `unit` | None. |
| `cli` | A production build (`pnpm build`). The default pipeline builds before this tier. `jq` on PATH is optional: tests that need it self-skip when it is unavailable, and the preflight reports its entry as skipped. |
| `host-network` | A Windows host with Hyper-V available (the `vmms` service running), and an elevated (Administrator) PowerShell/terminal. No Docker/WSL2 required. |
| `proxy-stack` | A Windows host, a production build (`pnpm build`), Docker running, and Docker Compose available (`docker compose version` succeeds). Windows Firewall must not block this `node.exe`. Stop any live `susentorno run-hosting` process first. No guest or real credential is required. |
| `guest` | A Windows host with Hyper-V available (the `vmms` service running), an elevated (Administrator) PowerShell/terminal, Docker running, Docker Compose available, a running `ssh-agent`, and `SUSENTORNO_WINDOWS_ISO` (required) pointing at an **x64, `en-us`** Windows 11 Enterprise evaluation ISO. That path should be local, not a mapped drive or network share: Hyper-V attaches the ISO directly to the build VM, and mapped drive letters are invisible to it. Stop any live `susentorno run-hosting` process first — this tier binds the real `:80`/`:443` and manages the same Envoy containers. The first run builds a golden Ubuntu image (~20–30 minutes) and a golden Windows image (60–120 minutes; changing the Windows provisioning script, as the `winget-ready` stage did, invalidates the stamp and forces one rebuild); later runs reuse them from `.image-cache/`, which grows by roughly 50–60 GB. Every run hashes the full ISO. |

Guest images are cached in `.image-cache/`. Ubuntu images refresh automatically, but a stale Windows image requires an explicit `SUSENTORNO_WINDOWS_IMAGE_REBUILD=1` rebuild.

A missing live-tier prerequisite is an environmental failure, not a product failure. Each live tier fails fast on its own prerequisites; run `pnpm preflight` to report every tier's missing prerequisites together.

## The preflight suite

The preflight is a **preflight suite, not a tier**. It exercises no product surface; it checks whether this host can run each tier. `pnpm preflight` runs every tier's prerequisites in a few seconds and reports one test per prerequisite, grouped by tier. Unlike a tier, it does not stop at the first failure, so one run lists everything to fix. A tier with no prerequisites appears as an empty, skipped group.

Each tier's prerequisites are an ordered list of `{ name, check }` entries (see `tests/prerequisites.ts`), exported from that tier's `prerequisites.ts`, such as `tests/proxy-stack/prerequisites.ts`. `check` is an async function that resolves when the prerequisite is met and throws an error whose message names the fix when it is not. An optional prerequisite, such as `cli`'s `jq`, resolves with `skipPrerequisite(reason)` when absent; the preflight shows it as a skipped test with that reason, and a tier's `globalSetup` does not treat it as a failure. Windows-only checks (elevation, Hyper-V, Windows Firewall, the Windows ISO) fail on any other platform, such as inside a susentorno Linux guest, with a message that the tier needs a Windows Hyper-V host. The tier's `globalSetup` runs the same list in order and stops at the first failure, so the preflight passing means the tier will get past its own checks.

To add a prerequisite, add an entry to the tier's list. Both the tier's `globalSetup` and the preflight pick it up with no other edit, and removing an entry removes its preflight test. A prerequisite shared by several tiers is listed in each tier that needs it. The tier → list map in `tests/preflight/preflight.test.ts` changes only when a tier is added. The suite's config is `vitest.preflight.config.ts`, and its tests run serially because several checks touch shared host state.

## Running individual tests

Pass a file to its tier command:

```powershell
pnpm test:unit -- .\tests\unit\collisions.test.ts
```

Or select tests by name:

```powershell
pnpm test:unit -- -t "VM share collision detection"
```

Substitute the appropriate tier command when running tests outside `unit`.

## Test support and residue

Support code used by more than one tier lives at the root of `tests/`, including `proxyStack.ts`, `testEnvRoot.ts`, `rmEnvRoot.ts`, `checkDockerRunning.ts`, `checkNoRunningProxy.ts`, `checkElevated.ts`, `checkHypervAvailable.ts`, `checkDockerComposeAvailable.ts`, `requireWindowsHost.ts`, `checkGatewayPortsFree.ts`, `sshAgentIdentity.ts`, `prerequisites.ts`, and `tests/fixtures/`. Tier-specific setup and harness code stays in its tier directory, such as `tests/proxy-stack/globalSetup.ts`, `tests/guest/checkWindowsIso.ts`, and `tests/guest/hyperv/`.

The proxy-stack and guest suites create their throwaway environment under `test-results/.susentorno`. They do not use a repository-root `.susentorno`. A root `.susentorno` may be a manually created, long-running environment and must not be treated as disposable test residue.

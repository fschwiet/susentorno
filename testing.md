# Test tiers

susentorno's automated tests are divided into four tiers: `unit`, `cli`, `proxy-stack`, and `guest`. Each tier is named for the **highest observable interface it crosses**—its test surface—not for its size or importance. This makes both test placement and runtime prerequisites predictable.

The tier names use the project's domain vocabulary (see [CONTEXT.md](CONTEXT.md)). In particular, `guest` names the domain actor whose behavior is observed, not the virtualization mechanism used by the harness.

| Tier | Package command | Directory | Vitest config | Observable surface |
| --- | --- | --- | --- | --- |
| `unit` | `pnpm test:unit` | `tests/unit/` | `vitest.config.ts` | In-process behavior through a module interface or an intentional internal seam |
| `cli` | `pnpm test:cli` | `tests/cli/` | `vitest.cli.config.ts` | The packaged CLI (`dist/cli.js`) and the filesystem artifacts it generates |
| `proxy-stack` | `pnpm test:proxy-stack` | `tests/proxy-stack/` | `vitest.proxy-stack.config.ts` | The live proxy stack (Docker plus local upstream adapters), without entering a guest |
| `guest` | `pnpm test:guest` | `tests/guest/` | `vitest.guest.config.ts` | Behavior observed through a disposable guest |

## What each tier exercises

- **`unit`** tests call an in-process module interface or intentional internal seam. Using an in-memory or stub adapter does not change the tier because the observation is still made through the module. Unit tests require no external services.

- **`cli`** tests invoke the built, user-facing `susentorno` command and assert on its behavior or generated artifacts. Several in-process modules may participate, but the observable interface is the packaged command.

- **`proxy-stack`** tests bring up the real proxy stack, including Envoy in Docker, networking, and local mock upstreams. They observe stack behavior without booting a guest.

- **`guest`** tests make their observations from inside a disposable guest. They generally cross the CLI and proxy stack too, but the guest is the highest exercised surface. The test harness boots QEMU under WSL2; Hyper-V remains the production guest platform and is not the test runtime (see [ADR-0010](docs/adr/0010-vm-tests-via-qemu-in-wsl2.md)). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/guest/<timestamp>/`.

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
| `cli` | A production build (`pnpm build`). The default pipeline builds before this tier. Tests that need the external `jq` command self-skip when it is unavailable. |
| `proxy-stack` | A production build (`pnpm build`), plus Docker and Docker Compose running. Stop any live `susentorno run-proxy` process first. No guest or real credential is required. |
| `guest` | WSL2/Docker/KVM set up per [development.md](development.md). Stop any live `susentorno run-proxy` process first — it manages the same docker-compose Envoy stack, so leaving it running gets its Envoy torn down mid-suite (the reachability guard then reports `000`, which looks like a Docker/WSL problem) while `run-proxy` itself is left serving with no backend. |

See [development.md](development.md) for how to install and configure the guest harness's WSL prerequisites. The harness creates or refreshes its cached golden image automatically at `/root/.cache/susentorno-vmtest`; the first run takes longer.

A missing live-tier prerequisite is an environmental failure, not a product failure. Both live tiers fail fast when Docker is unavailable or `run-proxy` would conflict with their shared proxy stack. The guest tier also checks its WSL configuration and harness dependencies before booting a guest.

## Default verification pipeline

`pnpm test` runs formatting, linting, type checking, the `unit` tier, a production build, the `cli` tier, and the `proxy-stack` tier in fail-fast order. The Verification Pipeline section of [development.md](development.md) is the source of truth for the exact step order.

The `guest` tier is not part of `pnpm test`. Run it separately with `pnpm test:guest` when changing `templates/vm-shared/` or proxy configuration. Guest boots and reboots take minutes.

## Test support and residue

Support code used by more than one tier lives at the root of `tests/`, including `proxyStack.ts`, `testEnvRoot.ts`, `rmEnvRoot.ts`, `checkDockerRunning.ts`, `checkNoRunningProxy.ts`, and `tests/fixtures/`. Tier-specific setup and harness code stays in its tier directory, such as `tests/proxy-stack/globalSetup.ts` and `tests/guest/harness/`.

The proxy-stack and guest suites create their throwaway environment under `test-results/.susentorno`. They do not use a repository-root `.susentorno`. A root `.susentorno` may be a manually created, long-running environment and must not be treated as disposable test residue.

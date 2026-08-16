# Development

Requirements and setup for running susentorno's own test suite. See [testing.md](testing.md) for how the tests are organized and how to place a new one.

## Prerequisites

- All [host prerequisites](README.md#host-prerequisites).
- An **elevated (Administrator)** terminal. The `host-network` and `guest` tiers create and delete real Hyper-V switches, firewall rules, VMs, VHDs, SMB shares, and a Windows local account.
- **Hyper-V** enabled, with a working **Default Switch** (the guest tier's golden-image build needs ICS internet through it).
- **Docker Desktop** running, for the `proxy-stack` and `guest` tiers.
- A running **`ssh-agent`**. The guest tier's end-to-end test runs the real `setup-guest-unix`, whose bare `ssh` finds the harness key through the agent.
  ```powershell
  Set-Service ssh-agent -StartupType Automatic
  Start-Service ssh-agent
  ```
- **~10 GB free disk**. The guest tier caches an Ubuntu ISO and a golden VM image in `.image-cache/`, and builds it on the first run (~20–30 minutes). Both are gitignored; delete the directory to force a rebuild.
- No WSL2, KVM, or nested virtualization is required. Test startup gates verify each prerequisite and name the fix for whatever is missing.

## Verification pipeline

Run these commands in order to verify a change is correct (fail-fast order):

| Step | Command | What it checks |
| --- | --- | --- |
| 1 | `pnpm format:check` | Prettier formatting |
| 2 | `pnpm lint` | ESLint rules |
| 3 | `pnpm typecheck` | TypeScript types (no emit) |
| 4 | `pnpm test:unit` | Unit tests (Vitest) |
| 5 | `pnpm build` | Production build (tsup → `dist/cli.js`) |
| 6 | `pnpm test:cli` | Packaged CLI behavior and the artifacts it generates (against `dist/cli.js`) |
| 7 | `pnpm test:host-network` | Real Hyper-V/firewall state created and torn down by `create-host-network`/`delete-host-network` (requires an elevated terminal) |
| 8 | `pnpm test:proxy-stack` | Proxy stack tests against a live Envoy stack |
| 9 | `pnpm test:guest` | Guest tests (real Hyper-V VMs on a real Internal switch, served by the real `run-hosting`) |

See [testing.md](testing.md) for what each tier's test surface is, how to choose the tier for a new test, and each tier's prerequisites.

Run the full pipeline (steps 1–9) in one command:

```
pnpm test
```

> The cli suite shells out to `jq`; install it on the dev host (and CI) or the jq-dependent tests self-skip.

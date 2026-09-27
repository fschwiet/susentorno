# Development

Requirements and setup for running susentorno's own test suite. See [testing.md](testing.md) for how the tests are organized and how to place a new one.

## Prerequisites

- All [host prerequisites](README.md#host-prerequisites).
- An **elevated (Administrator)** terminal. The `host-network` and `guest` tiers create and delete real Hyper-V switches, firewall rules, VMs, VHDs, SMB shares, and a Windows local account.
- **Hyper-V** enabled, with a working **Default Switch** (the guest tier's golden-image build needs ICS internet through it).
- **Docker Desktop** running, for the `proxy-stack` and `guest` tiers.
- A running **`ssh-agent`**. Windows ships the service **Disabled**, so a fresh machine needs:
  ```powershell
  Set-Service ssh-agent -StartupType Automatic
  Start-Service ssh-agent
  ```
  Run `pnpm check` from **PowerShell**, not Git Bash, whose OpenSSH cannot see this agent. Windows guest templates do not enable the service; configure it yourself.
- **`SUSENTORNO_WINDOWS_ISO`** set to a local path (not a mapped drive or network share) of an x64 `en-us` Windows 11 Enterprise evaluation ISO. See [testing.md](testing.md).
- **~60–70 GB free disk** for the cached Ubuntu ISO and golden Ubuntu and Windows VM images in `.image-cache/`. First builds take ~20–30 minutes for Ubuntu and 60–120 minutes for Windows.
- **Memory:** `pnpm check` has succeeded in a 16 GB VM; this is an observation, not a guaranteed minimum. When running it through Claude Code with 16 GB or less, set `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` before starting Claude Code.
- No WSL2, KVM, or nested virtualization is required. Startup gates report missing prerequisites.

## Verification pipeline

Run these commands in order to verify a change is correct (fail-fast order):

| Step | Command | What it checks |
| --- | --- | --- |
| 1 | `pnpm preflight` | Every tier's host prerequisites, all reported in one run (a preflight suite, not a tier) |
| 2 | `pnpm format:check` | Prettier formatting |
| 3 | `pnpm lint` | ESLint rules |
| 4 | `pnpm typecheck` | TypeScript types (no emit) |
| 5 | `pnpm test:unit` | Unit tests (Vitest) |
| 6 | `pnpm build` | Production build (tsup → `dist/cli.js`) |
| 7 | `pnpm test:cli` | Packaged CLI behavior and the artifacts it generates (against `dist/cli.js`) |
| 8 | `pnpm test:host-network` | Real Hyper-V/firewall state created and torn down by `create-host-network`/`delete-host-network` (requires an elevated terminal) |
| 9 | `pnpm test:proxy-stack` | Proxy stack tests against a live Envoy stack |
| 10 | `pnpm test:guest` | Guest tests (real Hyper-V VMs on a real Internal switch, served by the real `run-hosting`) |

See [testing.md](testing.md) for what each tier's test surface is, how to choose the tier for a new test, and each tier's prerequisites.

Run the full pipeline (steps 1–10) in one command:

```
pnpm check
```

> The cli suite shells out to `jq`; install it on the dev host (and CI) or the jq-dependent tests self-skip.

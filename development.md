# Development

Requirements and setup for running susentorno's own test suite. See [testing.md](testing.md) for how the tests are organized and how to place a new one.

## Prerequisites

- All [host prerequisites](README.md#host-prerequisites) except a VM guest (the dev test suite uses WSL2/QEMU, not a Hyper-V guest).
- WSL installed and configured appropriately.
  - Test startup gates will verify the WSL configuration and give guidance about what is missing.
  - Ubuntu needs to be installed and set as default:
    ```powershell
    wsl --install -d Ubuntu # will prompt about creating a user/password
    wsl --set-default Ubuntu
    ```
  - `wsl.exe` is invoked without `-d` throughout the harness, so it runs whatever distro is default.
  - `~/.wslconfig` must contain:
    ```ini
    [wsl2]
    networkingMode=mirrored

    [experimental]
    ignoredPorts=67
    ```
  - Run `wsl --shutdown` after to apply the default distro and `.wslconfig` changes.
  - Run `wsl.exe -u root bash <repo>/tests/guest/harness/setup-wsl.sh` to install test dependencies within WSL.

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
| 7 | `pnpm test:proxy-stack` | Proxy stack tests against a live Envoy stack |
| 8 | `pnpm test:guest` | Guest tests (QEMU in WSL2) — run when touching `templates/vm-shared/` or proxy config; **not** part of `pnpm test` |

See [testing.md](testing.md) for what each tier's test surface is, how to choose the tier for a new test, and each tier's prerequisites.

Run the full pipeline (steps 1–7) in one command:

```
pnpm test
```

> The cli suite shells out to `jq`; install it on the dev host (and CI) or the jq-dependent tests self-skip.

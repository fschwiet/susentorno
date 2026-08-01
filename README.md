# configamatron

configamatron sets up isolated environments for coding agents. A Windows and/or Linux VM is isolated behind an Envoy proxy running in Docker on the host; the proxy restricts network access to an allow list and injects credentials so the VM never holds them. Each environment lives in a `.configamatron` folder inside whatever working directory you find appropriate.

Only one proxy container can run on the host at a time (it binds ports 80/443). Starting any environment's proxy — or running this repo's test suite — replaces whichever proxy container was running. Run one environment at a time; running `configamatron run-proxy` in an environment's directory restores its proxy.

## Host prerequisites

- Windows host
- **Hyper-V** for the isolated VM (see [setup-machine.md](setup-machine.md) and [setup-guest.md](setup-guest.md)).
- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- The `codex` CLI installed and logged in (so `~/.codex/auth.json` exists).
- The host firewall's ports 80 and 443 for the VM's Internal-switch adapter, opened via [setup-machine.md](setup-machine.md). Running on other platforms may work but is untested; you would need those same ports reachable from the host to the VM.

## Installation

```
pnpm install
pnpm build
pnpm install -g .
```

## Setup

Setup is split across three docs, done in order:

1. [setup-machine.md](setup-machine.md) — one-time per Windows host: the Internal virtual switch and host IP, and the host firewall.
2. [setup-environment.md](setup-environment.md) — one-time per environment: `configamatron init` and the rest of the proxy setup, plus the environment's share account and SMB shares.
3. [setup-guest.md](setup-guest.md) — one-time per guest VM: creating the VM under Hyper-V and running its numbered setup scripts, for either an Ubuntu or a Windows guest.

Once set up, see [diagnostics.md](diagnostics.md) to verify the environment and guest, and to interpret the proxy's live traffic log.

## Customizing settings transforms

`.configamatron/home-jq-transforms/` holds a `manifest.yaml` plus `.jq` files that edit settings files in the guest's home directory. The post-script applier seeds an empty `{}` when a target is missing. Add or edit transforms, then run `configamatron update-shares` (`--dry-run` previews only).

## Customizing setup scripts

Put `NN-name.sh` and/or `NN-name.ps1` steps in `.configamatron/pre-scripts/` or `.configamatron/post-scripts/`. Pre-scripts run with full network access before isolation; post-scripts run after the reboot. Run `configamatron update-shares` after editing. Each folder's `README.md` documents naming and sibling-resource rules.

When upgrading an older environment, remember that `.gitignore` does not untrack indexed files. Either delete and re-run `init`, or run `git rm -r --cached .configamatron && git add .configamatron`, then commit, to re-apply the allowlist while keeping files on disk.

## Development

See [development.md](development.md) for the requirements and setup to run configamatron's own test suite, and [testing.md](testing.md) for how the tests are organized.

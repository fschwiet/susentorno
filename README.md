# configamatron

configamatron sets up isolated environments for coding agents. A Windows and/or Linux VM is isolated behind an Envoy proxy running in Docker on the host; the proxy restricts network access to an allow list and injects credentials so the VM never holds them. Each environment lives in a `.configamatron` folder inside whatever working directory you find appropriate.

Only one proxy container can run on the host at a time (it binds ports 80/443). Starting any environment's proxy — or running this repo's test suite — replaces whichever proxy container was running. Run one environment at a time; running `configamatron run-proxy` in an environment's directory restores its proxy.

## Host prerequisites

- Windows host
- **Hyper-V** for the isolated VM (see `usage-hyper-v.md`).
- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- The `codex` CLI installed and logged in (so `~/.codex/auth.json` exists).
- The host firewall's ports 80 and 443 for the VM's Internal-switch adapter are opened by a supplied script. Running on other platforms may work but is untested; you would need those same ports reachable from the host to the VM.

## Installation

```
pnpm install
pnpm build
pnpm install -g .
```

## Proxy setup

Usually done once per environment. Run every command from the environment directory (the folder that owns the environment, e.g. `e:\repo`):

1. `configamatron init` — creates `.configamatron/` scaffolding. Its `.gitignore` is an allowlist: commit only `.gitignore`, `pre-scripts/`, `post-scripts/`, `home-jq-transforms/`, and `proxy/allowlist.txt`; generated files and secrets remain ignored. Run `configamatron update-shares` after changing authored inputs.
2. `configamatron generate-ca` — writes the root certificate authority the proxy's https certificates chain to. Run once per environment; `run-proxy` reissues the per-host leaf certificate automatically as the allow list changes.
3. `configamatron write-github-config` — prompts for a GitHub fine-grained personal access token and writes `vm-shared/github-config.txt` (username/email come from your global git config). Create the token at https://github.com/settings/personal-access-tokens/new, scoped to the repositories the agent should use, with read/write permission to 'Contents'.
4. `configamatron run-proxy` — builds `proxy/envoy.yaml` from `proxy/allowlist.txt` and launches the proxy in a docker container with the latest Claude credentials. While it runs it watches both files: editing the allow list takes effect live (config rebuilt, leaf certificate reissued if the TLS-terminated hosts changed, proxy restarted), and credential rotations propagate automatically. It also streams the proxy's access log inline (see "Watching proxy traffic" below) and forwards the Hyper-V Internal-switch interface's `:80`/`:443` to Envoy on loopback, so it must stay running for the VM to reach the proxy (Envoy is published on `127.0.0.1` only). Pass `--no-forward` to disable forwarding, or `--forward-listen <ip>` to override the bind address.
5. **Windows hosts only:** in an **Administrator** PowerShell, run `powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1`. This opens inbound TCP 80/443 (Envoy) from the VM's Internal-switch adapter, and _prints the host IP you need to use in VM-side setup_.

- It defaults to the `vEthernet (configamatron-internal)` adapter; pass `-AdapterAlias` if your Internal switch uses a different name (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.

## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

VM creation, the Internal virtual switch, the host IP, and the SMB share are covered in **`usage-hyper-v.md`** — for both guests (which stay on DHCP):

- **Ubuntu guest:** follow `usage-hyper-v.md` to create the VM and mount the share at `/mnt/vm-shared`, then run the numbered scripts below.
- **Windows guest:** follow `usage-hyper-v.md` for the VM and share, then `usage-windows-vm.md` for the guest-side scripts.

### Run the numbered scripts from the VM

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

Run without `sudo`; each script elevates internally where needed. The exact count may vary when custom steps are present.

1. `cd` into `vm-shared/pre-scripts/` and run every script in number order. The last step is `05-configure-network.sh <host-ip>` when there are no custom scripts.
2. Isolate the VM's network — remove the temporary Default Switch adapter (see `usage-hyper-v.md`), then reboot.
3. `cd` into `vm-shared/post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.

## Customizing settings transforms

`.configamatron/home-jq-transforms/` holds a `manifest.yaml` plus `.jq` files that edit settings files in the guest's home directory. The post-script applier seeds an empty `{}` when a target is missing. Add or edit transforms, then run `configamatron update-shares` (`--dry-run` previews only).

## Customizing setup scripts

Put `NN-name.sh` and/or `NN-name.ps1` steps in `.configamatron/pre-scripts/` or `.configamatron/post-scripts/`. Pre-scripts run with full network access before isolation; post-scripts run after the reboot. Run `configamatron update-shares` after editing. Each folder's `README.md` documents naming and sibling-resource rules.

When upgrading an older environment, remember that `.gitignore` does not untrack indexed files. Either delete and re-run `init`, or run `git rm -r --cached .configamatron && git add .configamatron`, then commit, to re-apply the allowlist while keeping files on disk.

## Verifying an environment

Two read-only diagnostic scripts report whether the proxy and the VM are set up correctly. Neither changes any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy):** from the environment directory, with the proxy up, run `.configamatron\proxy\verify-proxy.ps1`.
- **VM (configuration):** inside the VM, run `/mnt/vm-shared/verify-config.sh [host-ip]`. Pass the `<host-ip>` from proxy setup to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.

## Watching proxy traffic

`configamatron run-proxy` streams how the proxy handled each host, inline with its own status lines. Each host/handling pair is printed once; the tracking resets when an allow-list edit restarts the proxy (so you can immediately see how the edited entries are handled) and survives credential-rotation restarts.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (VM's own TLS)
- `ALLOW HTTP` — :80, allowed
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)

## Development

### Prequisites

- all host prerequisites except a VM guest (the dev test suite uses WSL2/QEMU, not a Hyper-V guest)
- A real Ubuntu (or other Debian-based) WSL2 distro must be installed and set as the **default** distro (`wsl --install -d Ubuntu`, then `wsl --set-default Ubuntu` if needed). `wsl.exe` is invoked without `-d` throughout the harness, so it runs whatever distro is default — if Docker Desktop's own minimal `docker-desktop` distro ends up default (e.g. on a fresh machine with no other distro registered), `wsl.exe -u root -e bash ...` fails with `execvpe(bash) failed: No such file or directory`, since that distro is BusyBox-based with no bash or apt. Check with `wsl -l -v`.
- wsl2 is used to spin up a vm for testing purposes. The ~/.wslconfig must contain:

```ini
[wsl2]
networkingMode=mirrored

[experimental]
ignoredPorts=67
```

### Verification Pipeline

Run these commands in order to verify a change is correct (fail-fast order):

| Step | Command | What it checks |
| --- | --- | --- |
| 1 | `pnpm format:check` | Prettier formatting |
| 2 | `pnpm lint` | ESLint rules |
| 3 | `pnpm typecheck` | TypeScript types (no emit) |
| 4 | `pnpm test:unit` | Unit tests (Vitest) |
| 5 | `pnpm build` | Production build (tsup → `dist/cli.js`) |
| 6 | `pnpm test:cli` | End-to-end tests against the built CLI |
| 7 | `pnpm test:guest` | Guest tests (QEMU in WSL2) — run when touching `templates/vm-shared/` or proxy config; **not** part of `pnpm test` |

Run the full pipeline (steps 1–6) in one command:

```
pnpm test
```

> The cli suite shells out to `jq`; install it on the dev host (and CI) or the jq-dependent tests self-skip.

# configamatron

configamatron sets up isolated environments for coding agents. A Windows and/or Ubuntu VM is isolated behind an Envoy proxy running in Docker on the host; the proxy restricts network access to an allow list and injects credentials so the VM never holds them. Each environment lives in a `.configamatron` folder inside whatever working directory you find appropriate.

Only one proxy container can run on the host at a time (it binds ports 80/443). Starting any environment's proxy — or running this repo's test suite — replaces whichever proxy container was running. Run one environment at a time; running `configamatron run-proxy` in an environment's directory restores its proxy.

## Host prerequisites

- Running on platforms besides Windows and/or VM hosts besides VMWare may work fine. In those cases though you'll need to open http/https ports 80/443 for the proxy host to your VM.

- Windows
- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- Tested with a Windows host and VMWare Workstation for the isolated VM.
  - Host's firewall's ports 80 and 443 for VMWare's network adapter will be opened by a supplied script. Using another OS or VM platform will require the same ports be available for the VM to reach the host.

## Installation

```
pnpm install
pnpm build
pnpm install -g .
```

## Proxy setup

Usually done once per environment. Run every command from the environment directory (the folder that owns the environment, e.g. `e:\repo`):

1. `configamatron init` — creates `.configamatron/` scaffolding needed to manage the environment. Do not commit to source control, includes credentials that the isolating proxy may inject.
2. `configamatron generate-ca` — writes the root certificate authority the proxy's https certificates chain to. Run once per environment; `run-proxy` reissues the per-host leaf certificate automatically as the allow list changes.
3. `configamatron write-github-config` — prompts for a GitHub fine-grained personal access token and writes `vm-shared/github-config.txt` (username/email come from your global git config). Create the token at https://github.com/settings/personal-access-tokens/new, scoped to the repositories the agent should use, with read/write permission to 'Contents'.
4. `configamatron run-proxy` — builds `proxy/envoy.yaml` from `proxy/allowlist.txt` and launches the proxy in a docker container with the latest Claude credentials. While it runs it watches both files: editing the allow list takes effect live (config rebuilt, leaf certificate reissued if the terminate hosts changed, proxy restarted), and credential rotations propagate automatically. It also streams the proxy's access log inline (see "Watching proxy traffic" below) and forwards the VMware host-only interface's `:80`/`:443` to Envoy on loopback, so it must stay running for the VM to reach the proxy (Envoy is published on `127.0.0.1` only). Pass `--no-forward` to disable forwarding, or `--forward-listen <ip>` to override the bind address.
5. **Windows hosts only:** in an **Administrator** PowerShell, run `powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1`. This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter, and _prints the host IP you need to use in VM-side setup_.

- It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.

## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

> For a **Windows** guest instead of Ubuntu, follow `usage-windows-vm.md` and share the `.configamatron\vm-shared-windows` folder. The steps below cover the Ubuntu guest.
>
> To run either guest under **Hyper-V** instead of VMware, follow `usage-hyper-v.md` — it covers the switch, static-IP, and SMB-share differences, then hands back to the numbered scripts here (Ubuntu) or in `usage-windows-vm.md` (Windows).

### Create the VM and install the OS

- In VMware Workstation, create a new virtual machine:
  - Set a recent Ubuntu release as the installer image (ubuntu-26.04-desktop-amd64.iso is known to work).
  - 120 GB of dynamic disk space (or ask google for values for your intended use cases).
  - Select "Customize Hardware" before finishing: 12288 MB of static memory (or no more than half of the host machine's memory), 1 processor with 6 cores (or ask google for values for your specific processor). Leave the network as NAT for initial setup, pre-isolation.
- Start the VM and install the OS. Pick the defaults, except:
  - Uncheck "Require my password to log in" — anyone with access to the VM already has access to the host, and it is easier this way. Your password is still required for sudo.
  - Do not select "Install third-party apps for graphics and wi-fi hardware"; it may stall OS installation.
  - Do not enable Shared Folders before the OS is installed; it may stall OS installation.

### Enable open-vm-tools and share the environment folder

Run in the VM's terminal ('-desktop' helps with screen resolution on top of open-vm-tools' shared folders and copy'n'paste integration).

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Shut the VM down, then in VM -> Settings -> Options:

- "Shared Folders": enable only the environment's `.configamatron\vm-shared` folder, read-only.
- "Guest Isolation": consider disabling drag'n'drop and copy'n'paste sharing.

### Fix Shared Folders

#### The Inevitable Fix

Add the following line to '/etc/fstab' and restart the VM.

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

#### Not Sure The Inevitable Fix Is Right For You?

Maybe someday the fix above won't make sense. Is today that day? Start the VM and verify the share appears under `/mnt/hgfs/`. If there is no `/mnt/hgfs`, stop and restart folder sharing. If `/mnt/hgfs` doesn't contain your shared drive then do The Inevitable Fix above.

### Run the numbered scripts from the VM

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

Run the scripts from the shared folder in number order. Run them without `sudo` — each script uses `sudo` internally where it needs root. Open a **new terminal** where noted so the shell picks up PATH changes written to `~/.bashrc`:

1. `01-apt-packages.sh`
2. `02-install-pnpm.sh`
3. Open a new terminal, then `03-install-tools.sh`
4. Open a new terminal, then `04-configure-tools.sh` — a browser opens for context7 login; close it and cancel the script if you don't want to use credentials.
5. `05-github-auth.sh`
6. `06-trust-ca.sh` — trusts the proxy CA. Defaults to the `cert.pem` sitting next to the script.
7. `07-setup-persistence.sh <host-ip>` — `<host-ip>` is printed by proxy setup step 6. Installs and starts dnsmasq (local DNS stub) and the `configamatron-egress.service` DNAT rules, and points the VM's resolver at the local stub via a netplan override. Both units start automatically on every future VM boot.
8. `08-claude-config.sh` — sets `hasCompletedOnboarding` in `~/.claude.json` (the CLI refuses to run otherwise) and symlinks `~/.claude/.credentials.json` to the shared `credentials.json`, replacing the old manual copy.
9. Switch the VM's network from NAT to host-only then reboot the VM so boot-time rules and take affect.

## Verifying an environment

Two read-only diagnostic scripts report whether the proxy and the VM are set up correctly. Neither changes any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy):** from the environment directory, with the proxy up, run `.configamatron\proxy\verify-proxy.ps1`.
- **VM (configuration):** inside the VM, run `./mnt/hgfs/vm-shared/verify-config.sh [host-ip]`. Pass the `<host-ip>` from proxy setup to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.

## Watching proxy traffic

`configamatron run-proxy` streams how the proxy handled each host, inline with its own status lines. Each host/handling pair is printed once; the tracking resets when an allow-list edit restarts the proxy (so you can immediately see how the edited entries are handled) and survives credential-rotation restarts.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (VM's own TLS)
- `ALLOW HTTP` — :80, allowed
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)

## Development

### Prequisites

- all host prereuisites except VMWare
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
| 6 | `pnpm test:e2e` | End-to-end tests against the built CLI |
| 7 | `pnpm test:vm` | VM e2e tests (QEMU in WSL2) — run when touching `templates/vm-shared/` or proxy config; **not** part of `pnpm test` |

Run the full pipeline (steps 1–6) in one command:

```
pnpm test
```

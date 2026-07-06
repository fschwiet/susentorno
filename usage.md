# configamatron usage

configamatron sets up isolated environments for coding agents. An Ubuntu VM is isolated behind an Envoy proxy running in Docker on the host; the proxy restricts network access to an allow list and injects real credentials so the VM never holds them. Each environment lives in a `.configamatron` folder inside whatever working directory you find appropriate.

Only one proxy container can exist on the host (it binds ports 80/443). Starting any environment's proxy — or running this repo's test suite — replaces whichever proxy container was running. Run one environment at a time; re-run `configamatron run-proxy` in an environment's directory to restore its proxy.

## Host prerequisites

- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- VMware Workstation, for the VM.
- configamatron installed globally from a checkout of this repository:

  ```
  pnpm install
  pnpm build
  pnpm install -g .
  ```

## Proxy setup

Usually done once per environment. Run every command from the environment directory (the folder that owns the environment, e.g. `e:\repo`):

1. `configamatron init` — creates `.configamatron/` containing `vm-shared/` (everything the VM consumes) and `proxy/` (everything the proxy consumes), copies the packaged allow list to `proxy/allowlist.txt`, and writes `vm-shared/credentials.json` — a copy of your host Claude credential with the tokens replaced by sandbox placeholders. Refuses to run if `.configamatron` already exists; delete the folder to rebuild from scratch.
2. `configamatron generate-ca` — writes `proxy/ca/cert.pem` + `key.pem` and copies the cert to `vm-shared/cert.pem`. An existing valid pair is reused, so restoring a previously generated CA into `proxy/ca/` before this step preserves it.
3. `configamatron build-envoy-config` — builds `proxy/envoy.yaml` from `proxy/allowlist.txt`. Edit this environment's allow list and re-run to change what the VM may reach.
4. `configamatron write-github-config` — prompts for a GitHub fine-grained personal access token and writes `vm-shared/github-config.txt` (username/email come from your global git config). Create the token at https://github.com/settings/personal-access-tokens/new, scoped to the repositories the agent should use, with read/write access to Contents.
5. `configamatron run-proxy` — writes the SDS secret from your current Claude credential, (re)creates the Envoy container so it serves that token, then stays in the foreground: it watches `~/.claude/.credentials.json`, recreates the container whenever the token changes, and nudges the `claude` CLI to refresh the token shortly before it expires. Leave it running (like `docker compose up` without `-d`); Ctrl-C stops it and leaves the container running.
   - Must run on the host with the `claude` CLI installed and logged in (it is the sole authority over `credentials.json`).
   - Pass `--no-refresh` to only watch and propagate without nudging the CLI. `configamatron run-proxy --help` lists all flags.
6. **Windows hosts only:** in an **Administrator** PowerShell, run `powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1`. Windows Firewall blocks inbound connections by default, which silently breaks the VM's DNAT'd traffic to Envoy even though everything else is configured correctly. This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter, and prints the host IP to use in VM-side setup. It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
   - Mac/Linux hosts: not yet scripted — allow inbound tcp/80 and tcp/443 from the VM through your host firewall equivalent (`pfctl`/`ufw`) and determine the host-only interface's IP yourself.

## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

### Create the VM and install the OS

- In VMware Workstation, create a new virtual machine:
  - Set a recent Ubuntu release as the installer image (ubuntu-26.04-desktop-amd64.iso is known to work).
  - 120 GB of dynamic disk space.
  - Select "Customize Hardware" before finishing: 12288 MB of static memory (or no more than half of the host machine's memory), 1 processor with 6 cores (ask google for values for your specific processor). Leave the network as NAT for initial setup, pre-isolation.
- Start the VM and install the OS. Pick the defaults, except:
  - Uncheck "Require my password to log in" — anyone with access to the VM already has access to the host, and it is easier this way. Your password is still required for sudo.
  - Do not select "Install third-party apps for graphics and wi-fi hardware"; it may stall OS installation.
  - Do not enable Shared Folders before the OS is installed; it may stall OS installation.

### Enable open-vm-tools and share the environment folder

Run in the VM's terminal ('-desktop' helps with screen resolution on top of open-vm-tools' shared folders and copy'n'paste integration):

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Shut the VM down, then in VM -> Settings -> Options:

- "Shared Folders": enable only the environment's `.configamatron\vm-shared` folder, read-only.
- "Guest Isolation": consider disabling drag'n'drop and copy'n'paste sharing.

Start the VM and verify the share appears under `/mnt/hgfs/`. If it doesn't, stop and restart folder sharing. If `/mnt/hgfs` stays empty, add this line to `/etc/fstab` and reboot:

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

### Run the numbered scripts

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

Run the scripts from the shared folder in number order. Run them without `sudo` except where noted — each script uses `sudo` internally where it needs root. Open a **new terminal** where noted so the shell picks up PATH changes written to `~/.bashrc`:

1. `01-apt-packages.sh`
2. `02-install-pnpm.sh`
3. Open a new terminal, then `03-install-tools.sh`
4. Open a new terminal, then `04-configure-tools.sh` — a browser opens for context7 login; close it and cancel the script if you don't want to use credentials.
5. `05-github-auth.sh`
6. `sudo <path>/06-trust-ca.sh` — trusts the proxy CA. Defaults to the `cert.pem` sitting next to the script.
7. `sudo <path>/07-setup-persistence.sh <host-ip>` — `<host-ip>` is printed by proxy setup step 6. Installs and starts dnsmasq (local DNS stub) and the `iptables-rules@<host-ip>.service` DNAT rules, and points the VM's resolver at the local stub via a netplan override. Both units start automatically on every future VM boot.
8. Put the placeholder credential where the Claude Code CLI expects it:

   ```
   mkdir -p ~/.claude && cp /mnt/hgfs/vm-shared/credentials.json ~/.claude/.credentials.json
   ```

### Isolate and verify

- Switch the VM's network from NAT to host-only, then **reboot the VM** so the boot-time rules unit installs the host-only default route (host-only mode has no DHCP gateway). `sudo systemctl restart iptables-rules@<host-ip>.service` is an alternative to a reboot.
- Verify from inside the VM:
  - `curl` to an allow-listed domain succeeds; a non-allow-listed domain fails/resets.
  - The coding agent works against `api.anthropic.com` using only the placeholder credential.
  - `apt-get update` succeeds (validates port 80 handling).

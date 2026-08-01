# configamatron

# susentorno

configamatron sets up isolated environments for coding agents. A Windows and/or Linux VM is isolated behind an Envoy proxy running in Docker on the host; the proxy restricts network access to an allow list and injects credentials so the VM never holds them. Each environment lives in a `.configamatron` folder inside whatever working directory you find appropriate.

## Host prerequisites

- Windows host
- **Hyper-V** for the isolated VM (see [setup-machine.md](setup-machine.md) and [setup-guest.md](setup-guest.md)).
- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- The `codex` CLI installed and logged in (so `~/.codex/auth.json` exists).
- The host firewall's ports 80 and 443 for the VM's Internal-switch adapter, opened via [setup-machine.md](setup-machine.md). Running on other platforms may work but is untested; you would need those same ports reachable from the host to the VM.

## Network Topology

A dedicated network endpoint is created on the host machine to act as the uplink to guest virtual machines. In Hyper-V, this is configured as a "Virtual Switch". This endpoint provides DHCP so the guest can join the network and get an IP address and provides a socket-level proxy to gate internet access and inject credentials. SMB is unblocked on the host for file sharing, the guest may want to run an SSH server to allow remote console access.

Only one proxy container can run on the host at a time (it binds to ports 80/443 on a network endpoint dedicated to configamatron environments). Starting any environment's proxy — or running this repo's test suite — replaces whichever proxy container was running. Run one environment at a time; running `configamatron run-proxy` in an environment's directory restores its proxy.

## Installation

A CLI app is installed globally to help setup environments and run the proxy. 'npm' probably works too if thats what you have installed.

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

## custom Guest Setup can be reused from source control

I recommend running 'configamatron init' from a folder in source control. A ".configamatron" folder is created for files related to an environment including a .gitignore that will ignore everything except customization endpoints you'll want to keep in source control.

Since you'll likely want to work with different repositories from your guest VMs you should probably use a separate repository for your configamatron setup.

When creating a new environment you can clone the repository then run git init within it. To recreate an existing environment- after ensuring you've committed and pushed customizations you like- delete everything but your .git folder, run 'configamatron init' then revert your customized files.

### Customizing setup scripts

Put `NN-name.sh` and/or `NN-name.ps1` steps in `.configamatron/pre-scripts/` or `.configamatron/post-scripts/`. Pre-scripts run with full network access before isolation; post-scripts run after the your machine has been isolated. Pre-scripts is a good time to do things where you want full internet access, post-script is a good time to give your code tools a YOLO configuration. Run `configamatron update-shares` after editing to update the setup scripts shared to your VMs. Each folder's `README.md` documents naming and sibling-resource rules.

### Customizing settings transforms

`.configamatron/home-jq-transforms/` holds a `manifest.yaml` plus `.jq` files that can specify transforms to apply to json-based configuration files. Add or edit transforms, then run `configamatron update-shares` to update the setup scripts shared to your VMs (`--dry-run` will let you preview the result of the transforms applied to an empty json document).

## Development

See [development.md](development.md) for the requirements and setup to run configamatron's own test suite, and [testing.md](testing.md) for how the tests are organized.

## Why Hyper-V?

I chose Hyper-V because its the only way I could find I could nested virtualization to work without disabling Windows security features and WSL which rely on Hyper-V. And nested virtualization is necessary to support docker running on a Windows guest VM. It is what it is.

If you want to run a different virtualization platform it should work as long as you can support the network topology. I couldn't get the current topology working with VMWare Workstation as it only allow me to bind to vmnetN network endpoints which did not seem to allow the host to bind to their DHCP and/or SMB port. I had previously used VMWare by configuring them to use static IP addresses and setting up the guest DNS config to always point to the VMNet endpoint (where run-proxy bound its proxy). I didn't want to try to support that going forward but am mentioning it here in case you want to go down that path.

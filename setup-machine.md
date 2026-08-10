# Machine setup

Per-machine setup for a Windows host, done once before setting up any environment. Complete the [Host prerequisites](README.md#host-prerequisites) first, then this doc, then [setup-environment.md](setup-environment.md).

## 1. Create the host network

The isolated network for guests is a Hyper-V **Internal virtual switch** (host + VMs, no internet). `susentorno run-hosting` supplies DHCP and DNS on it. The host IP is the one value that threads through the entire setup:

> **One host IP, used everywhere:** the static IPv4 assigned to the host's `vEthernet (susentorno-internal)` adapter is simultaneously the SMB server address, the `run-hosting --forward-listen` target, and the `<host-ip>` argument to the guest's `nn-configure-network.*` script. This stays the same during guest setup (when network access is direct to the internet) and after the guest is isolated (when traffic must go through the proxy).

(This replacement fixes a naming staleness in the original text while it's already being rewritten: `setup-machine.md` said `05-*`, but the templates were already renamed to `nn-configure-network.sh`/`nn-configure-network.ps1` — confirmed via `templates/vm-shared-*/pre-scripts/`. Not otherwise in scope for this task; fixed here only because this exact sentence is being replaced anyway.)

> **Two host addresses, only one stable.** The Default Switch address used during a guest's NAT phase is regenerated across host reboots. Look it up with `Get-NetIPAddress -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4` when needed.

In an **Administrator** PowerShell on the host:

```powershell
susentorno create-host-network
```

This creates the Internal switch, assigns it a static host IP, and opens the host firewall (inbound Envoy `80`/`443`, DNS `53`, DHCP `67`, and SMB `445`) for the VM's Internal-switch adapter — replacing what used to be a manual `New-VMSwitch`/`New-NetIPAddress` step plus a separate firewall script. You'll be prompted for the subnet's third octet (`192.168.<n>.x`, with a free default suggested — this doc set's examples assume `192.168.67.x` was chosen, giving a host IP of `192.168.67.1`); pass `--subnet <n>` to skip the prompt. It prints the host IP you need for guest-side setup.

- **Safe to rerun**: against an already-created switch, it refreshes the firewall rules only (useful if the Default Switch's IP ever changes) — it never recreates the switch or weakens any rule's scoping.
- Run `susentorno delete-host-network` first if you want to recreate the network from a clean state (a different subnet, for example) — it also removes any leftover firewall rules on the adapter regardless of who created them, so it doubles as a way to recover from a corrupted setup.
- It runs `run-hosting` from a dedicated private copy of `node.exe` so the firewall's program-scoped rule can't be inherited by any other use of a shared interpreter (see [ADR-0003](docs/adr/0003-transparent-interception-and-network-isolation-boundary.md)).
- This is a one-time, per-host step, done before setting up any environment — later environments don't need to repeat it.

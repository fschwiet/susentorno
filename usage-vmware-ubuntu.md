!!! This document is not supported at this time !!!

## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

> For a **Windows** guest instead of Ubuntu, follow `usage-windows-vm.md` and share the `.configamatron\vm-shared-windows` folder. The steps below cover the Ubuntu guest.
>
> To run either guest under **Hyper-V** instead of VMware, follow `usage-hyper-v.md` — it covers the switch, static-IP, and SMB-share differences, then hands back to the numbered scripts here (Ubuntu) or in `usage-windows-vm.md` (Windows).

### Create the VM and install the OS

- In VMware Workstation, create a new virtual machine:
  - Set a recent Ubuntu release as the installer image (ubuntu-26.04-desktop-amd64.iso is known to work).
  - 120 GB of dynamic disk space (or ask google for values for your intended use cases).
  - Select "Customize Hardware" before finishing: 12288 MB of static memory (or no more than half of the host machine's memory), 1 processor with 6 cores (or ask google for values for your specific processor). Leave the network as **NAT** for initial setup, pre-isolation — the isolated host-only network is set up separately under [Networking](#networking-the-isolated-host-only-network).
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

Run without `sudo`; each script elevates internally where needed. The exact count may vary when custom steps are present.

1. `cd` into `vm-shared/pre-scripts/` and run every script in number order. The last step is `05-configure-network.sh <host-ip>` when there are no custom scripts, where `<host-ip>` is the host-only adapter's IP (`192.168.67.1` in this guide — see [Networking](#networking-the-isolated-host-only-network)).
2. Start the host services (firewall + `run-proxy`), then switch the VM's adapter from NAT to the host-only network and reboot. Both steps are detailed under [Networking](#networking-the-isolated-host-only-network) ("Start the host services" and "Isolate the VM").
3. `cd` into `vm-shared/post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.

## Networking: the isolated host-only network

The guest uses **two** VMware networks across its life, and only the network _type_ changes — the guest stays on **DHCP** throughout, exactly as under Hyper-V:

- **NAT (VMnet8)** during OS install and the `pre-scripts` phase — real gateway and DNS, so packages install.
- **Host-only (a `VMnetN` you create)** once isolated — no internet; `run-proxy` on the host supplies DHCP, DNS, and the only gateway.

These map onto the Hyper-V doc's switches: NAT ↔ "Default Switch", host-only ↔ the `configamatron-internal` Internal switch. The single most important VMware-specific difference is step 1.3 below: a host-only VMnet ships with its **own DHCP server on**, which a Hyper-V Internal switch does not — leave it enabled and it out-races `run-proxy`.

> **One host IP, used everywhere.** The IPv4 on the host's `VMware Network Adapter VMnetN` is simultaneously the DHCP/DNS/gateway address `run-proxy` serves, the `--forward-listen` target, and the `<host-ip>` argument to `05-configure-network.sh`. This guide assumes `192.168.67.1`.

### 1. Create the host-only network (Virtual Network Editor)

**Edit → Virtual Network Editor** (click "Change Settings" for admin rights):

1. Add a network on a free VMnet (e.g. **VMnet2**), type **Host-only**, with "Connect a host virtual adapter to this network" checked. Do **not** also attach NAT to it — host-only-plus-NAT would route the guest to the internet and defeat the isolation.
2. Set **Subnet IP** `192.168.67.0`, mask `255.255.255.0`. Pick a `192.168.n.0/24` that `ipconfig` shows is free.
3. **Uncheck "Use local DHCP service to distribute IP addresses to VMs"** on that VMnet. This is the one step with no Hyper-V equivalent: Hyper-V Internal switches have no DHCP, but a VMware host-only VMnet ships one **on** by default, and it will out-race `run-proxy` and hand the guest a lease pointing at VMware's own gateway/DNS — silently defeating the isolation below.
4. Apply, then confirm the IPv4 of **"VMware Network Adapter VMnet2"** with `ipconfig` (normally `192.168.67.1`). That is your one host IP.

Keep it a `/24` — `run-proxy` defaults its lease pool and netmask to `255.255.255.0` when serving a VMware adapter.

### 2. Start the host services (before the first isolated boot)

`run-proxy` and `host-allow-vm-inbound.ps1` both default to the Hyper-V adapter name `vEthernet (configamatron-internal)`, which does not exist under VMware, so both need an override:

```powershell
# Firewall (Envoy 80/443, DNS 53, DHCP 67), scoped to the VMware host-only adapter:
powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1 -AdapterAlias "VMware Network Adapter VMnet2"

# Gateway + DNS + DHCP, told which host IP to serve from:
configamatron run-proxy --forward-listen 192.168.67.1
```

The DHCP rule stays interface-scoped (as the script writes it); a DHCP `DISCOVER` is broadcast from `0.0.0.0`, so a destination-address condition would drop it.

### 3. Isolate the VM

1. Shut the VM down.
2. **VM → Settings → Network Adapter** → **Custom: Specific virtual network** → the host-only **VMnet2**. Keep it a **single** adapter; do not add a second one on another network — a guest with legs on both networks defeats the isolation.
3. Confirm `run-proxy` is running, then boot. The guest's DHCP configuration is unchanged; it simply leases from `run-proxy` now instead of VMware's NAT DHCP.

Reverse isolation by switching the adapter back to NAT; no guest-side change is needed. The HGFS shared folder (`/mnt/hgfs`) is unaffected throughout — it rides VMware's backdoor channel, not the network, so it keeps working across the NAT → host-only switch and needs no re-addressing (unlike Hyper-V's SMB share).

### Will the guest use `run-proxy` for DHCP? (four preconditions)

Yes, once these line up — the guest's broadcast `DISCOVER` reaches the host's virtual adapter on the shared host-only segment:

1. VMware's own DHCP is **off** on that VMnet (step 1.3).
2. `run-proxy --forward-listen 192.168.67.1` — it binds DHCP to whatever that resolves to; without it, `run-proxy` hunts for the Hyper-V adapter and never binds here.
3. The firewall allows **UDP 67** inbound on the host-only adapter (step 2), interface-scoped.
4. The host-only subnet is a `/24`, matching `run-proxy`'s default pool.

### How this isolates the guest from the internet

Disabling VMware's DHCP is not itself the isolation — it just lets `run-proxy` own the guest's routing and DNS. The isolation is three layers:

1. **VMware provides no path off the segment.** A host-only VMnet has no NAT engine and no bridge to a physical NIC, so there is no VMware-supplied route to the internet at all. This is the primary boundary — which is why step 1 forbids also attaching NAT.
2. **Every name resolves to the host, and only the proxy answers there.** `run-proxy`'s lease sets default-route = DNS = the host IP, and the DNS responder answers _every_ A query with that IP. The guest never learns a real internet address; every connection lands on Envoy (80/443), which terminates TLS and forwards **only allowlisted SNI** upstream. Everything else is dropped at the proxy.
3. **The host does not route the guest onward.** Although the guest's gateway is a machine with internet on its other adapters, Windows does not forward between interfaces (`Forwarding: disabled`) and the host-only adapter is strong-host (`Weak Host Receives: disabled`), so a packet aimed at a raw internet IP is dropped rather than NAT'd out.

> **Caveat (defense-in-depth gap).** Layer 3 relies on two Windows defaults — the strong host model and no inter-interface forwarding — that this project neither sets nor verifies. They held wherever measured, but if something flipped them (an ICS/RRAS reconfiguration, a manual `netsh ... weakhostreceive=enabled`), a guest could reach the host's _other_ IPs on the allowed ports and, on `:53`, fall through to ICS's real recursive resolver as a DNS egress channel. See `docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md`.

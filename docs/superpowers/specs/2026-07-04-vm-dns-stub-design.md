# VM-Resident DNS Stub — Design

## Purpose

Move the sandbox's DNS-answering responsibility from a script the user manually runs on the host (`scripts/host-dns-stub.js`, "leave running in its own terminal") into the VM itself, and make it — along with the VM's iptables DNAT rules — start automatically every time the VM boots. Today both require a manual step per session (start the host script; re-run `vm-setup-iptables.sh` inside the VM after every reboot); this design eliminates both manual steps.

See `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md` for the full sandbox design this extends. This document only covers the DNS-answering and persistence pieces described there as manual host/VM steps.

## Non-goals

- Building a real DNS resolver. The stub still answers every A-record query with a fixed placeholder IP; the actual destination is irrelevant because iptables DNAT redirects by port only and Envoy re-resolves hostnames itself (per the existing design's Non-goals).
- Changing how Envoy or the allow list work. Unaffected.
- Solving the (pre-existing, out of scope) race between systemd-resolved starting to forward DNS and `dns-stub.service` becoming ready at boot. This is a narrow window that self-heals via retry/TTL; no new ordering machinery is added for it.

## Architecture

DNS answering moves entirely into the VM:

```
┌────────────────────────────────────────────────────────────┐
│  Ubuntu VM (VMware)                                          │
│                                                                │
│  systemd-resolved (unchanged)                                 │
│    - stub listener on 127.0.0.53:53, serves local processes   │
│    - upstream DNS, set via netplan, now 127.0.0.1 (was: host  │
│      IP, as handed out by VMware's DHCP)                      │
│         │                                                     │
│         ▼                                                     │
│  dns-stub.service (systemd, new)                               │
│    - node vm/dns-stub.js, binds 127.0.0.1:53                  │
│    - answers every A query with a fixed placeholder IP        │
│                                                                │
│  iptables-rules@<host-ip>.service (systemd template, new)      │
│    - bash vm/vm-setup-iptables.sh <host-ip>                   │
│    - re-applies the existing DNAT rules (tcp/80, tcp/443       │
│      → host) on every boot                                    │
└────────────────────────────────────────────────────────────┘
```

Both new units are enabled with `systemctl enable --now`, so the same invocation both applies the change immediately and configures it to reapply on every future boot — there is no separate one-off script call that could drift from what happens on reboot.

### Why netplan for the DNS override, not editing `/etc/resolv.conf`

On stock Ubuntu, `/etc/resolv.conf` is a symlink systemd-resolved manages; overwriting it as a plain file works until something else regenerates that symlink and reverts it. A netplan drop-in setting the interface's nameserver to `127.0.0.1` is declarative, reapplied automatically by systemd-networkd on every boot, and leaves systemd-resolved's own management of `/etc/resolv.conf` untouched — systemd-resolved just forwards upstream queries to our stub instead of the host.

### Why a systemd template unit for iptables, not a plain unit

The DNAT target is the host's IP, which is fixed per host machine/session but not compile-time-known. Using a template unit (`iptables-rules@.service`, `ExecStart=/usr/bin/bash <path>/vm/vm-setup-iptables.sh %i`) instantiated as `iptables-rules@<host-ip>.service` lets the existing `vm-setup-iptables.sh` script be reused unmodified, with the host IP captured once at `enable --now` time and baked into the enabled unit for every subsequent boot.

### Executable bits

The `vm/` folder is copied from a Windows host, which does not track the POSIX executable bit. The existing scripts in this repo already avoid depending on it by being invoked as `bash vm/foo.sh` rather than `./vm/foo.sh`. Both new systemd units follow the same convention — `ExecStart` names the interpreter explicitly (`node` / `bash`) rather than executing `dns-stub.js` or `vm-setup-iptables.sh` directly — so no script here ever needs its executable bit set.

## Components / Deliverables

- `vm/dns-stub.js` — adapted from `scripts/host-dns-stub.js`: identical placeholder-A-record logic, but hardcoded to bind `127.0.0.1:53` (drops the `<bind-ip>` CLI arg, since it no longer needs to be reachable from the host-only network).
- `vm/dns-stub.service` — systemd unit for `dns-stub.js`. `Restart=on-failure`; no dependency on the network interface being configured, since it only binds loopback.
- `vm/iptables-rules@.service` — systemd template unit wrapping the existing `vm/vm-setup-iptables.sh`.
- A netplan drop-in (e.g. `vm/60-dns-override.yaml`, installed to `/etc/netplan/`) setting `nameservers.addresses` to `[127.0.0.1]`. Per `vm-setup.md` the VM has a single network adapter, so the drop-in targets it via a broad `match` (e.g. `name: "en*"`, covering typical predictable interface names) rather than requiring `vm-setup-persistence.sh` to discover the exact interface name at install time.
- `vm/vm-setup-persistence.sh <host-ip>` — new orchestration script, run once with `sudo` during VM-side setup. Installs the two unit files into `/etc/systemd/system/`, runs `systemctl daemon-reload`, installs the netplan drop-in and runs `netplan apply`, then `systemctl enable --now dns-stub.service` and `systemctl enable --now iptables-rules@<host-ip>.service`.
- `scripts/host-dns-stub.js` — deleted.
- `scripts/host-allow-vm-inbound.ps1` — drops the `New-NetFirewallRule` call for UDP/53, but keeps the existing `Get-NetFirewallRule -DisplayName $dnsRuleName ... | Remove-NetFirewallRule` line so that re-running the script on a host that previously created the stale rule cleans it up automatically. The TCP 80/443 rule is unaffected.
- `envoy-proxy.md` — updated:
  - Host-side step 7 (firewall rule) keeps the TCP 80/443 half, loses the UDP 53 half and its mention of step 8.
  - Host-side step 8 (`node scripts/host-dns-stub.js ...`, "leave running in its own terminal") is deleted.
  - VM-side setup gains a new step after `vm-trust-ca.sh`: `sudo bash vm/vm-setup-persistence.sh <host-ip>`. The former standalone VM-side step (`sudo bash vm/vm-setup-iptables.sh <host-ip>`) is removed, since the new script subsumes it.

## Testing / Verification Plan

**Manual (requires the actual Ubuntu VM; not automated — same category as the parent design's VM-dependent checks):**

- Run `vm/vm-setup-persistence.sh <host-ip>` once. Confirm `systemctl status dns-stub.service` and `systemctl status iptables-rules@<host-ip>.service` both show active/running, without the host-side script or firewall rule for UDP 53 present.
- `resolvectl status` on the relevant interface shows `127.0.0.1` as the DNS server.
- From inside the VM: a DNS lookup for any hostname resolves to the placeholder IP; `curl` to an allow-listed domain succeeds; `apt-get update` succeeds.
- Reboot the VM. Without re-running any script by hand, confirm `dns-stub.service` and `iptables-rules@<host-ip>.service` are both active again and the same `curl`/`apt-get` checks still pass.
- On the host: re-run `scripts/host-allow-vm-inbound.ps1` and confirm the stale `Envoy Sandbox Proxy DNS stub (VM inbound)` firewall rule (if present from a prior run) is removed and not recreated.

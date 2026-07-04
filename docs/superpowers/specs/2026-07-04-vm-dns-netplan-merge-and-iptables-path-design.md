# VM DNS Netplan Merge + iptables Unit Path — Design

## Purpose

On first real-VM use of the DNS/iptables persistence introduced in
`docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md`, the VM had no
outbound connectivity — even `nslookup cnn.com` failed. Investigation found two
independent defects, both cases of an environment-specific value being baked
into a persistent artifact in a way that doesn't hold on this VM:

1. **DNS override never applies.** `vm/60-dns-override.yaml` used a distinct
   top-level netplan id (`dns-override`). On this Ubuntu Desktop install the
   netplan renderer is **NetworkManager**, under which each distinct top-level id
   becomes its own NM connection profile. netplan merges configuration across
   files only when they share the same id — so the override became a competing,
   inactive profile instead of merging into the installer's `ens33` profile. The
   DHCP-supplied DNS server (`192.168.241.1`, the host-only gateway, which runs no
   resolver) stayed in effect, and `systemd-resolved` never forwarded to the local
   dnsmasq stub. dnsmasq itself was verified healthy (`dig @127.0.0.1 cnn.com`
   returned the placeholder `203.0.113.1`); it was simply never queried.

2. **iptables unit references a shared-folder path.** `iptables-rules@.service`
   had `@@VM_DIR@@` substituted with the folder the setup script was run from —
   `/mnt/hgfs/vm`, a VMware shared-folder mount. That mount isn't available early
   in boot, so at reboot the unit failed with
   `/mnt/hgfs/vm/vm-setup-iptables.sh: No such file or directory`
   (`status=127`), leaving the nat table empty and no DNAT rules installed.

This spec fixes both so the DNS override lands in the active NM profile and the
iptables rules apply at every boot with no dependency on where the `vm/` folder
lives.

## Non-goals

- No change to dnsmasq, the stub config, the placeholder IP, or Envoy — those
  work as designed.
- No cleanup tooling for already-broken VMs: verification is done by building a
  fresh VM, so a re-run landing on top of stale state is out of scope.
- The pre-existing systemd-resolved forwarding-race at boot remains out of scope
  (unchanged from the parent specs).

## Architecture

Same pipeline as the parent dnsmasq spec — the fixes only change *how* two
persistent artifacts get their environment-specific values, so those values match
this VM's reality:

```
systemd-resolved  ──(per netplan override, now merged into the ACTIVE
                      NetworkManager profile)──►  127.0.0.1
        │
        ▼
dnsmasq.service (unchanged)  ─► 203.0.113.1 for every name

iptables-rules@<host-ip>.service (rules now inlined in the unit)
   ─► DNAT tcp/80, tcp/443 → <host-ip>
```

### Issue 1 — netplan id must match the installer's id

`vm/60-dns-override.yaml` becomes a template parameterized on the interface id:

```yaml
network:
  version: 2
  ethernets:
    @@IFACE@@:
      nameservers:
        addresses: [127.0.0.1]
```

The top-level id is `@@IFACE@@` and there is no `match:` block — when the id
equals the interface name, netplan binds by name. On a subiquity install the
installer's own `00-installer-config.yaml` names its ethernet block after the
interface (`ens33` here), so substituting the real interface name makes the two
files share an id, and netplan merges `nameservers` into that single NM profile.
DHCP-supplied DNS is thereby overridden (`ipv4.ignore-auto-dns` + `ipv4.dns` at
the NM layer), and systemd-resolved forwards to the dnsmasq stub.

`vm-setup-persistence.sh` discovers the interface at runtime and substitutes it,
reusing the `sed`/`@@…@@` pattern already used for `@@VM_DIR@@`:

```bash
iface="$(ip -o -4 route show default | awk '{print $5}' | head -n1)"
sed "s|@@IFACE@@|${iface}|g" "${script_dir}/60-dns-override.yaml" \
    > /etc/netplan/60-dns-override.yaml
chmod 600 /etc/netplan/60-dns-override.yaml
```

`head -n1` guards against multiple default routes. At persistence-run time the VM
is still on NAT (the host-only switch is a later step in `vm-setup.md`), so a
default route reliably exists.

**Why runtime discovery over a hardcoded `ens33`:** the interface name depends on
the virtual NIC type, PCI slot, and VMware/Ubuntu versions — a different VM can
get `ens160`, `eth0`, etc., and the installer config would use *that* name as its
id. A hardcoded `ens33` would silently reproduce the exact merge failure being
fixed. Discovery makes the id always match whatever the installer used.

**Why netplan, not resolved/nmcli:** a `resolved.conf.d` drop-in with global
`DNS=127.0.0.1`/`Domains=~.` can still lose to per-link DHCP DNS on the
default-route interface in resolved's routing logic. `nmcli con mod` is
id-agnostic but gets clobbered by `netplan apply`, which owns the NM renderer
here. Merging into the netplan-managed profile is the idiomatic, durable layer.

### Issue 2 — inline the DNAT rules into the unit

`vm/iptables-rules@.service` invokes `iptables` directly, dropping both the
wrapper script and the `@@VM_DIR@@` path:

```ini
[Unit]
Description=Sandbox VM iptables DNAT rules (host IP: %i)
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination %i:443
ExecStart=/usr/sbin/iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination %i:80

[Install]
WantedBy=multi-user.target
```

The host IP still arrives via the template instance `%i`, so the unit remains
`iptables-rules@<host-ip>.service`. Nothing under `/mnt/hgfs` is referenced, so
boot ordering relative to the shared-folder mount no longer matters.

`iptables -A` appends, but the nat table is empty at every boot, so the boot-time
append is always clean. The only way to get duplicate rules is a manual
`systemctl restart` within the same boot — harmless (two identical DNAT rules
match identically), so no idempotency machinery is added.

`vm-setup-persistence.sh` drops the `@@VM_DIR@@` substitution and simply copies
the unit file into `/etc/systemd/system/`. `vm/vm-setup-iptables.sh` is deleted —
its two commands now live in the unit and nothing else references it.

## Components / Deliverables

- `vm/60-dns-override.yaml` — templated: top-level id `@@IFACE@@`, no `match:`
  block.
- `vm/iptables-rules@.service` — DNAT rules inlined via two `ExecStart` lines; no
  external script, no `@@VM_DIR@@`.
- `vm/vm-setup-iptables.sh` — deleted.
- `vm/vm-setup-persistence.sh` — updated:
  - discover `iface` from the default route and `sed`-substitute `@@IFACE@@` into
    the copied netplan file (replacing the plain `cp`).
  - plain `cp` of `iptables-rules@.service` into `/etc/systemd/system/` (drop the
    `@@VM_DIR@@` `sed`).
- `vm-setup.md` / `envoy-proxy.md` — expected no change (they reference
  `vm-setup-persistence.sh` by name, not the iptables script); confirm during
  implementation.

## Testing / Verification Plan

**Manual (requires a fresh Ubuntu VM):**

- Run `sudo bash vm/vm-setup-persistence.sh <host-ip>`. Confirm no netplan
  permissions warning and `systemctl status dnsmasq` is active/running.
- `resolvectl status` on the active interface shows **`127.0.0.1`** as the DNS
  server (not the DHCP gateway) — this is the direct signal Issue 1 is fixed.
- `netplan get` shows `nameservers.addresses: [127.0.0.1]` under the *same*
  ethernet id as the installer config (e.g. `ens33`), with no separate
  `dns-override` block.
- `nslookup cnn.com` (and any other hostname) resolves to `203.0.113.1` via the
  normal resolver path — no timeout.
- `systemctl status iptables-rules@<host-ip>.service` is active (exited); `sudo
  iptables -t nat -L OUTPUT -n` shows the two DNAT rules to `<host-ip>`.
- `curl` to an allow-listed domain succeeds; a non-allow-listed domain
  fails/resets; `apt-get update` succeeds.
- **Reboot.** Without re-running anything by hand, confirm `resolvectl status`
  still shows `127.0.0.1`, both units are active, the DNAT rules are present, and
  the `curl`/`nslookup` checks still pass.

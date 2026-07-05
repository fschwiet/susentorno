# VM Host-Only Default Route — Design

## Purpose

On first real host-only use of the sandbox, the VM has no outbound connectivity:
a browser (or `curl`) to any allow-listed host fails immediately, and
`ip route get 203.0.113.1` returns `Network is unreachable`. The DNS stub answers
**every** hostname with the placeholder `203.0.113.1` (`vm/dnsmasq-stub.conf`), and
the iptables DNAT rules redirect tcp/80 and tcp/443 to Envoy on the host. But for
a locally-generated connection the kernel does a route lookup on the **original**
destination (`203.0.113.1`) *before* the `OUTPUT` nat chain runs — so the DNAT
never fires unless `203.0.113.1` is already routable.

In NAT or bridged mode a default route exists (DHCP hands out a gateway), so the
placeholder is routable and everything works. In **host-only** mode VMware's DHCP
hands out **no gateway**, so there is no default route, `203.0.113.1` is
unreachable, and the connection dies with `ENETUNREACH` before DNAT can rewrite
it. Host-only is the sandbox's intended final operating mode, so this breaks the
whole point of the setup.

The parent specs
(`docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md` and
`docs/superpowers/specs/2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md`)
repeatedly describe the placeholder IP as "irrelevant because DNAT redirects by
port only." That premise silently assumed a default route would always be
present; it isn't in host-only. This spec adds the missing default route so the
placeholder is routable in the isolated mode.

## Non-goals

- No change to the DNS stub, the placeholder IP, dnsmasq, the netplan DNS
  override, or Envoy — those work as designed once routing is fixed.
- Not building general VM connectivity: the default route points only at the
  host, which forwards nothing, so only the DNAT'd tcp/80 and tcp/443 reach
  anything (Envoy). Everything else stays blocked.
- No change to how the host IP is supplied — it continues to arrive via the
  systemd template instance name (`%i`).
- No cleanup tooling for already-broken VMs: re-running
  `vm-setup-persistence.sh` on the affected VM (or building a fresh one) picks up
  the change.

## Architecture

The host-only VM already treats the host (`<host-ip>`, e.g. `192.168.241.1`, the
vmnet1 host adapter) as the one node it can reach and the target of every DNAT'd
connection. We make it the VM's **default gateway** as well, so the initial route
lookup on the placeholder succeeds:

```
connect(203.0.113.1:443)
   │  route lookup on 203.0.113.1  ─► default via <host-ip> dev ens33   (NEW)
   ▼
OUTPUT nat DNAT (unchanged)  ─► rewrite dst to <host-ip>:443
   │  reroute (dst changed)  ─► <host-ip> is directly connected on ens33
   ▼
Envoy on the host  ─► SNI-routed to the real upstream
```

The default route is added by the existing boot-time rules unit, which already
runs on every boot with the host IP baked into its instance name.

### Where the route is added, and why it's guarded

`vm/iptables-rules@.service` gains a third `ExecStart` that installs the default
route **only when none already exists**:

```ini
[Unit]
Description=Sandbox VM network rules: DNAT + host-only default route (host IP: %i)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination %i:443
ExecStart=/usr/sbin/iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination %i:80
ExecStart=/bin/sh -c '/usr/sbin/ip -4 route show default | /usr/bin/grep -q . || /usr/sbin/ip route replace default via %i'

[Install]
WantedBy=multi-user.target
```

The guard (`... show default | grep -q . || ip route replace ...`) makes the
route command a **no-op whenever a default route already exists** — i.e. in NAT
or bridged mode — and only installs the route via the host when there is none, in
host-only. This matters because `vm-setup-persistence.sh` runs the unit via
`systemctl enable --now` while the VM is still on NAT (the documented setup
order): without the guard, `ip route replace default via <host-ip>` would fail
(the host IP is off-link in NAT), fail the unit start, and abort setup. With the
guard, setup succeeds untouched, and the route is installed on the first
host-only boot.

`grep` and `ip` are called by full path where practical; the pipeline and `||`
run under `/bin/sh -c` so the guard is a single unit action. `%i` is the systemd
template instance (the host IP), expanded the same way as in the DNAT lines.

### Ordering change: `local-fs.target` → `network-online.target`

The unit currently orders after `local-fs.target`, which is early enough for the
DNAT rules (they only touch the nat table) but too early to add a route via an
on-link gateway — the interface must be up with its host-only IPv4 address first.
The unit now `Wants`/`After` `network-online.target` (satisfied by
`NetworkManager-wait-online.service`, enabled by default on Ubuntu Desktop). This
delays the DNAT rules slightly too, which is harmless — they're only needed once
the network is usable, which is exactly what `network-online.target` marks.

### One reboot after switching to host-only

The route is installed by the unit at boot. When the operator switches the VM
from NAT to host-only, the already-running unit does **not** re-run, so the route
isn't added until the unit next runs. The setup docs therefore gain an explicit
step: **reboot the VM after switching to host-only** (a `systemctl restart
iptables-rules@<host-ip>.service` also works, but reboot is simpler and doubles
as verification that the whole persistent configuration comes up clean). The DNS
override and DNAT rules already persist across the mode switch; only the route
needs this.

### Why keep the `iptables-rules@.service` name

The unit now does slightly more than iptables, but keeping the filename avoids
orphaning the instance the operator already enabled
(`iptables-rules@<host-ip>.service`) and keeps the change to a re-run of
`vm-setup-persistence.sh` with no manual `disable` of the old name. Only the
`Description` broadens to reflect the added responsibility.

## Security / isolation considerations

Adding a default route via the host does **not** widen the sandbox:

- Packets to the placeholder on any port other than 80/443 are routed to the host
  as gateway but still carry destination IP `203.0.113.1` (not the host's own
  IP). The host is not a router for the isolated host-only segment, so it drops
  them. Only tcp/80 and tcp/443 — whose destination DNAT rewrites to the host's
  own IP — are accepted, and only by Envoy.
- The placeholder stays `203.0.113.1` (`203.0.113.0/24`, TEST-NET-3 documentation
  space per RFC 5737), which is not globally routable. Even a host misconfigured
  to forward would have nowhere to send it. This is a concrete reason to keep the
  placeholder as-is rather than resolving names to the host's real IP (the
  rejected alternative below), which would expose the host's own listening ports
  to the VM on every port.
- The VM could already reach the host's IP directly by literal address in
  host-only mode; this change adds no new reachability there.

### Rejected alternative: resolve every name to the host IP

Templating `dnsmasq-stub.conf` to answer with `<host-ip>` instead of
`203.0.113.1` would make the answer directly-connected and need no route at all —
simpler — but every hostname would then resolve to the host's real IP, letting
the sandboxed VM reach the host's own services on **any** port (ssh, dev servers,
etc.), not just the 80/443 Envoy path. On a security boundary that's an
unacceptable regression, so it's rejected in favor of the default-route approach.

### Rejected alternative: configure vmnet1 DHCP to hand out a gateway

Editing the host's VMware host-only DHCP to advertise a gateway would give the VM
a default route automatically, but it's host-side manual VMware configuration
that lives outside the repo and outside the setup scripts. Keeping the fix in the
VM-side unit keeps the whole persistence story in one place.

## Components / Deliverables

- `vm/iptables-rules@.service` — updated:
  - `After=network-online.target` + `Wants=network-online.target` (was
    `After=local-fs.target`).
  - new third `ExecStart` that installs `default via %i` only when no default
    route exists.
  - broadened `Description`.
- `vm/vm-setup-persistence.sh` — unchanged in behavior; it already copies the
  unit file and `systemctl enable --now`s the instance, so a re-run applies the
  new unit. (Confirm during implementation that no change is needed.)
- `envoy-proxy.md` — VM-side setup: the "switch to host-only" step gains "then
  reboot the VM."
- `vm-setup.md` — the final "Change network connection from NAT to host-only"
  step gains the same reboot note.

## Testing / Verification Plan

**Manual (requires the actual Ubuntu VM):**

- Re-run `sudo bash vm/vm-setup-persistence.sh <host-ip>` while on NAT. Confirm it
  completes without error (the route `ExecStart` is a no-op because a NAT default
  route exists) and `systemctl status iptables-rules@<host-ip>.service` is active
  (exited).
- Switch the VM to host-only and **reboot**.
- After reboot, without running anything by hand:
  - `ip -4 route show default` shows `default via <host-ip>` on the host-only
    interface.
  - `ip route get 203.0.113.1` resolves (no longer `Network is unreachable`) and
    shows it routing via `<host-ip>`.
  - `systemctl status iptables-rules@<host-ip>.service` is active; `sudo iptables
    -t nat -L OUTPUT -n` shows the two DNAT rules.
  - `resolvectl status` still shows `127.0.0.1` as the DNS server (unchanged from
    the parent spec).
  - `curl`/browser to an allow-listed domain succeeds; a non-allow-listed domain
    fails/resets; `apt-get update` succeeds.
  - A non-80/443 connection to the placeholder (e.g. `nc -vz 203.0.113.1 22`)
    fails — confirming the default route did not widen isolation.
- Reboot again and re-confirm the route, rules, and `curl` checks all persist
  with no manual step.

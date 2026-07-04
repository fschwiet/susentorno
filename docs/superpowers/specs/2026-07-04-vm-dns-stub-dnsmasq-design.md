# VM DNS Stub — Replace Node with dnsmasq

## Purpose

Supersede the Node-based DNS stub introduced in `docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md`. On first real-VM use, `dns-stub.service` crash-looped with `status=203/EXEC`: its `ExecStart=/usr/bin/node ...` assumed a system-wide Node install, but `vm/01-apt-packages.sh` and `vm/02-install-pnpm.sh` never install one — Node is only available via pnpm's own management, under a per-user path that also embeds a version hash (e.g. `~/.local/share/pnpm/store/v11/links/@/node/26.4.0/<hash>/node_modules/node/bin/node`). A systemd unit doesn't source the user's shell `PATH`, so `/usr/bin/node` never resolved, and even resolving the real path at install time would leave a boot-critical unit pointed at a path that can shift whenever pnpm updates its managed Node.

This spec replaces the custom `vm/dns-stub.js` + `dns-stub.service` with `dnsmasq`, an apt package purpose-built for exactly this ("answer every query with a fixed address"), removing the Node dependency — and the path fragility that comes with it — from this piece entirely.

## Non-goals

- Everything the prior spec already scoped as non-goals still applies (still a placeholder-only responder; Envoy still re-resolves real hostnames; the pre-existing systemd-resolved-forwarding-race is still out of scope).
- No change to iptables DNAT rules, Envoy, or the netplan DNS override target (still `127.0.0.1`).
- No change to pnpm/Node usage elsewhere in `vm/` — only this one systemd-managed piece is affected.

## Architecture

Same position in the pipeline as before (systemd-resolved forwards to `127.0.0.1:53`), but the listener there is now dnsmasq instead of a custom Node script:

```
systemd-resolved (unchanged, forwards to 127.0.0.1 per netplan override)
        │
        ▼
dnsmasq.service (apt package, enabled by vm-setup-persistence.sh)
    - config drop-in: /etc/dnsmasq.d/sandbox-stub.conf
    - listen-address=127.0.0.1, bind-interfaces  (loopback only, same footprint as before)
    - no-resolv, no-hosts                        (never forwards or consults /etc/hosts)
    - address=/#/203.0.113.1                     (every hostname -> placeholder IP)
    - no dhcp-range configured                    (DHCP server code path never activates)
```

`vm/dns-stub.js` and `vm/dns-stub.service` are deleted. `vm-setup-persistence.sh` installs `dnsmasq` via apt, writes the drop-in config, and does `systemctl enable --now dnsmasq` instead of managing a custom unit.

### Why dnsmasq over fixing the Node path

Resolving `node`'s real path at install time (e.g. `command -v node`) and baking it into the unit was considered, but it only patches the symptom: the resolved path still lives under the user's pnpm store and still shifts when pnpm updates its managed Node version, silently breaking DNS resolution in the VM on some future boot. dnsmasq has no dependency on the user's toolchain at all, is already the standard tool for exactly this static-answer use case, and drops a bespoke ~90-line script and unit file in favor of a few lines of declarative config.

### netplan permissions

Unrelated to the Node/dnsmasq issue but found in the same VM run: `vm-setup-persistence.sh` copies `60-dns-override.yaml` into `/etc/netplan/` without restricting permissions, which triggers netplan's "Permissions for ... are too open" warning (netplan expects config files not to be world-readable). Fix: `chmod 600` the file immediately after the copy.

## Components / Deliverables

- `vm/dns-stub.js` — deleted.
- `vm/dns-stub.service` — deleted.
- `vm/dnsmasq-stub.conf` — new, installed to `/etc/dnsmasq.d/sandbox-stub.conf` by `vm-setup-persistence.sh`.
- `vm/vm-setup-persistence.sh` — updated:
  - `sudo apt-get install -y dnsmasq`
  - copy `dnsmasq-stub.conf` into `/etc/dnsmasq.d/`
  - `chmod 600` the copied `60-dns-override.yaml`
  - `systemctl enable --now dnsmasq` in place of `systemctl enable --now dns-stub.service`
- `envoy-proxy.md` / `vm-setup.md` — no changes expected (they only reference `vm-setup-persistence.sh` by name, not the internal Node/dnsmasq mechanism); confirm during implementation.

## Testing / Verification Plan

**Manual (requires the actual Ubuntu VM):**

- Re-run `vm-setup-persistence.sh <host-ip>` on the affected VM (or a fresh one). Confirm no netplan permissions warning, and `systemctl status dnsmasq` shows active/running (not crash-looping).
- `ls -la /etc/netplan/60-dns-override.yaml` shows `600` permissions.
- A DNS lookup for any hostname from inside the VM resolves to the placeholder IP (`getent hosts example.com`, or `dig`/`resolvectl query` if available).
- `curl` to an allow-listed domain (e.g. `http://archive.ubuntu.com`, `https://api.anthropic.com`) succeeds; a non-allow-listed domain fails/resets — same checks as the parent design, now unblocked.
- Reboot the VM. Without re-running any script by hand, confirm `dnsmasq.service` and `iptables-rules@<host-ip>.service` are both active again and the same `curl` checks still pass.

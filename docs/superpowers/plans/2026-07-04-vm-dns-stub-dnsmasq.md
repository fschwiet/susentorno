# VM DNS Stub — Replace Node with dnsmasq Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `dns-stub.service` crash-looping on the real VM (`ExecStart=/usr/bin/node ...` — no system-wide Node exists; it's only available via pnpm's per-user, version-hashed path) by replacing the custom Node script + systemd unit with `dnsmasq`, an apt package that already does exactly what's needed. Also fix the "permissions too open" netplan warning found in the same VM run.

**Architecture:** `vm/dns-stub.js` and `vm/dns-stub.service` are deleted. A new `vm/dnsmasq-stub.conf` drop-in configures the packaged `dnsmasq` service to bind only `127.0.0.1:53` and answer every hostname with the same placeholder IP as before, without forwarding anywhere. `vm/vm-setup-persistence.sh` installs the `dnsmasq` package, installs the drop-in, `chmod 600`s the netplan override it already installs, and enables `dnsmasq` (the stock unit) instead of the deleted custom unit. The iptables template unit and netplan override are unchanged.

**Tech Stack:** Bash, apt, dnsmasq, systemd (stock `dnsmasq.service`, existing `iptables-rules@.service` template).

**Design doc:** `docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md`

## Global Constraints

- `vm/dns-stub.js` and `vm/dns-stub.service` are deleted — dnsmasq replaces both entirely, no custom code or unit remains.
- dnsmasq must bind **only** `127.0.0.1:53` (`listen-address=127.0.0.1`, `bind-interfaces`) — same footprint as the old stub, so it can't conflict with systemd-resolved's own stub listener on `127.0.0.53`.
- dnsmasq must never forward or consult `/etc/hosts` (`no-resolv`, `no-hosts`) and must answer **every** hostname with the placeholder IP (`address=/#/203.0.113.1`, matching the old script's default) — no DHCP config, so its DHCP server code path never activates.
- `vm/iptables-rules@.service`, `vm/60-dns-override.yaml`, and `vm/vm-setup-iptables.sh` are unchanged — out of scope for this fix.
- `vm/vm-setup-persistence.sh` installs the `dnsmasq` apt package *before* re-applying the netplan override, since installing it requires working DNS resolution (the netplan override, once applied, breaks resolution until dnsmasq is up).
- The netplan file it installs must end up `600` (owner read/write only) to silence netplan's permissions warning.
- None of this can be exercised end-to-end outside the real Ubuntu VM — each task below verifies what it can locally (syntax checks); a final manual checklist covers the rest.

---

### Task 1: `vm/dnsmasq-stub.conf`

**Files:**
- Create: `vm/dnsmasq-stub.conf`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a dnsmasq config drop-in installed by Task 2 to `/etc/dnsmasq.d/sandbox-stub.conf`.

- [ ] **Step 1: Create `vm/dnsmasq-stub.conf`**

```
# Sandbox VM DNS stub: answers every hostname with a fixed placeholder IP.
# See docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md
#
# The actual destination IP is irrelevant: the VM's iptables DNAT rules
# redirect tcp/80 and tcp/443 to Envoy by port only, and Envoy re-resolves
# the real hostname itself before connecting upstream. This just needs to
# let the querying process's DNS lookup succeed so it proceeds to attempt
# the (redirected) connection at all.
port=53
listen-address=127.0.0.1
bind-interfaces
no-resolv
no-hosts
address=/#/203.0.113.1
```

- [ ] **Step 2: Structural review (no dnsmasq available on this dev machine)**

Confirm every non-comment, non-blank line is a bare `key` or `key=value` pair (dnsmasq's config syntax), there are no tabs, and `listen-address` is exactly `127.0.0.1` (not `0.0.0.0` or a wildcard — binding wider would be a behavior change from the old stub). Full validation (`dnsmasq --test`, confirming it actually loads this file via `conf-dir`) happens on the VM in Task 3.

- [ ] **Step 3: Commit**

```bash
git add vm/dnsmasq-stub.conf
git commit -m "Add dnsmasq config drop-in for the VM DNS stub"
```

---

### Task 2: Replace the Node stub with dnsmasq in `vm-setup-persistence.sh`

**Files:**
- Delete: `vm/dns-stub.js`
- Delete: `vm/dns-stub.service`
- Modify: `vm/vm-setup-persistence.sh`

**Interfaces:**
- Consumes: `vm/dnsmasq-stub.conf` (Task 1); `vm/iptables-rules@.service` and `vm/60-dns-override.yaml` (existing, unmodified).
- Produces: the fully-configured VM-side script — same invocation contract as before, `sudo bash vm/vm-setup-persistence.sh <host-ip>`.

- [ ] **Step 1: Delete the superseded Node stub and its unit**

```bash
git rm vm/dns-stub.js vm/dns-stub.service
```

- [ ] **Step 2: Replace `vm/vm-setup-persistence.sh`**

Replace the full file content with:

```bash
#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: vm-setup-persistence.sh <host-ip>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

apt-get install -y dnsmasq

cp "${script_dir}/dnsmasq-stub.conf" /etc/dnsmasq.d/sandbox-stub.conf

sed "s|@@VM_DIR@@|${script_dir}|g" "${script_dir}/iptables-rules@.service" > "/etc/systemd/system/iptables-rules@.service"

cp "${script_dir}/60-dns-override.yaml" /etc/netplan/60-dns-override.yaml
chmod 600 /etc/netplan/60-dns-override.yaml
netplan apply

systemctl daemon-reload
systemctl enable --now dnsmasq
systemctl enable --now "iptables-rules@${host_ip}.service"

echo "vm-setup-persistence: dnsmasq and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
```

`apt-get install -y dnsmasq` runs *before* the netplan override is applied, deliberately: once the override takes effect, DNS resolution depends on dnsmasq already being installed and running, so installing it any later would deadlock. This assumes it is invoked with `sudo` already (matching the rest of this script and `vm-trust-ca.sh`/`vm-setup-iptables.sh`'s existing convention), so it doesn't prefix its own commands with `sudo`.

- [ ] **Step 3: Syntax-check it**

Run: `bash -n vm/vm-setup-persistence.sh`
Expected: no output, exit code 0.

- [ ] **Step 4: Confirm no documentation changes are needed**

Run: `grep -rn "dns-stub" envoy-proxy.md vm-setup.md`
Expected: no matches — both docs only reference `vm-setup-persistence.sh` by name, never the internal Node/dnsmasq mechanism, so neither needs editing for this change.

- [ ] **Step 5: Commit**

```bash
git add vm/vm-setup-persistence.sh
git commit -m "Replace Node DNS stub with dnsmasq in vm-setup-persistence.sh"
```

---

### Task 3: Manual VM verification

**Files:** none (verification only).

**Interfaces:** none.

This task can only be carried out on the real Ubuntu VM, using a copy of the `vm/` folder that includes Tasks 1–2's changes. Not automatable from this repo's dev environment.

- [ ] **Step 1: If the target VM's DNS is already broken (as in the case that motivated this fix), temporarily restore resolution first**

The previous, broken run of `vm-setup-persistence.sh` already pointed the VM's resolver at `127.0.0.1` via the netplan override, so `apt-get install -y dnsmasq` in Step 2 below would otherwise fail to resolve `archive.ubuntu.com`. Work around this once, in the VM:

```bash
sudo resolvectl dns ens33 1.1.1.1
```

(In-memory only — overwritten the moment the script below re-applies the netplan override, once dnsmasq is up.)

- [ ] **Step 2: Copy the updated `vm/` folder to the VM and re-run setup**

```bash
sudo bash vm/vm-setup-persistence.sh <host-ip>
```

using the `<host-ip>` from `envoy-proxy.md` host-side step 7 (e.g. `192.168.241.1`).

- [ ] **Step 3: Confirm dnsmasq is active and not crash-looping**

Run inside the VM: `systemctl status dnsmasq iptables-rules@<host-ip>.service`
Expected: both show `active (running)` / `active (exited)` respectively — no `203/EXEC`, no restart-loop.

- [ ] **Step 4: Confirm the netplan permissions warning is gone**

Run inside the VM: `ls -la /etc/netplan/60-dns-override.yaml`
Expected: permissions `-rw-------` (600). Re-running `netplan apply` should produce no "Permissions ... too open" warning.

- [ ] **Step 5: Confirm DNS answers and connectivity work**

Run inside the VM:
- `getent hosts example.com` — expect the placeholder IP (`203.0.113.1`).
- `curl http://archive.ubuntu.com` and `curl --cacert <path-to-cert.pem> https://api.anthropic.com` — expect success (not `curl: (28) Resolving timed out`).
- `apt-get update` — expect success.

- [ ] **Step 6: Confirm boot persistence**

Reboot the VM. Without re-running any script or the Step 1 workaround by hand, repeat Steps 3–5 and confirm they still pass.

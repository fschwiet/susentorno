# VM DNS Netplan Merge + iptables Unit Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the VM's broken outbound connectivity by making the DNS override merge into the active NetworkManager profile and by inlining the iptables DNAT rules into their systemd unit so they no longer depend on a shared-folder path.

**Architecture:** Two independent fixes in the `vm/` folder. (1) `60-dns-override.yaml` becomes a template whose top-level netplan id is the real interface name (discovered at runtime by `vm-setup-persistence.sh`), so netplan merges the `nameservers` into the installer's existing profile instead of spawning a competing one. (2) `iptables-rules@.service` invokes `iptables` directly via two `ExecStart` lines instead of shelling out to a script under `/mnt/hgfs`, and `vm-setup-iptables.sh` is deleted.

**Tech Stack:** Bash, netplan (NetworkManager renderer), systemd units, iptables, dnsmasq (unchanged). Design spec: `docs/superpowers/specs/2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md`.

## Global Constraints

- The `vm/` folder is copied from a Windows host that does not track the POSIX executable bit — units and scripts are invoked via an explicit interpreter (`bash`, or systemd's own `ExecStart`), never by executing the file directly. Do not rely on `chmod +x`.
- Templated placeholders in `vm/` files use the `@@NAME@@` convention, substituted by `sed` in `vm-setup-persistence.sh`.
- No changes to dnsmasq, `dnsmasq-stub.conf`, the placeholder IP (`203.0.113.1`), or Envoy.
- End-to-end verification is manual on a fresh Ubuntu VM (see the spec's Testing / Verification Plan). Host-side steps below only sanity-check file content and substitution; they are not a substitute for the VM run.

## File Structure

- `vm/60-dns-override.yaml` — netplan drop-in template; top-level id is `@@IFACE@@`, no `match:` block.
- `vm/iptables-rules@.service` — systemd template unit; DNAT rules inlined as two `ExecStart` lines, no external script reference.
- `vm/vm-setup-persistence.sh` — orchestration; discovers the interface, substitutes `@@IFACE@@` into the netplan file, plain-copies the unit file, deletes the old `@@VM_DIR@@` substitution.
- `vm/vm-setup-iptables.sh` — **deleted**; its two commands now live in the unit.

---

### Task 1: DNS override merges into the active NetworkManager profile

**Files:**
- Modify: `vm/60-dns-override.yaml` (full rewrite)
- Modify: `vm/vm-setup-persistence.sh` (netplan copy → discover-and-substitute)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the netplan file `/etc/netplan/60-dns-override.yaml` on the VM whose ethernet id equals the interface name, merging `nameservers.addresses: [127.0.0.1]` into the installer's profile for that interface.

- [ ] **Step 1: Rewrite `vm/60-dns-override.yaml` as a templated drop-in**

Replace the entire file contents with:

```yaml
network:
  version: 2
  ethernets:
    @@IFACE@@:
      nameservers:
        addresses: [127.0.0.1]
```

Note: the top-level id is `@@IFACE@@` and there is **no** `match:` block — when the id equals the interface name netplan binds by name, and sharing the installer's id (e.g. `ens33`) is exactly what makes netplan merge rather than create a competing `dns-override` profile.

- [ ] **Step 2: Verify the substitution produces valid, correctly-keyed YAML**

Run (from repo root, Git Bash):

```bash
sed 's|@@IFACE@@|ens33|g' vm/60-dns-override.yaml
```

Expected output — the id is now `ens33`, no `@@IFACE@@` remains, no `match:` block:

```yaml
network:
  version: 2
  ethernets:
    ens33:
      nameservers:
        addresses: [127.0.0.1]
```

- [ ] **Step 3: Update `vm-setup-persistence.sh` to discover the interface and substitute it**

In `vm/vm-setup-persistence.sh`, replace this line:

```bash
cp "${script_dir}/60-dns-override.yaml" /etc/netplan/60-dns-override.yaml
```

with:

```bash
iface="$(ip -o -4 route show default | awk '{print $5}' | head -n1)"
sed "s|@@IFACE@@|${iface}|g" "${script_dir}/60-dns-override.yaml" > /etc/netplan/60-dns-override.yaml
```

(The following `chmod 600 /etc/netplan/60-dns-override.yaml` line stays unchanged, immediately after.)

- [ ] **Step 4: Verify the script no longer plain-copies the template and discovers the interface**

Run:

```bash
grep -nE 'iface=|@@IFACE@@|60-dns-override' vm/vm-setup-persistence.sh
```

Expected: an `iface="$(ip -o -4 route show default ...)"` line, a `sed "s|@@IFACE@@|${iface}|g" ... > /etc/netplan/60-dns-override.yaml` line, and the `chmod 600 /etc/netplan/60-dns-override.yaml` line. There must be **no** `cp ... 60-dns-override.yaml` line remaining.

- [ ] **Step 5: Commit**

```bash
git add vm/60-dns-override.yaml vm/vm-setup-persistence.sh
git commit -m "Merge VM DNS override into the active netplan profile by interface id"
```

---

### Task 2: Inline the iptables DNAT rules into the systemd unit

**Files:**
- Modify: `vm/iptables-rules@.service` (full rewrite)
- Modify: `vm/vm-setup-persistence.sh` (`@@VM_DIR@@` substitution → plain copy)
- Delete: `vm/vm-setup-iptables.sh`

**Interfaces:**
- Consumes: the host IP via the systemd template instance name (`%i`), already supplied by `systemctl enable --now "iptables-rules@${host_ip}.service"` in `vm-setup-persistence.sh` (unchanged).
- Produces: `iptables-rules@<host-ip>.service` that installs the two DNAT rules (tcp/443 and tcp/80 → `<host-ip>`) with no dependency on any file under `/mnt/hgfs`.

- [ ] **Step 1: Rewrite `vm/iptables-rules@.service` with inline rules**

Replace the entire file contents with:

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

- [ ] **Step 2: Verify the unit has no external-script or `@@VM_DIR@@` reference**

Run:

```bash
grep -nE '@@VM_DIR@@|vm-setup-iptables|ExecStart' vm/iptables-rules@.service
```

Expected: exactly two `ExecStart=/usr/sbin/iptables ...` lines (dport 443 then dport 80), and **no** match for `@@VM_DIR@@` or `vm-setup-iptables`.

- [ ] **Step 3: Update `vm-setup-persistence.sh` to plain-copy the unit file**

In `vm/vm-setup-persistence.sh`, replace this line:

```bash
sed "s|@@VM_DIR@@|${script_dir}|g" "${script_dir}/iptables-rules@.service" > "/etc/systemd/system/iptables-rules@.service"
```

with:

```bash
cp "${script_dir}/iptables-rules@.service" /etc/systemd/system/iptables-rules@.service
```

- [ ] **Step 4: Delete the now-unused script**

```bash
git rm vm/vm-setup-iptables.sh
```

- [ ] **Step 5: Verify nothing still references the deleted script or `@@VM_DIR@@`**

Run:

```bash
grep -rnE 'vm-setup-iptables|@@VM_DIR@@' vm/ docs/ *.md
```

Expected: **no matches** (the script is gone, the unit is inlined, and per the spec `vm-setup.md` / `envoy-proxy.md` reference only `vm-setup-persistence.sh` by name). If any doc match appears, update that reference so it no longer points at `vm-setup-iptables.sh`.

- [ ] **Step 6: Commit**

```bash
git add vm/iptables-rules@.service vm/vm-setup-persistence.sh
git commit -m "Inline iptables DNAT rules into the systemd unit, drop vm-setup-iptables.sh"
```

---

### Task 3: End-to-end verification on a fresh VM

**Files:** none (manual verification, per the spec's Testing / Verification Plan).

**Interfaces:**
- Consumes: the finished `vm/` folder from Tasks 1–2, copied into a fresh Ubuntu VM.

This task is not automatable on the host — it requires building a new VM and running the VM-side setup from `vm-setup.md` / `envoy-proxy.md`. Perform each check and confirm the expected result before considering the work done.

- [ ] **Step 1: Run persistence setup on a fresh VM**

Inside the VM: `sudo bash vm/vm-setup-persistence.sh <host-ip>`.
Expected: no netplan permissions warning; `systemctl status dnsmasq` is active/running.

- [ ] **Step 2: Confirm the DNS override took effect (Issue 1)**

Run `resolvectl status`.
Expected: the active interface shows **`127.0.0.1`** as `Current DNS Server` — not the DHCP gateway.

Run `sudo netplan get`.
Expected: `nameservers.addresses: [127.0.0.1]` appears under the *same* ethernet id as the installer config (e.g. `ens33`); there is **no** separate `dns-override` block.

- [ ] **Step 3: Confirm name resolution works**

Run `nslookup cnn.com` (and one other hostname).
Expected: resolves to `203.0.113.1` via the normal resolver path, with no timeout.

- [ ] **Step 4: Confirm the iptables rules are installed (Issue 2)**

Run `systemctl status iptables-rules@<host-ip>.service`.
Expected: active (exited), not failed.

Run `sudo iptables -t nat -L OUTPUT -n`.
Expected: two DNAT rules to `<host-ip>` — dport 443 and dport 80.

- [ ] **Step 5: Confirm real traffic flows**

Expected: `curl` to an allow-listed domain succeeds; a non-allow-listed domain fails/resets; `apt-get update` succeeds.

- [ ] **Step 6: Reboot and re-verify persistence**

Reboot the VM. Without re-running any script by hand:
Expected: `resolvectl status` still shows `127.0.0.1`; both `dnsmasq.service` and `iptables-rules@<host-ip>.service` are active; the DNAT rules are present; the `nslookup`/`curl` checks still pass.

---

## Self-Review

**Spec coverage:**
- Issue 1 (netplan id merge, runtime interface discovery, `chmod 600` retained) → Task 1. ✓
- Issue 2 (inline DNAT rules, drop `@@VM_DIR@@`, delete `vm-setup-iptables.sh`) → Task 2. ✓
- Spec "confirm `vm-setup.md`/`envoy-proxy.md` need no change" → Task 2 Step 5 grep. ✓
- Spec Testing / Verification Plan (fresh VM, `resolvectl`, `netplan get`, `nslookup`, iptables listing, curl/apt, reboot) → Task 3. ✓
- Non-goal "no cleanup tooling for already-broken VMs" → honored; Task 3 uses a fresh VM. ✓

**Placeholder scan:** No TBD/TODO/"handle appropriately". `@@IFACE@@`/`@@VM_DIR@@`/`<host-ip>` are intentional template tokens shown with their concrete substitutions. ✓

**Type consistency:** The netplan template token is `@@IFACE@@` in both the file (Task 1 Step 1) and the `sed` substitution (Task 1 Step 3). The unit's two `ExecStart` lines referenced in Task 2 Steps 1, 2 match. The `iptables-rules@<host-ip>.service` instance name is consistent across Task 2 and Task 3. ✓

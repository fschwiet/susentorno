# VM Host-Only Default Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DNS placeholder IP routable in host-only mode so the VM's `OUTPUT` DNAT to Envoy fires, by adding a guarded default route via the host to the boot-time rules unit.

**Architecture:** In host-only mode VMware's DHCP hands out no gateway, so there is no default route and the placeholder `203.0.113.1` is unroutable — the kernel's route lookup on the original destination fails with `ENETUNREACH` before the `OUTPUT` nat chain (and its DNAT) runs. The existing `vm/iptables-rules@.service` boot unit gains a third `ExecStart` that installs `default via <host-ip>` **only when no default route already exists** (a no-op in NAT/bridged, so setup — which runs on NAT — is unaffected), plus a `network-online.target` ordering change so the interface is up when the route is added.

**Tech Stack:** systemd template unit, iproute2 (`ip`), POSIX `sh`, Markdown docs.

**Design spec:** `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md`

## Global Constraints

- Placeholder IP stays `203.0.113.1` — do not change the DNS stub (isolation relies on it being non-routable TEST-NET-3 space). One line each, verbatim from spec.
- Host IP arrives only via the systemd template instance name (`%i`); no new `sed`/`__NAME__` placeholders are introduced.
- Keep the unit filename `vm/iptables-rules@.service` (renaming would orphan the operator's already-enabled `iptables-rules@<host-ip>.service` instance).
- `ExecStart` names the interpreter explicitly (`/bin/sh`, `/usr/sbin/ip`) — the `vm/` folder is copied from Windows and carries no POSIX exec bit, so nothing is executed directly.
- Behavioral verification is manual on a real Ubuntu VM (there is no automated harness for VM networking); host-side checks are limited to static validation of the unit file and the guard shell snippet.

---

### Task 1: Add guarded default route + network-online ordering to the rules unit

**Files:**
- Modify: `vm/iptables-rules@.service` (currently 12 lines; see below)
- Verify-only (no edit expected): `vm/vm-setup-persistence.sh:12` (the `cp` of the unit file) and `vm/vm-setup-persistence.sh:21` (`systemctl enable --now`)

**Interfaces:**
- Consumes: the systemd template instance `%i` = the host IP (e.g. `192.168.241.1`), already supplied by `systemctl enable --now "iptables-rules@${host_ip}.service"` in `vm-setup-persistence.sh` (unchanged).
- Produces: a boot unit that, on every boot, applies the two DNAT rules and — only when no IPv4 default route exists — installs `default via <host-ip>`.

Current file content (`vm/iptables-rules@.service`):

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

- [ ] **Step 1: Write the failing acceptance check**

Run this against the *current* file to confirm the check is meaningful (it should FAIL before the edit):

```bash
grep -q 'ip route replace default via %i' vm/iptables-rules@.service \
  && grep -q '^Wants=network-online.target$' vm/iptables-rules@.service \
  && grep -q '^After=network-online.target$' vm/iptables-rules@.service \
  && ! grep -q 'local-fs.target' vm/iptables-rules@.service \
  && echo "unit OK"
```

Expected: **no `unit OK` output** (the route `ExecStart` is absent and `After=local-fs.target` is still present).

- [ ] **Step 2: Confirm the guard shell snippet is valid POSIX shell**

The guard runs under `/bin/sh -c`. Syntax-check it (with `%i` stood in as a literal IP; `sh -n` checks syntax without executing):

```bash
sh -n -c '/usr/sbin/ip -4 route show default | /usr/bin/grep -q . || /usr/sbin/ip route replace default via 192.168.241.1' && echo "guard syntax OK"
```

Expected: `guard syntax OK`.

- [ ] **Step 3: Rewrite the unit file**

Replace the entire contents of `vm/iptables-rules@.service` with:

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

Notes for the implementer:
- The guard `... show default | grep -q . || ip route replace ...` means: if a default route already exists (NAT/bridged), do nothing; otherwise (host-only) install one via the host. This is what keeps `systemctl enable --now` from failing during setup, which runs while the VM is still on NAT.
- `%i` is expanded by systemd (to the host IP) even though it sits inside the single-quoted `sh -c` string — systemd specifier expansion is independent of shell quoting, exactly as with the two DNAT lines above it.
- Do not add `dev <iface>`: the on-link host gateway lets the kernel pick the interface, keeping the unit interface-agnostic.

- [ ] **Step 4: Run the acceptance check to verify it passes**

```bash
grep -q 'ip route replace default via %i' vm/iptables-rules@.service \
  && grep -q '^Wants=network-online.target$' vm/iptables-rules@.service \
  && grep -q '^After=network-online.target$' vm/iptables-rules@.service \
  && ! grep -q 'local-fs.target' vm/iptables-rules@.service \
  && echo "unit OK"
```

Expected: `unit OK`.

- [ ] **Step 5: Confirm `vm-setup-persistence.sh` needs no change**

The script must still simply copy the unit and enable the instance — it does not reference the unit's internals, so no edit is expected. Confirm:

```bash
grep -n 'iptables-rules@.service' vm/vm-setup-persistence.sh
```

Expected: two lines — the `cp ... /etc/systemd/system/iptables-rules@.service` (around line 12) and the `systemctl enable --now "iptables-rules@${host_ip}.service"` (around line 21). If both are present and unchanged, make no edit to the script.

- [ ] **Step 6: Commit**

```bash
git add vm/iptables-rules@.service
git commit -m "Add guarded host-only default route to sandbox rules unit"
```

---

### Task 2: Document the reboot-after-host-only step

**Files:**
- Modify: `envoy-proxy.md` (VM-side setup, step 5)
- Modify: `vm-setup.md` (final step, step 7)

**Interfaces:**
- Consumes: the unit behavior from Task 1 (route installed on boot, not on live mode-switch).
- Produces: setup instructions that tell the operator to reboot so the route is installed.

- [ ] **Step 1: Update `envoy-proxy.md`**

Replace this line (VM-side setup, step 5):

```
5. Switch the virtual machine's network to host-only
```

with:

```
5. Switch the virtual machine's network to host-only, then **reboot the VM** so the boot-time rules unit installs the host-only default route (host-only mode has no DHCP gateway; see `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md`). A live mode-switch alone does not re-run the unit; `sudo systemctl restart iptables-rules@<host-ip>.service` is an alternative to a reboot.
```

- [ ] **Step 2: Update `vm-setup.md`**

Replace this line (final numbered step):

```
7. Change network connection from NAT to host-only
```

with:

```
7. Change network connection from NAT to host-only, then **reboot the VM** so the boot-time sandbox rules unit installs the host-only default route (see [envoy-proxy](envoy-proxy.md) and `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md`).
```

- [ ] **Step 3: Verify both edits landed**

```bash
grep -n 'reboot the VM' envoy-proxy.md vm-setup.md
```

Expected: one match in each file.

- [ ] **Step 4: Commit**

```bash
git add envoy-proxy.md vm-setup.md
git commit -m "Doc: reboot after switching VM to host-only"
```

---

### Task 3: Manual verification on the VM (acceptance)

**Files:** none — this task is run by the operator on a real Ubuntu VM. It is the behavioral acceptance gate that the static checks in Tasks 1–2 cannot cover.

**Interfaces:**
- Consumes: the updated unit (Task 1) and docs (Task 2), copied into the VM via the shared `vm/` folder.

- [ ] **Step 1: Re-apply on NAT and confirm setup still succeeds**

While the VM is on NAT: `sudo bash vm/vm-setup-persistence.sh <host-ip>`.
Expected: completes with no error; `systemctl status iptables-rules@<host-ip>.service` is `active (exited)`. (The route `ExecStart` is a no-op here because a NAT default route already exists — this proves the guard protects setup.)

- [ ] **Step 2: Switch to host-only and reboot**

Switch the VM's network to host-only, then reboot.

- [ ] **Step 3: Confirm the default route is installed**

```bash
ip -4 route show default
ip route get 203.0.113.1
```

Expected: a `default via <host-ip>` line on the host-only interface; `ip route get 203.0.113.1` resolves via `<host-ip>` (no longer `Network is unreachable`).

- [ ] **Step 4: Confirm rules, DNS, and connectivity**

```bash
sudo iptables -t nat -L OUTPUT -n
resolvectl status
curl -sSI https://api.anthropic.com | head -n1     # allow-listed: succeeds
apt-get update                                       # port 80 path: succeeds
```

Expected: two DNAT rules to `<host-ip>`; `127.0.0.1` shown as the DNS server; the allow-listed `curl` and `apt-get update` succeed. A non-allow-listed domain should fail/reset.

- [ ] **Step 5: Confirm isolation was not widened**

```bash
nc -vz 203.0.113.1 22
```

Expected: **fails** (connection refused/timeout) — a non-80/443 port to the placeholder is routed to the host but dropped, confirming only Envoy's 80/443 path is reachable.

- [ ] **Step 6: Reboot again and re-confirm persistence**

Reboot with no manual steps; re-run Steps 3–4 and confirm the route, DNAT rules, and `curl`/`apt-get` checks all still pass.

---

## Self-Review

**Spec coverage:**
- Guarded default route in the boot unit → Task 1. ✓
- `network-online.target` ordering change → Task 1 (Steps 3–4 check `After`/`Wants` and absence of `local-fs.target`). ✓
- No-op-in-NAT guard so `enable --now` setup succeeds → Task 1 Step 3 note + Task 3 Step 1. ✓
- Keep unit filename; only `Description` broadens → Task 1 Step 3. ✓
- `vm-setup-persistence.sh` unchanged (confirm) → Task 1 Step 5. ✓
- Reboot-after-host-only doc updates to `envoy-proxy.md` and `vm-setup.md` → Task 2. ✓
- Security/isolation: non-80/443 to placeholder dropped → Task 3 Step 5. ✓
- Full manual verification plan → Task 3. ✓

**Placeholder scan:** No `TBD`/`TODO`/vague steps; every code/edit step shows exact content and exact commands with expected output.

**Type/string consistency:** The route string `ip route replace default via %i`, `After=network-online.target`, `Wants=network-online.target`, and the `local-fs.target` removal are asserted identically in Task 1 Steps 1, 3, and 4. The unit filename `iptables-rules@.service` is used consistently across Tasks 1 and 3. The reboot marker string `reboot the VM` in Task 2 Step 3's grep matches the text inserted in Steps 1–2.

# Rerun-safe egress unit (`configamatron-egress.service`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `07-setup-persistence.sh` obviously safe to re-run by renaming the DNAT/route systemd unit from the IP-templated `iptables-rules@.service` to a fixed, owner-distinct `configamatron-egress.service`, baking the host IP into the rules via a `sed` placeholder.

**Architecture:** The unit becomes a plain (non-`@`) systemd unit whose three `ExecStart` lines carry a `__HOST_IP__` placeholder. `07` substitutes the real IP with `sed | sudo tee` when installing it (mirroring the existing `60-dns-override.yaml` / `__IFACE__` pattern), then `enable`s and `restart`s it. Because the filename is fixed, a rerun overwrites one file and restarts one unit — there is never a second instance to enumerate or clean up. All other references to the old name (a verify script, VM/unit tests, a diagnostics harness, two docs) are updated mechanically.

**Tech Stack:** Bash, systemd, iptables, netplan; TypeScript + Vitest (unit tests); prettier (`prettier-plugin-sh` formats `.sh` files, checked by `pnpm format:check`).

## Global Constraints

- New unit name, used verbatim everywhere: `configamatron-egress.service`.
- Placeholder token in the unit template, matching the repo's sed convention: `__HOST_IP__`.
- Installed unit path in the VM: `/etc/systemd/system/configamatron-egress.service`.
- Env-file path for the host IP: **none** — the IP is `sed`'d directly into the rules; do not introduce an `EnvironmentFile`.
- No legacy-instance sweep: do not add code to disable stray `iptables-rules@*` units. Migration = re-provision such VMs.
- Historical specs/plans under `docs/superpowers/specs/` and `docs/superpowers/plans/` that mention `iptables-rules@.service` are left untouched.
- Shell edits must pass `pnpm format:check` (prettier) and unit tests must pass `pnpm test:unit`.

---

### Task 1: Rename and de-template the unit; update the shipped-file test lists

Renames the template file, swaps `%i` → `__HOST_IP__`, and updates the two unit tests that assert the file ships. The unit tests are the fast gate here.

**Files:**
- Rename: `templates/vm-shared/iptables-rules@.service` → `templates/vm-shared/configamatron-egress.service`
- Modify: `templates/vm-shared/configamatron-egress.service` (description + three `ExecStart` lines)
- Modify (test): `tests/unit/templates.test.ts:17`
- Modify (test): `tests/unit/initEnv.test.ts:41`

**Interfaces:**
- Produces: a shipped template file at `vm-shared/configamatron-egress.service` containing a `__HOST_IP__` placeholder in each of its three `ExecStart` lines. Task 2 consumes this filename and placeholder.

- [ ] **Step 1: Update both test file-lists to expect the new name (failing test first)**

In `tests/unit/templates.test.ts`, change line 17 from:

```ts
  'vm-shared/iptables-rules@.service',
```

to:

```ts
  'vm-shared/configamatron-egress.service',
```

In `tests/unit/initEnv.test.ts`, change line 41 from:

```ts
      'vm-shared/iptables-rules@.service',
```

to:

```ts
      'vm-shared/configamatron-egress.service',
```

- [ ] **Step 2: Run the unit tests to verify they now fail**

Run: `pnpm test:unit`
Expected: FAIL — `templates > ships every template file` and the `initEnvironment` copy test fail their `existsSync` assertion for `vm-shared/configamatron-egress.service` (the file still has the old name).

- [ ] **Step 3: Rename the file**

Run: `git mv "templates/vm-shared/iptables-rules@.service" templates/vm-shared/configamatron-egress.service`

- [ ] **Step 4: Replace the three `%i` references with `__HOST_IP__` and update the description**

Replace the entire contents of `templates/vm-shared/configamatron-egress.service` with:

```ini
[Unit]
Description=Configamatron egress: DNAT 80/443 to host proxy + host-only default route (host IP: __HOST_IP__)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination __HOST_IP__:443
ExecStart=/usr/sbin/iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination __HOST_IP__:80
ExecStart=/bin/sh -c '/usr/sbin/ip -4 route show default | /usr/bin/grep -q . || /usr/sbin/ip route replace default via __HOST_IP__'

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS — both file-list tests find `vm-shared/configamatron-egress.service`.

- [ ] **Step 6: Confirm no stray old-name reference remains in shipped templates or unit tests**

Run: `git grep -n 'iptables-rules@' -- templates tests/unit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add templates/vm-shared/configamatron-egress.service tests/unit/templates.test.ts tests/unit/initEnv.test.ts
git commit -m "refactor(vm): rename iptables-rules@.service -> configamatron-egress.service

Fixed, owner-distinct unit name with the host IP as a __HOST_IP__ sed
placeholder in the rules instead of the %i instance name."
```

---

### Task 2: Install the unit via `sed | tee` and `enable` + `restart` in `07-setup-persistence.sh`

Swaps the plain `cp` for a `sed` substitution (baking the IP in), replaces `enable --now "iptables-rules@${host_ip}.service"` with `enable` + `restart` (so a rerun with a changed IP re-applies), updates the closing message, and adds a "safe to re-run" banner. Verified by grep + prettier, since `07` has no dedicated content unit test; the VM e2e (Task 3's `vm.test.ts`) is the behavioral gate.

**Files:**
- Modify: `templates/vm-shared/07-setup-persistence.sh`

**Interfaces:**
- Consumes: `templates/vm-shared/configamatron-egress.service` with the `__HOST_IP__` placeholder (Task 1).
- Produces: `/etc/systemd/system/configamatron-egress.service` on the VM, enabled and started, with `${host_ip}` substituted into the rules.

- [ ] **Step 1: Add the "safe to re-run" banner under the shebang/`set` block**

In `templates/vm-shared/07-setup-persistence.sh`, after line 2 (`set -euo pipefail`) insert a blank line then:

```bash
# Safe to re-run: every step is an idempotent overwrite or a no-op. The egress
# unit has a fixed filename (configamatron-egress.service), so a rerun rewrites
# that one file and restarts one unit -- re-running with a different host IP
# never leaves a second unit behind. (A live IP change leaves the old DNAT rules
# in the table until the next reboot, which clears them.)
```

- [ ] **Step 2: Replace the `cp` of the unit with a `sed | tee` substitution**

Change line 12 from:

```bash
sudo cp "${script_dir}/iptables-rules@.service" /etc/systemd/system/iptables-rules@.service
```

to:

```bash
sed "s|__HOST_IP__|${host_ip}|g" "${script_dir}/configamatron-egress.service" \
  | sudo tee /etc/systemd/system/configamatron-egress.service > /dev/null
```

- [ ] **Step 3: Replace the `enable --now` of the egress unit with `enable` + `restart`**

Change line 39 from:

```bash
sudo systemctl enable --now "iptables-rules@${host_ip}.service"
```

to:

```bash
sudo systemctl enable configamatron-egress.service
sudo systemctl restart configamatron-egress.service
```

(`restart`, not `enable --now`: `enable --now` is a no-op on an already-active `RemainAfterExit` oneshot, so a rerun with a changed IP would not re-run the rules. `restart` always re-runs the `ExecStart` lines with the freshly-substituted IP.)

- [ ] **Step 4: Update the closing `echo` to name the new unit**

Change line 41 from:

```bash
echo "07-setup-persistence: dnsmasq and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
```

to:

```bash
echo "07-setup-persistence: dnsmasq and configamatron-egress.service enabled and started; netplan DNS override applied"
```

- [ ] **Step 5: Verify the script's new shape by grep**

Run:
```bash
grep -q 'sed "s|__HOST_IP__|${host_ip}|g"' templates/vm-shared/07-setup-persistence.sh \
  && grep -q 'systemctl enable configamatron-egress.service' templates/vm-shared/07-setup-persistence.sh \
  && grep -q 'systemctl restart configamatron-egress.service' templates/vm-shared/07-setup-persistence.sh \
  && ! grep -q 'iptables-rules@' templates/vm-shared/07-setup-persistence.sh \
  && echo OK
```
Expected: `OK`.

- [ ] **Step 6: Verify formatting passes (prettier formats `.sh`)**

Run: `pnpm format:check`
Expected: PASS (no formatting complaints about `07-setup-persistence.sh`). If it reports the file, run `pnpm format` and re-check.

- [ ] **Step 7: Commit**

```bash
git add templates/vm-shared/07-setup-persistence.sh
git commit -m "feat(vm): install configamatron-egress.service via sed + enable/restart

Bakes the host IP into the unit's rules with a __HOST_IP__ sed substitution
(matching 60-dns-override.yaml) and uses restart so a rerun with a changed IP
re-applies. Documents that the script is safe to re-run."
```

---

### Task 3: Update the remaining rename references (verify script, VM test, diagnostics harness, docs)

Mechanical rename of every remaining live reference to the old unit name. Grouped because a reviewer would accept or reject them together.

**Files:**
- Modify: `templates/vm-shared/verify-config.sh:170`
- Modify (test): `tests/vm/vm.test.ts:160`
- Modify: `tests/vm/harness/guest.sh:86`
- Modify: `usage.md:85,90`
- Modify: `technical-notes.md:41`

**Interfaces:**
- Consumes: the unit name `configamatron-egress.service` (Task 1).

- [ ] **Step 1: `verify-config.sh` — check the fixed unit name**

Change line 170 from:

```bash
svc="iptables-rules@${host_ip}.service"
```

to:

```bash
svc="configamatron-egress.service"
```

Leave the surrounding `if [ -n "$host_ip" ]; then ... fi` block (lines 171–174) unchanged — the unit exists regardless of IP, but keeping the guard is minimal churn and the active/enabled checks stay valid.

- [ ] **Step 2: `tests/vm/vm.test.ts` — assert the fixed unit name**

Change line 160 from:

```ts
      (await guest('g1', `systemctl is-active iptables-rules@${BRIDGE_IP}.service`)).stdout.trim(),
```

to:

```ts
      (await guest('g1', 'systemctl is-active configamatron-egress.service')).stdout.trim(),
```

- [ ] **Step 3: `tests/vm/harness/guest.sh` — update the journalctl target**

Change line 86 from:

```bash
    gexec "$name" 'sudo journalctl -u dnsmasq -u "iptables-rules@*" --no-pager' > "$out/journal.txt" 2>&1 || true
```

to:

```bash
    gexec "$name" 'sudo journalctl -u dnsmasq -u configamatron-egress.service --no-pager' > "$out/journal.txt" 2>&1 || true
```

- [ ] **Step 4: `usage.md` — rename the service and the restart hint**

Change line 85 — replace `` `iptables-rules@<host-ip>.service` `` with `` `configamatron-egress.service` ``:

```markdown
7. `07-setup-persistence.sh <host-ip>` — `<host-ip>` is printed by proxy setup step 6. Installs and starts dnsmasq (local DNS stub) and the `configamatron-egress.service` DNAT rules, and points the VM's resolver at the local stub via a netplan override. Both units start automatically on every future VM boot.
```

Change line 90 — replace the restart hint:

```markdown
- Switch the VM's network from NAT to host-only, then **reboot the VM** so the boot-time rules unit installs the host-only default route (host-only mode has no DHCP gateway). `sudo systemctl restart configamatron-egress.service` is an alternative to a reboot.
```

- [ ] **Step 5: `technical-notes.md` — rename the service in the persistence note**

Change line 41 from:

```markdown
- **iptables-rules@\<host-ip\>.service** DNATs the VM's outbound 80/443 traffic to Envoy on the host and installs a guarded host-only default route at boot (host-only networking hands out no DHCP gateway). See `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md`. A live NAT→host-only switch does not re-run the unit: reboot, or `sudo systemctl restart iptables-rules@<host-ip>.service`.
```

to:

```markdown
- **configamatron-egress.service** DNATs the VM's outbound 80/443 traffic to Envoy on the host and installs a guarded host-only default route at boot (host-only networking hands out no DHCP gateway). See `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md` and `docs/superpowers/specs/2026-07-10-configamatron-egress-service-idempotent-design.md`. A live NAT→host-only switch does not re-run the unit: reboot, or `sudo systemctl restart configamatron-egress.service`.
```

- [ ] **Step 6: Confirm no live reference to the old name survives**

Run: `git grep -n 'iptables-rules@' -- ':!docs/superpowers/specs' ':!docs/superpowers/plans'`
Expected: no output (all remaining hits are in historical specs/plans, which are intentionally left as-is).

- [ ] **Step 7: Verify formatting and unit tests still pass**

Run: `pnpm format:check`
Expected: PASS.

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add templates/vm-shared/verify-config.sh tests/vm/vm.test.ts tests/vm/harness/guest.sh usage.md technical-notes.md
git commit -m "refactor: update remaining references to configamatron-egress.service

verify-config.sh, the VM e2e test, the diagnostics harness, and the two docs
now name the renamed unit. Historical specs/plans left untouched."
```

---

## Self-Review

**Spec coverage:**
- Rename to fixed `configamatron-egress.service` → Task 1. ✓
- `%i` → `__HOST_IP__` placeholder in three `ExecStart` lines → Task 1 Step 4. ✓
- `07` installs via `sed | tee` → Task 2 Step 2. ✓
- `07` `enable` + `restart` (not `enable --now`) → Task 2 Step 3. ✓
- `07` updated echo + "safe to re-run" comment → Task 2 Steps 1, 4. ✓
- No `EnvironmentFile`, no legacy sweep → enforced by Global Constraints; no task adds either. ✓
- Ripple: `verify-config.sh`, `vm.test.ts`, unit-test file lists, `guest.sh`, `usage.md`, `technical-notes.md` → Tasks 1 (test lists) and 3 (rest). ✓
- Historical specs untouched → Global Constraints + Task 3 Step 6 grep excludes them. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps; every code step shows exact content. ✓

**Type/string consistency:** `configamatron-egress.service`, `__HOST_IP__`, and `/etc/systemd/system/configamatron-egress.service` are used identically across all tasks. The `sed "s|__HOST_IP__|${host_ip}|g"` substitution string (Task 2) matches the placeholder written into the unit (Task 1). ✓

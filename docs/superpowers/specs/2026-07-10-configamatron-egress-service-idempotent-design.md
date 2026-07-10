# Rerun-safe egress unit: rename `iptables-rules@.service` → `configamatron-egress.service`

Date: 2026-07-10

## Problem

`templates/vm-shared/07-setup-persistence.sh` provisions the VM's boot-time
network persistence: dnsmasq, a netplan DNS override, and a systemd unit that
DNATs outbound 80/443 to the host proxy and installs a guarded host-only default
route. The goal is that re-running `07 <host-ip>` is obviously safe — the
operator should never have to reason about whether a second run leaves junk
behind.

Most of `07` is already rerun-safe: `apt-get install -y`, the `cp`/`tee` writes,
`chmod`, `netplan apply`, `daemon-reload`, and `systemctl enable --now` are all
no-ops or harmless overwrites on a second run. The one genuine gap is the DNAT
unit's **name**. It is a systemd template, `iptables-rules@.service`, enabled as
`iptables-rules@<host-ip>.service`, and the `%i` instance name is not just a
label — it is how the host IP reaches the rules (`--to-destination %i:443`,
`ip route replace default via %i`). Because the IP is encoded in the instance
name:

- Re-running with a **different** host IP enables a *new* instance and leaves the
  old `iptables-rules@<old-ip>.service` enabled forever. It is
  `WantedBy=multi-user.target`, so it fires on every boot, re-adding stale DNAT
  rules pointing at the old IP.
- The generic `iptables-rules` name could, in principle, collide with another
  utility's unit.

## Approach

Give the unit a fixed, distinctly-owned name and bake the IP into the rules at
install time instead of into the instance name.

- **Fixed name:** `configamatron-egress.service` (plain unit, no `@`). The
  `configamatron-` prefix identifies the owner and avoids collisions; `egress`
  names the intent (outbound redirect + route). Because the filename is fixed,
  there is only ever one such unit — a rerun overwrites that one file, so there
  is no instance to enumerate, disable, or clean up.
- **IP baked into the rules via `sed`:** follow the existing repo pattern used
  for `60-dns-override.yaml`, whose `__IFACE__` placeholder `07` fills with
  `sed "s|__IFACE__|...|g" | sudo tee`. The unit template carries a
  `__HOST_IP__` placeholder in its three `ExecStart` lines; `07` seds the real
  IP in when installing the unit. No `EnvironmentFile`, no `%i`.

This deletes the stale-instance problem by construction rather than papering
over it with a cleanup loop.

## Design

### `templates/vm-shared/configamatron-egress.service` (renamed from `iptables-rules@.service`)

Plain (non-template) unit. Identical to today except the three `%i` references
become the placeholder `__HOST_IP__`:

```
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

### `templates/vm-shared/07-setup-persistence.sh`

- Add a top-of-file comment noting the script is safe to re-run.
- Replace the `cp` of `iptables-rules@.service` with a `sed | tee` that installs
  the substituted unit at `/etc/systemd/system/configamatron-egress.service`:

  ```bash
  sed "s|__HOST_IP__|${host_ip}|g" "${script_dir}/configamatron-egress.service" \
    | sudo tee /etc/systemd/system/configamatron-egress.service > /dev/null
  ```

- Replace `systemctl enable --now "iptables-rules@${host_ip}.service"` with
  `enable` plus `restart`:

  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now dnsmasq
  sudo systemctl enable configamatron-egress.service
  sudo systemctl restart configamatron-egress.service
  ```

  `restart` (rather than `enable --now`) guarantees the `ExecStart` lines re-run
  with the freshly-substituted IP on a rerun; `enable --now` would be a no-op on
  an already-active `RemainAfterExit` oneshot and would not pick up a changed IP.

- Update the closing `echo` to name `configamatron-egress.service`.

### Rerun and IP-change behavior

- **Same IP, rerun:** `sed | tee` rewrites the identical file; `restart` re-runs
  the oneshot. iptables rules are re-appended fresh for the boot; nothing
  accumulates across reboots (rules are not persisted). Safe.
- **Changed IP, rerun (no reboot):** `restart` installs the new IP's rules, but
  the old IP's DNAT lines remain live in the table until reboot (the oneshot has
  no `ExecStop`). This is acceptable — a reboot is fine for this workflow, and
  iptables rules do not survive a reboot, so after a reboot only the new IP's
  rules exist. Documented, not worked around.

### Legacy instance sweep: out of scope

A VM previously provisioned under `iptables-rules@<ip>.service` keeps that
instance enabled, and it would re-add stale rules on boot. These VMs are built
fresh from templates, so rather than add an enumeration/`disable --now` sweep to
`07`, the migration path is: **re-provision any VM that carries the legacy
`iptables-rules@*` unit.** No sweep code is added.

### Mechanical ripple (rename references)

- `templates/vm-shared/verify-config.sh` — set `svc="configamatron-egress.service"`
  (drop the `${host_ip}` interpolation) and keep the active/enabled checks. The
  `[ -n "$host_ip" ]` guard around them can stay or be dropped; the unit exists
  regardless of IP now. Keep the guard for minimal churn.
- `tests/vm/vm.test.ts` — `systemctl is-active configamatron-egress.service`.
- `tests/unit/templates.test.ts` and `tests/unit/initEnv.test.ts` — replace
  `'vm-shared/iptables-rules@.service'` with `'vm-shared/configamatron-egress.service'`
  in the expected-template-file lists.
- `tests/vm/harness/guest.sh` — update the `journalctl -u` target from
  `"iptables-rules@*"` to `configamatron-egress.service`.
- `usage.md`, `technical-notes.md` — new service name, and update the
  "restart the unit instead of rebooting" hint to
  `sudo systemctl restart configamatron-egress.service`.

### Spec hygiene

Older specs under `docs/superpowers/specs/` that reference `iptables-rules@.service`
are historical and are left untouched.

## Testing

- Unit: `tests/unit/templates.test.ts` and `tests/unit/initEnv.test.ts` assert
  the renamed template file is shipped.
- E2E (`tests/vm/vm.test.ts`): the S2 host-only reboot test asserts
  `configamatron-egress.service` is active after reboot and the guarded
  host-only default route is installed — this exercises the sed-substituted unit
  end to end.
- Manual/`verify-config.sh`: after `07`, the unit is `active` and `enabled`; the
  DNAT rules and (in host-only mode) the default route are present.

## Success criteria

- Re-running `07 <same-ip>` and `07 <different-ip>` never leaves a second egress
  unit enabled; there is exactly one, `configamatron-egress.service`, always
  reflecting the last IP passed.
- The unit name is owner-identifiable and collision-proof.
- All unit and e2e tests pass under the new name.

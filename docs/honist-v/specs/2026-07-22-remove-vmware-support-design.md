# Remove VMware support — Hyper-V only

**Date:** 2026-07-22
**Status:** Approved for planning

## Goal

The project began targeting isolated VMs on **VMware Workstation**, then shifted
to **Hyper-V** because nested isolation is a hard requirement Hyper-V provides.
Support is now Hyper-V-only in practice, but VMware remains scattered through the
living documentation and the implementation defaults. This effort purges VMware
from both so Hyper-V is the single, first-class path.

## Scope

**In scope** — living docs, implementation defaults, and tests:

- `README.md`, `usage-hyper-v-host.md` (→ renamed `usage-hyper-v.md`),
  `usage-windows-vm.md`, `technical-notes.md`, `vmware-ubuntu-display-settings.md`
- `src/runProxy/forwarder.ts`, `src/commands/runProxy.ts`
- `templates/proxy/host-allow-vm-inbound.ps1`, `templates/proxy/verify-proxy.ps1`
- `templates/vm-shared/pre-scripts/60-dns-override.yaml`
- `templates/vm-shared/pre-scripts/configamatron-egress.service`
- `templates/vm-shared/verify-config.sh`
- `tests/unit/runProxy/forwarder.test.ts`, `tests/unit/templates.test.ts`,
  `tests/vm/harness/net.sh`, `tests/vm/vm.test.ts`

**Explicitly out of scope:**

- `docs/superpowers/**`, `docs/honist-v/**` (dated design records), and `legacy/**`
  — point-in-time history; left untouched so the record stays intact.
- Any change to guest networking **behavior**. This is a rename/re-documentation
  pass, not a networking rewrite. The VM test harness keeps its current
  DHCP-based model; re-modeling it toward Hyper-V's static Internal switch is
  deferred to the host-side-DNS effort
  (`docs/investigations/2026-07-22-host-side-dns-consolidation.md`).

## Design decisions

### 1. Forwarder default adapter (decided: option a)

`src/runProxy/forwarder.ts` currently defaults to
`VMware Network Adapter VMnet1`. Change the default to the Hyper-V Internal-switch
adapter alias that the docs standardize on: **`vEthernet (configamatron-internal)`**.

- Rename the exported constant `DEFAULT_VMNET_ADAPTER` →
  `DEFAULT_INTERNAL_SWITCH_ADAPTER`.
- Reword the doc-comment: it resolves the IPv4 of the **Hyper-V Internal-switch
  host adapter** to forward from.
- The `--forward-listen <ip>` and `-AdapterAlias` overrides remain for users who
  named their switch differently.

Consequence: users who follow the guide (switch named `configamatron-internal`)
no longer need to pass `--forward-listen` or `-AdapterAlias`. The Hyper-V doc's
mandatory-override instructions are removed in favor of a note that the overrides
exist for non-standard switch names.

Rejected: (b) no default / always require flags (worse ergonomics, more verbose
docs); (c) auto-detect any `vEthernet (*)` adapter (can pick the wrong internal
switch, e.g. the Default Switch, and is harder to reason about).

### 2. Windows doc split (decided)

`usage-hyper-v.md` becomes the **single source of truth** for host setup, the
Internal switch, static IPs, and the SMB shares — for both guests.
`usage-windows-vm.md` is trimmed to guest-only concerns (Windows install, the
numbered scripts, verify) run against the mounted `\\<host-ip>\vm-shared-windows`
path, and it links to `usage-hyper-v.md` for the host/network/share setup. This
avoids duplicating the switch/IP/share steps across two docs.

### 3. Scrub "host-only" terminology (decided)

"Host-only" is VMware's name for the VM-reaches-host-not-internet network type;
Hyper-V calls the equivalent an **Internal switch** (and the isolated state is
**gateway-less**). The term is pervasive in living files — the egress unit's
description, `verify-config.sh` output, `verify-proxy.ps1` warnings/labels, the
`host-allow-vm-inbound.ps1` error, `vm.test.ts` `describe`/`it` names, and the
usage docs. All of it is reworded to Hyper-V terminology ("Internal-switch
adapter" for the NIC, "gateway-less" / "the isolated Internal-switch network" for
the mode). These are string/label/comment edits with **no behavior change**. The
term is added to the verification grep (below).

## Implementation changes

Two categories: **intentional default changes** (the three adapter defaults
below — these deliberately change which adapter is selected) and
**behavior-preserving edits** (comments, help text, labels, test
fixtures/names). Nothing changes guest
networking behavior or the runtime logic of the forwarder, the firewall script,
the verify scripts, or the VM harness.

### Intentional default changes (the only runtime-affecting edits)

Each swaps a VMware default for the Hyper-V Internal-switch adapter. Following
the guide (switch named `configamatron-internal`) now works with no override.

- **`src/runProxy/forwarder.ts`** — rename `DEFAULT_VMNET_ADAPTER` →
  `DEFAULT_INTERNAL_SWITCH_ADAPTER`; value → `vEthernet (configamatron-internal)`.
- **`templates/proxy/host-allow-vm-inbound.ps1`** — `$AdapterAlias` default →
  `vEthernet (configamatron-internal)`.
- **`templates/proxy/verify-proxy.ps1`** — `$AdapterAlias` default →
  `vEthernet (configamatron-internal)`.

### Behavior-preserving edits (comments, help text, labels, fixtures)

- **`src/runProxy/forwarder.ts`** — reword the "VMware host-only adapter"
  doc-comment to the Hyper-V Internal-switch adapter.
- **`src/commands/runProxy.ts`** — reword `--forward-listen` / `--no-forward`
  help text, the inline forward/listen-addresses comment, and the "could not find
  the ... adapter IP" error string (VMware host-only → Internal switch).
- **`templates/proxy/host-allow-vm-inbound.ps1`** — rewrite the header comment
  (scoped by `-InterfaceAlias` because the Internal switch's subnet is assigned
  per-machine; drop VMware framing) **and** the `throw` error string that tells
  users to confirm "Host-only" mode → Internal-switch/isolated.
- **`templates/proxy/verify-proxy.ps1`** — rewrite the header comment block so the
  Internal-switch adapter is the primary case, **and** all user-facing "host-only
  adapter / host-only inbound firewall rule / is the host-only adapter up?"
  warnings and pass/warn labels throughout the script.
- **`templates/vm-shared/pre-scripts/60-dns-override.yaml`** — reword the comment
  that explains DHCP-DNS suppression in terms of "VMware's host-only DHCP". The
  behavior is unchanged and still required: during setup the Hyper-V **Default
  Switch** hands out a DNS server that must be suppressed so the `127.0.0.1` stub
  wins. Describe it in Hyper-V terms.
- **`templates/vm-shared/pre-scripts/configamatron-egress.service`** — reword the
  `Description=` line ("host-only default route" → "gateway-less Internal-switch
  default route"). Unit behavior unchanged.
- **`templates/vm-shared/verify-config.sh`** — reword the two user-facing
  "host-only mode / host-only default route" result strings. Check logic
  unchanged.
- **`tests/unit/runProxy/forwarder.test.ts`** — update the imported constant name
  and replace the `VMware Network Adapter VMnet1` fixture keys with the new
  default adapter alias, keeping the same assertions (named adapter resolves;
  internal/IPv6 skipped; missing adapter → null).
- **`tests/unit/templates.test.ts`** — update the comment referencing VMware's
  host-only DHCP; keep the `use-dns: false` / passthrough assertions.
- **`tests/vm/harness/net.sh`** — rebrand the "Mimic VMware NAT" / "Mimic VMware
  host-only" comments to describe the emulated network shape generically (a
  NAT/gateway network and a gateway-less DHCP network). Harness behavior unchanged.
- **`tests/vm/vm.test.ts`** — reword the "mimicking hgfs" comment and the
  `describe`/`it` names and comments that say "host-only" (e.g. "switch to
  host-only and reboot", "guarded host-only default route") to gateway-less /
  Internal-switch phrasing. Test logic and assertions unchanged.

## Documentation changes

### `README.md`
- **Host prerequisites:** drop the VMware bullets; state Hyper-V (Windows host,
  Docker/Compose, Node ≥18 + pnpm, logged-in `claude` CLI). Reword the intro
  note about opening ports "besides VMWare".
- **VM setup:** remove the VMware-specific subsections (VMware Workstation create,
  `open-vm-tools`, "Fix Shared Folders", `/mnt/hgfs`). Point to `usage-hyper-v.md`
  as the VM-creation/network/share guide, then keep the numbered-script flow
  generalized to the mounted share path (`/mnt/vm-shared`, not `/mnt/hgfs`).
- **Verifying an environment:** `/mnt/hgfs/vm-shared` → `/mnt/vm-shared`.
- Fix the broken `usage-hyper-v.md` link (currently points at a non-existent
  filename).

### `usage-hyper-v-host.md` → rename to `usage-hyper-v.md`
- Rewrite from a "diff against VMware" into a self-contained primary hosting
  guide: remove the "Why this is different from VMware" section and the "Hyper-V
  substitute for `/mnt/hgfs`" phrasings; present the Internal switch, static IPs,
  and SMB shares as *the* setup rather than an alternative.
- Because the forwarder now defaults to `vEthernet (configamatron-internal)`,
  drop the mandatory `--forward-listen` / `-AdapterAlias` overrides from the
  isolate/verify steps; replace with a note that they exist for non-standard
  switch names.
- Update all internal references and the filename in `README.md`. The rename also
  breaks the `usage-hyper-v-host.md` reference in
  `docs/investigations/2026-07-22-host-side-dns-consolidation.md` — update it to
  `usage-hyper-v.md` (this investigation doc is a living file, in scope for the
  reference fix only).

### `usage-windows-vm.md`
- Replace VMware create / VMware Tools / `\\vmware-host\Shared Folders` / host-only
  content with Hyper-V. Keep the doc focused on guest-only steps (OS install,
  numbered scripts, verify) against `\\<host-ip>\vm-shared-windows`; link to
  `usage-hyper-v.md` for host/network/share setup and for the isolate step
  (remove the temporary Default Switch adapter).

### `technical-notes.md`
- Reword the "VM networking details" section (host-only → Internal-switch static).
- Reword the "VM egress goes through run-proxy's host forwarder" note (VMware
  host-only interface → Internal-switch adapter).
- Reword the testing "fidelity gaps vs. a real VMware VM" paragraph to frame the
  gap against Hyper-V's static Internal switch, cross-referencing
  `docs/investigations/2026-07-22-host-side-dns-consolidation.md`.
- Fix the broken `usage.md` link in the header ("Day-to-day setup lives in
  [usage.md]") — point it at `README.md`, which holds the day-to-day setup flow.

### `vmware-ubuntu-display-settings.md`
- Delete. VMware-only display tuning; no Hyper-V replacement.

## Verification

After the changes, `pnpm test` must pass — this is the full pipeline as defined
in `package.json`: `format:check`, `lint`, `typecheck`, `test:unit`, `build`,
`test:e2e`, `test:integration` (the last needs Docker running). `pnpm test:vm`
(not part of `pnpm test`) should also be run, since the harness comment/name
changes touch `tests/vm/`; it must still pass, confirming behavior is unchanged.

Additionally, a repo-wide grep for VMware/host-only terms
(`vmware`, `vmnet`, `hgfs`, `vmrun`, `vmx`, `open-vm-tools`, `vmware-host`,
`host-only`) must return matches **only** under `docs/superpowers/**`,
`docs/honist-v/**`, `legacy/**`, and `docs/investigations/**` — nothing in the
living docs, `src/`, `templates/`, or `tests/`. The excluded paths are
history/planning docs (including the host-side-DNS investigation, which
intentionally explains the VMware-era rationale and the current `host-only`
Ubuntu mechanics); only their broken filename references are fixed, not their
terminology.

## Success criteria

- No VMware references remain in living docs, `src/`, `templates/`, or `tests/`
  (per the grep above).
- The forwarder defaults to the Hyper-V Internal-switch adapter; following the
  guide requires no `--forward-listen` / `-AdapterAlias` overrides.
- `usage-hyper-v.md` reads as a standalone Hyper-V guide; `README.md` and
  `usage-windows-vm.md` reference it without VMware residue and with no broken
  links.
- All guest networking behavior and the VM test harness behavior are unchanged.
- The full verification pipeline passes.

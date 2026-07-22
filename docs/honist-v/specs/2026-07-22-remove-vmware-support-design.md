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
- `tests/unit/runProxy/forwarder.test.ts`, `tests/unit/templates.test.ts`,
  `tests/vm/harness/net.sh`

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

## Implementation changes (behavior-preserving)

### `src/runProxy/forwarder.ts`
- Rename constant and update the default value and doc-comment per decision 1.

### `src/commands/runProxy.ts`
- Reword `--forward-listen` and `--no-forward` help text from "VMware host-only
  adapter" to "Hyper-V Internal-switch adapter". Update the inline comment about
  the forward/listen addresses and the "could not find the ... adapter IP" error
  string.

### `templates/proxy/host-allow-vm-inbound.ps1`
- Change the `$AdapterAlias` default to `vEthernet (configamatron-internal)`.
- Rewrite the header comment: the rule is scoped by `-InterfaceAlias` because the
  Internal switch's subnet is assigned per-machine; drop the VMware framing.

### `templates/proxy/verify-proxy.ps1`
- Change the `$AdapterAlias` default to `vEthernet (configamatron-internal)`.
- Rewrite the comment block so the Hyper-V Internal-switch adapter is the primary
  case (currently it documents VMware as default and Hyper-V as the override).

### `templates/vm-shared/pre-scripts/60-dns-override.yaml`
- Reword the comment that explains DHCP-DNS suppression in terms of "VMware's
  host-only DHCP". The behavior is unchanged and still required: during setup the
  Hyper-V **Default Switch** hands out a DNS server that must be suppressed so the
  `127.0.0.1` stub wins. Describe it in Hyper-V terms (or generically as "the
  setup-phase DHCP network").

### Tests (comment / fixture renames only; no behavior change)
- `tests/unit/runProxy/forwarder.test.ts` — replace the
  `VMware Network Adapter VMnet1` fixture keys with the new default adapter alias,
  keeping the same assertions (named adapter resolves; internal/IPv6 skipped;
  missing adapter → null).
- `tests/unit/templates.test.ts` — update the comment that references VMware's
  host-only DHCP; keep the `use-dns: false` / passthrough assertions.
- `tests/vm/harness/net.sh` — rebrand the "Mimic VMware NAT" / "Mimic VMware
  host-only" comments to describe the emulated network shape generically (a
  NAT/gateway network and a gateway-less DHCP network). Harness behavior is
  unchanged.

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
- Update all internal references and the filename in `README.md`.

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

After the changes, the standard pipeline must pass (README "Verification
Pipeline"): `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`,
`pnpm build`, `pnpm test:e2e`. `pnpm test:vm` is run if the harness comment
changes touch anything load-bearing (they should not).

Additionally, a repo-wide grep for VMware terms
(`vmware`, `vmnet`, `hgfs`, `vmrun`, `vmx`, `open-vm-tools`, `vmware-host`) must
return matches **only** under `docs/superpowers/**`, `docs/honist-v/**`,
`legacy/**`, and the new investigation doc — nothing in the living docs, `src/`,
`templates/`, or `tests/`.

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

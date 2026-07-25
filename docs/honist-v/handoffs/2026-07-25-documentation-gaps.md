# Handoff: documentation gaps

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Blocked on:** nothing. Documentation only; no guest and no host required.

## What this is

Three documentation items left after the host-side DNS consolidation closed. The
third is the only thing in the retired
`2026-07-23-ubuntu-guest-checkpoint.md` handoff that existed nowhere else.

## 1. `usage-windows-vm.md` was never revisited for the single-adapter flow

Known gap 3, carried from the Windows checkpoint. Plan Task 15 step 4 was only
partly applied.

`usage-hyper-v.md` is current — both guests stay on DHCP throughout, isolation is a
purely host-side adapter reassignment, and there is no static IP or netplan
drop-in any more. `usage-windows-vm.md` still needs to be read against that model
and corrected where it disagrees.

While in there: `usage-hyper-v.md:193` notes that `cmdkey` entries are per-address,
so a guest mounting the share during the NAT phase needs an entry for the Default
Switch host IP as well. Confirm `usage-windows-vm.md` does not contradict that.

## 2. `usage-hyper-v.md:266` promises host-IP discovery the Windows verifier lacks

> Omit the host IP to have the script discover and report it from the installed config.

True for `verify-config.sh`, which discovers from the DHCP-supplied default route
(verified working in both branches at the Ubuntu checkpoint). **Not** true for
`templates/vm-shared-windows/verify-config.ps1:17`, which has no discovery branch
at all — omitting the argument is a guaranteed FAIL.

The sentence covers both guests, so one of the two has to change. Owned jointly
with `2026-07-25-verifier-script-defects.md` §3, which has the detail; whichever
gets picked up first should resolve both halves so they cannot drift apart again.

## 3. Plan Task 18 is internally inconsistent, and only the retired handoff said so

`docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md:2976` (Task 18,
"Rework the VM test harness").

- **Step 1** adds the resolve-to-host catch-all (`address=/#/$BRIDGE_IP`) to the
  `hostonly` branch of `net.sh` **only**.
- **Step 2** then puts a `BRIDGE_IP` resolution assertion into the block at
  `vm.test.ts:111-121`, which is the **S1 / NAT-phase** test. That phase runs in
  `gateway` mode and forwards upstream, so it never resolves to the bridge.

The implementation went the other way and is correct: S1 asserts that names
resolve **for real** and *not* to the bridge — which is what the real Windows guest
did on the Default Switch, and what the harness now models. Anyone following the
plan literally will write a failing test and think the harness is broken.

**Suggested fix:** a correction note inline at Task 18 in the plan. The plan is a
historical, executed document; annotating it in place is enough, and is where
someone would actually trip.

## Already covered elsewhere — do not re-document

Checked when retiring the previous handoff; all of this survives without it:

| Item | Where it lives now |
|---|---|
| Default Switch address regenerates across host reboots | `usage-hyper-v.md:20` |
| `pnpm test:vm` is not part of `pnpm test` | `README.md:111`, `technical-notes.md:53` |
| Harness `port=53` / `no-resolv` rationale | `tests/vm/harness/net.sh:42-56` |
| `ahostsv4` instead of `getent hosts` in the harness | `tests/vm/vm.test.ts:119` |
| Out-of-order boot recovery, both guests, with measured figures | `usage-hyper-v.md` §5 recovery note |
| No APIPA fallback on the Ubuntu guest | same note, and the spec's Ubuntu checkpoint |
| A 4xx from `api.anthropic.com` is transport success | spec, both validation-results sections |
| Responder answers NOERROR / zero records for AAAA | `net.sh:51-55`, spec Ubuntu checkpoint |

# Documentation gaps targeted reconciliation design

**Date:** 2026-07-25
**Status:** Approved

## Purpose

Resolve the remaining live items in
`docs/honist-v/handoffs/2026-07-25-documentation-gaps.md` without broadening the
work into a general documentation audit.

The behavioral half of the handoff's second item is already resolved: when its
argument is omitted, the Windows verifier now discovers the host IP if exactly
one IPv4 DNS server is configured across the system. The implementation does not
establish that the address was assigned by DHCP. `usage-hyper-v.md` still needs a
wording correction because it inaccurately calls this discovery "from the
installed config."

## Documentation changes

### Clarify the Windows guest's two host addresses

Update `usage-windows-vm.md` only where the NAT-to-isolated transition leaves the
meaning of `<host-ip>` ambiguous.

Use two explicit placeholders:

- `<default-switch-host-ip>` is the temporary Default Switch address used to
  reach the SMB share during the NAT phase.
- `<internal-switch-host-ip>` is the stable address assigned to
  `vEthernet (configamatron-internal)`. It is passed to
  `05-configure-network.ps1`, used to reach the share after isolation, and may be
  passed to the verifier.

The guide will say that `cmdkey` credentials are stored per-address. A user who
mounts the share in both phases therefore needs an entry for each address. After
the VM's single adapter is reassigned to `configamatron-internal`, the guide will
direct the user to run the post-scripts from the UNC path containing
`<internal-switch-host-ip>`.

The verification command will show the host-IP argument as optional. Omitting it
uses the verifier's configured-DNS-server discovery; supplying
`<internal-switch-host-ip>` performs the same checks against an explicit
expectation.

### Correct the host-IP discovery description

Update the verification paragraph in `usage-hyper-v.md` to say that omitting the
host IP discovers it when exactly one IPv4 DNS server is configured. Do not call
the source "the installed config" or claim that the verifier establishes DHCP
provenance.

This is a wording-only correction. The Windows verifier's discovery behavior and
the Ubuntu verifier remain unchanged.

### Correct the executed host-side DNS plan

Add a clearly labeled correction note within Task 18 of
`docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md`.

The note will explain that the Step 2 replacement shown in the historical plan
must not be applied to the S1/NAT-phase test. Gateway mode forwards DNS upstream,
so S1 must assert that a real IPv4 answer is returned and that it is not the
bridge IP. Resolving every name to the bridge belongs to the S2 isolated phase,
where the harness runs the `hostonly` dnsmasq branch with its catch-all address.
The current implementation reflects this corrected phase distinction.

The original executed steps remain visible; the correction prevents a reader
from mistaking the historical instruction for the intended current behavior.

### Retire the completed handoff

Delete `docs/honist-v/handoffs/2026-07-25-documentation-gaps.md` after its live
documentation gaps are corrected. The verifier's discovery implementation needs
no duplicate documentation: its code and the verifier-defects design and plan
remain the authoritative record.

## Scope boundaries

This work will not:

- perform a general rewrite or consistency audit of either usage guide;
- change `usage-hyper-v.md` beyond the inaccurate host-IP discovery sentence;
- change verifier, networking, or VM harness behavior;
- modify tests to accommodate documentation edits;
- duplicate the full Hyper-V setup procedure in `usage-windows-vm.md`.

## Validation

Validation is documentation-focused because runtime behavior is unchanged:

1. Check every edited Windows-guide command uses the address appropriate to its
   NAT or isolated phase.
2. Confirm the guide explicitly describes both per-address `cmdkey` entries.
3. Confirm the optional verification syntax and the corrected
   `usage-hyper-v.md` sentence match the discovery branch in
   `templates/vm-shared-windows/verify-config.ps1`: discovery succeeds only when
   exactly one IPv4 DNS server is configured.
4. Confirm the Task 18 note agrees with the current S1 test in
   `tests/vm/vm.test.ts` and the `gateway`/`hostonly` branches in
   `tests/vm/harness/net.sh`.
5. Search the edited files for stale ambiguous placeholders or claims, then
   review the complete diff.

No VM, guest, or host-side runtime testing is required.

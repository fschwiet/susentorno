# Documentation Gaps Targeted Reconciliation Implementation Plan

**Goal:** Reconcile the remaining host-side DNS documentation gaps by clarifying the Windows guest's two host addresses, accurately documenting verifier discovery, correcting the historical VM-harness plan, and retiring the completed handoff.

**Architecture:** Keep `usage-hyper-v.md` authoritative for the complete Hyper-V workflow while making `usage-windows-vm.md` unambiguous at the NAT-to-isolated transition. Preserve the executed host-side DNS plan verbatim except for an adjacent correction note that distinguishes NAT and isolated DNS behavior, then delete the handoff whose actionable content has been incorporated.

**Tech Stack:** Markdown documentation, PowerShell command examples, Bash-based textual validation, Git.

## Global Constraints

- Do not perform a general rewrite or consistency audit of either usage guide.
- Do not change `usage-hyper-v.md` beyond the inaccurate host-IP discovery sentence.
- Do not change verifier, networking, or VM harness behavior.
- Do not modify tests to accommodate documentation edits.
- Do not duplicate the full Hyper-V setup procedure in `usage-windows-vm.md`.
- Use `<default-switch-host-ip>` only for the temporary Default Switch address used to reach SMB during the NAT phase.
- Use `<internal-switch-host-ip>` for the stable Internal-switch address passed to `05-configure-network.ps1`, used for SMB after isolation, and optionally passed to the Windows verifier.
- No VM, guest, or host-side runtime testing is required.

---

### Task 1: Reconcile the Windows workflow and verifier discovery wording

**Files:**

- Modify: `usage-windows-vm.md:5-23`
- Modify: `usage-hyper-v.md:258-266`

**Interfaces:**

- Consumes: the single-adapter DHCP workflow and two host addresses already defined by `usage-hyper-v.md`.
- Produces: an unambiguous Windows NAT-to-isolated procedure and guest-specific verifier discovery contract used by readers; no code interface.

- [ ] **Step 1: Record the stale wording before editing**

Run:

```bash
rg -n '<host-ip>|<ip>|installed config|cmdkey' usage-windows-vm.md usage-hyper-v.md
```

Expected: `usage-windows-vm.md` reports the ambiguous `<host-ip>` and `<ip>` placeholders but no `cmdkey` guidance, and `usage-hyper-v.md:266` reports `from the installed config`.

- [ ] **Step 2: Clarify the two addresses in the Windows guide**

Replace `usage-windows-vm.md` from `## Create the VM and share the folder` through the end of the file with:

```markdown
## Create the VM and share the folder

VM creation, the Internal switch, DHCP networking, and the SMB share are covered in **`usage-hyper-v.md`** (Windows guest sections). Follow it first; run the numbered scripts during the NAT phase, while direct internet is available.

Two host addresses appear during this flow:

- `<default-switch-host-ip>` is the temporary address used to reach the SMB share while the VM is attached to the Default Switch.
- `<internal-switch-host-ip>` is the stable address assigned to `vEthernet (configamatron-internal)`. Pass this address to the network configuration script and use it after isolation.

`cmdkey` credentials are stored per-address. If you mount the share in both phases, save the `configamatron-share` credential for both host addresses as described in `usage-hyper-v.md`.

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**. The exact script count may vary when custom steps are present.

> cd "\\<default-switch-host-ip>\vm-shared-windows\"

> Set-ExecutionPolicy RemoteSigned

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <internal-switch-host-ip>`.
2. Isolate the VM — reassign its single adapter to `configamatron-internal` (see `usage-hyper-v.md`), with `run-proxy` already running.
3. Use the `cmdkey` entry for `<internal-switch-host-ip>`, then run every post-script in order from `\\<internal-switch-host-ip>\vm-shared-windows\post-scripts`: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.

## Verify

Inside the VM, run `.\verify-config.ps1` to discover the host when exactly one IPv4 DNS server is configured, or run `.\verify-config.ps1 -HostIp <internal-switch-host-ip>` to check an explicit address. It checks that the configured resolver is the host and that names resolve to the host.
```

- [ ] **Step 3: Give each guest an accurate discovery description**

In `usage-hyper-v.md`, replace:

```markdown
Each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed. Omit the host IP to have the script discover and report it from the installed config.
```

with:

```markdown
Each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed. If the host IP is omitted, the Ubuntu verifier discovers it from the DHCP-supplied default route; the Windows verifier discovers it when exactly one IPv4 DNS server is configured.
```

- [ ] **Step 4: Validate the address flow and discovery wording**

Run:

```bash
rg -n '<default-switch-host-ip>|<internal-switch-host-ip>|cmdkey|exactly one IPv4 DNS server|DHCP-supplied default route|installed config|<host-ip>|<ip>' usage-windows-vm.md usage-hyper-v.md
```

Expected:

- `usage-windows-vm.md` uses `<default-switch-host-ip>` only for the NAT-phase UNC path.
- `usage-windows-vm.md` uses `<internal-switch-host-ip>` for `05-configure-network.ps1`, the isolated UNC path, and explicit verification.
- The Windows guide says `cmdkey` entries are per-address.
- The two verifier discovery mechanisms appear in `usage-hyper-v.md`.
- Neither edited section contains `installed config`, the ambiguous `<host-ip>`, or the ambiguous `<ip>`.
- Matches elsewhere in `usage-hyper-v.md` for its established generic `<host-ip>` notation are out of scope and remain unchanged.

Run:

```bash
git diff --check
git diff -- usage-windows-vm.md usage-hyper-v.md
```

Expected: `git diff --check` exits 0; the diff contains only the targeted Windows workflow rewrite and the verifier-discovery sentence.

- [ ] **Step 5: Commit the usage-guide reconciliation**

```bash
git add usage-windows-vm.md usage-hyper-v.md
git commit -m "docs: clarify Windows VM address transition"
```

---

### Task 2: Annotate the historical VM-harness plan

**Files:**

- Modify: `docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md:2991-3020`

**Interfaces:**

- Consumes: current `gateway` and `hostonly` behavior in `tests/vm/harness/net.sh`, plus the implemented S1 assertion in `tests/vm/vm.test.ts`.
- Produces: a historical correction that prevents Task 18 Step 2 from being applied to the wrong phase; no code interface.

- [ ] **Step 1: Confirm the historical instruction still contradicts the implementation**

Run:

```bash
sed -n '2991,3020p' docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md
sed -n '105,130p' tests/vm/vm.test.ts
sed -n '35,70p' tests/vm/harness/net.sh
```

Expected: the historical Step 2 says the S1 test resolves every name to `BRIDGE_IP`; the current S1 test requires a real IPv4 answer that is not `BRIDGE_IP`; only the `hostonly` branch contains `address=/#/$BRIDGE_IP`.

- [ ] **Step 2: Add the correction immediately before Task 18 Step 2**

Insert this block after the Step 1 code fence and before `- [ ] **Step 2: Replace the in-guest DNS assertions**`:

```markdown
> **Correction (2026-07-25):** Step 2 below targets the S1 / NAT-phase test, so its proposed `BRIDGE_IP` assertion is incorrect and must not be followed. S1 runs the harness in `gateway` mode, which forwards DNS upstream; it must assert that `getent ahostsv4 example.com` returns a real IPv4 answer and that the answer is **not** `BRIDGE_IP`. Resolving every name to `BRIDGE_IP` belongs to S2, after the harness switches to `hostonly` mode and enables `address=/#/$BRIDGE_IP`. The current implementation in `tests/vm/vm.test.ts` reflects this corrected phase distinction.

```

Leave the original executed Step 2 text visible beneath the correction.

- [ ] **Step 3: Validate the correction against the current harness**

Run:

```bash
rg -n 'Correction \(2026-07-25\)|S1 / NAT-phase|gateway|hostonly|getent ahostsv4|address=/#/\\$BRIDGE_IP' docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md tests/vm/vm.test.ts tests/vm/harness/net.sh
git diff --check
git diff -- docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md
```

Expected: the plan contains one dated correction before Step 2; its claims match the current S1 test and `net.sh` branches; `git diff --check` exits 0; the original Step 2 remains present.

- [ ] **Step 4: Commit the historical correction**

```bash
git add docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md
git commit -m "docs: correct VM harness phase in executed plan"
```

---

### Task 3: Retire the completed documentation-gaps handoff

**Files:**

- Delete: `docs/honist-v/handoffs/2026-07-25-documentation-gaps.md`

**Interfaces:**

- Consumes: the completed guide reconciliation from Task 1 and historical correction from Task 2.
- Produces: no remaining actionable documentation-gaps handoff; no code interface.

- [ ] **Step 1: Verify that every handoff item has a durable destination**

Run:

```bash
rg -n '<default-switch-host-ip>|cmdkey|exactly one IPv4 DNS server' usage-windows-vm.md usage-hyper-v.md
rg -n 'Correction \(2026-07-25\).*S1 / NAT-phase' docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md
test -f docs/honist-v/specs/2026-07-25-verifier-script-defects-design.md
test -f docs/honist-v/plans/2026-07-25-verifier-script-defects.md
```

Expected: both address/credential guidance and verifier wording are present; the Task 18 correction is present; both verifier-defects records exist; every command exits 0.

- [ ] **Step 2: Delete the completed handoff**

Delete:

```text
docs/honist-v/handoffs/2026-07-25-documentation-gaps.md
```

- [ ] **Step 3: Validate the final documentation-only change set**

Run:

```bash
test ! -e docs/honist-v/handoffs/2026-07-25-documentation-gaps.md
git diff --check
git status --short
git diff --stat HEAD
```

Expected: the handoff does not exist; `git diff --check` exits 0; only the handoff deletion is uncommitted at this point; no verifier, networking, harness, or test file is modified.

- [ ] **Step 4: Commit the handoff retirement**

```bash
git add docs/honist-v/handoffs/2026-07-25-documentation-gaps.md
git commit -m "docs: retire documentation gaps handoff"
```

- [ ] **Step 5: Run the final repository checks**

Run:

```bash
git status --short
git log -3 --oneline
```

Expected: `git status --short` prints nothing. The latest three commits are the usage-guide reconciliation, historical correction, and handoff retirement.

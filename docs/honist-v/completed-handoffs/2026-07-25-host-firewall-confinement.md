# Handoff: host firewall confinement

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Blocked on:** nothing for the verifier work. The strong-host item wants a guest
to prove the negative, but the assertions can be written and unit-reasoned first.

## What this is

Two related gaps in how the host confines the guest, carried forward from the
Windows checkpoint (2026-07-23). They share a root cause worth stating up front:

**`verify-proxy.ps1` runs entirely host-local and never traverses the inbound path
from the guest.** So it reports green while the guest is completely cut off, and
green while the guest can reach more of the host than intended. Both gaps below
are invisible to it, and both fixes are partly assertions in it.

## 1. Confinement to the Internal-switch address is unasserted

Full analysis:
`docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md`

The guest reaches host services through a small set of firewall-allowed ports on a
**multi-homed** host. Nothing in the allow rules restricts *which* host address
the guest may target — that confinement rests on Windows' **strong host model**
and on IP forwarding being off, neither of which the project asserts or documents
as a precondition.

**Suggested fixes, from the investigation:**

- `-LocalAddress` scoping on the allow rules created by
  `templates/proxy/host-allow-vm-inbound.ps1` — **except DHCP `:67`**, which is
  broadcast and would break.
- Assert strong-host and no-forwarding in `verify-proxy.ps1`.

## 2. Gap 4 (the firewall prompt) is half-closed

`aee5cfe` fixed the *cause*: `host-allow-vm-inbound.ps1` now discovers the
`node.exe` that hosts `run-proxy`, deletes any prompt-generated
`Query User{GUID}<path>` rule for that binary, and creates a program-scoped +
interface-scoped Allow rule so Windows has nothing left to ask.

Verified at the checkpoint: a Block rule shaped exactly like the dialog's was
removed and replaced, a decoy rule for an unrelated `C:\other\place\node.exe` was
left untouched, all four node-resolution branches behave, and `run-proxy` then
started with no dialog.

### 2a. The paired verifier assertion was never written

`verify-proxy.ps1` should assert that **no** `Query User` rule exists for the
run-proxy `node.exe`. Without it, the environment can drift back — a rule created
by any other means, or by an older `run-proxy` invocation — and nothing reports it.

This is the assertion that would have caught the Task 16 precondition failure, in
which DNS and DHCP worked while `host-allow-vm-inbound.ps1` had never been run in
that environment at all, because a broad prompt-generated Allow rule was silently
carrying the traffic.

Worth doing together with gap 1's assertions: same file, same blind spot.

### 2b. Stale-rule cleanup is exact-path only, by design

`templates/proxy/host-allow-vm-inbound.ps1` matches stale rules on the **resolved**
node path:

```powershell
$_.Name -like "*Query User*" -and $_.Name.EndsWith($nodeInfo.Path, [StringComparison]::OrdinalIgnoreCase)
```

Deliberate: matching "any `node.exe`" would delete rules the user allowed for
unrelated node programs. The consequence is that a rule left behind by a
*different* node that once hosted `run-proxy` — a repo-local `dist/` during
development, say — survives, and if it is a **Block** rule it still overrides
everything the script creates.

Not worth changing the matching rule for. The right cover is 2a's assertion, which
would surface such a rule by name instead of silently deleting it.

### Node resolution, for whoever touches this next

The script resolves the path rather than assuming a layout, in this order:

| | Source | Why |
|---|---|---|
| 1 | running `run-proxy` process `ExecutablePath` | the OS knows; zero assumption |
| 2 | `node.exe` beside the `configamatron` shim | exactly what the shim itself does |
| 3 | `node` on PATH | the shim's own fallback |
| 4 | `-NodePath` parameter | explicit override |

Branch 2 is the **common** path, because the documented flow runs this script
*before* `run-proxy`. If none resolve, it warns and continues — the four port
rules are load-bearing and must not be lost because node was not found. That
warning path matters in an elevated shell whose PATH lacks the user's pnpm bin.

## Things to know

**`Set-NetFirewallProfile -Profile Public -NotifyOnListen False` is not the fix.**
It silences the dialog host-wide and suppresses the symptom rather than
establishing the rule. Rejected when gap 4 was first written up; still rejected.

**An Internal switch is always `Public`.** It has no gateway, so Windows can never
categorise it as anything else. Any approach that depends on it being Private will
not work.

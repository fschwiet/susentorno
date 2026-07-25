# Host firewall confinement

**Date:** 2026-07-25
**Status:** Draft, pending review
**Handoff:** `docs/honist-v/handoffs/2026-07-25-host-firewall-confinement.md`
**Empirical basis:** `docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md`

## Goal

`verify-proxy.ps1` runs entirely host-local and never traverses the inbound path
from the guest, so it reports green in two situations where the guest's
confinement is actually weaker than the setup assumes. Close both gaps:

1. **Confinement to the Internal-switch address is unasserted.** The inbound
   allow rules on the multi-homed host permit traffic to *any* local address on
   the allowed ports, relying entirely on Windows' strong-host model and
   disabled IP forwarding — neither set nor checked by this project.
2. **The firewall rule that pre-empts Windows' "allow node.exe on public
   networks?" dialog is broader than it needs to be.** It is program-scoped to
   an exact `node.exe` path, but that path is a shared interpreter — anything
   else ever launched through the same binary would inherit the same inbound
   access, on any port, not just the four the rest of the setup allows.

## Scope

**In scope:**

- `templates/proxy/host-allow-vm-inbound.ps1` — `-LocalAddress` scoping on the
  port rules; replace node-path discovery with a dedicated copy of node.exe.
- `templates/proxy/verify-proxy.ps1` — two new checks: strong-host/no-forwarding
  on the Internal-switch adapter, and no stale `Query User*` rule for the
  dedicated node.exe copy.
- `src/commands/runProxy.ts`, new `src/runProxy/relaunchViaDedicatedNode.ts` —
  the dedicated-copy-and-relaunch mechanism.
- `tests/unit/**` covering the above.

**Explicitly out of scope:**

- **A live weak-host demonstration.** The strong-host/no-forwarding check is
  written and reasoned about against expected `Get-NetIPInterface` output, per
  the investigation doc's own approach. Confirming it actually fires when a
  real adapter is flipped to weak-host is deferred until a guest/host pair is
  available to test it live, without deliberately weakening a real host in the
  meantime.
- **Packaging run-proxy as a true standalone executable** (Node SEA, `pkg`,
  etc.). Considered and rejected in favor of a plain copy of the existing
  node.exe — see Design decision 3.
- **Running run-proxy as a Windows service** and scoping the firewall rule by
  `-Service` instead of `-Program`. A materially bigger change to how run-proxy
  is operated, not warranted by this work.
- Gap 2b (stale prompt-generated rules left by a *different* node.exe that once
  hosted run-proxy, e.g. a repo-local dev build). The handoff already covers
  this by name via the new stale-rule check rather than a matching-rule change;
  no further action here.

## Design decisions

### 1. `-LocalAddress` scoping on the port rules

Add `-LocalAddress $hostIp` to the TCP 80/443 and UDP 53 rules in
`host-allow-vm-inbound.ps1`. This confines those rules to the Internal-switch
adapter's own address regardless of the host model, rather than relying on
Windows' strong-host default to do it implicitly.

**UDP 67 (DHCP) is excluded.** A client with no address broadcasts `DISCOVER`
from `0.0.0.0` to `255.255.255.255` — not addressed to the host's unicast IP —
so a `-LocalAddress` condition would silently break DHCP. That rule stays
interface-scoped only, per the investigation doc.

### 2. Strong-host + no-forwarding check in `verify-proxy.ps1`

New check against `$AdapterAlias` via `Get-NetIPInterface`, asserting
`Forwarding: Disabled` and weak-host-receive disabled. Reports **FAIL**, not
WARN — a weak-host flip is a real confinement break, not advisory — matching
the severity the investigation doc recommends.

Verified by reasoning about expected output only (see Scope); a live
weak-host demonstration is deferred.

### 3. A dedicated copy of node.exe, instead of resolving a shared one

**Problem with the current approach.** `host-allow-vm-inbound.ps1` resolves
"the node.exe that hosts run-proxy" (`Resolve-RunProxyNode`, 4 branches) and
creates a `-Program`-scoped Allow rule for that exact path, with no
`-LocalPort` restriction. Windows Firewall's `-Program` scoping matches the
executable image, not the script it happens to run — so the rule actually
grants **any port** to **anything ever run through that same node.exe binary**,
not just run-proxy. Since that binary is a generic interpreter (potentially
shared with other scripts, other tools, or future invocations), the rule is
wider than intended and the resolution logic needed to guess at it is a source
of ambiguity in its own right.

**Decision: give run-proxy a private, dedicated copy of node.exe**, and scope
the firewall rule to that copy's fixed path instead.

- **Location:** `%USERPROFILE%\.configamatron-host\run-proxy-node.exe`, with a
  `readme.txt` alongside it explaining why the file exists and that it is a
  plain copy, not a customized build. Host-wide rather than per-project,
  matching the existing model where the firewall rules themselves are
  host-wide (fixed `DisplayName`s, not parameterized per environment) — a
  per-project copy would leave only the most-recently-configured project's
  copy actually covered by the Allow rule.
- **Creation and relaunch, in `src/commands/runProxy.ts`:** as the first thing
  the `run-proxy` action does, gated on `process.platform === 'win32' &&
  options.forward` (see below): if `process.execPath` does not already match
  the dedicated path, copy `process.execPath` there if it doesn't already
  exist (create-if-missing only — no staleness detection; deleting the file
  forces a re-copy on the next start), then spawn that copy as a child process.
  The path comparison is case-insensitive, matching Windows path semantics —
  a naive case-sensitive compare risks an infinite relaunch loop if
  `process.execPath` is ever reported in different casing than the stored
  constant.
  with the same argv/cwd/env and inherited stdio, wait for it to exit, and
  propagate its exit code. The parent does nothing else once relaunching.
- **Why gated on both platform and `forward`:** the entry node.exe (whatever
  the install/shim resolves) never binds a socket before this check runs, so
  it can never trigger Windows' listen-time prompt itself; only code paths
  that actually bind the Internal-switch adapter (`startDnsResponder`,
  `startDhcpServer`, gated on `options.forward`) need the dedicated path. Every
  existing test invokes `run-proxy` with `--no-forward`
  (`tests/integration/runProxy.test.ts`, `runProxyRobustness.test.ts`,
  `codexInjection.test.ts`, `githubInjection.test.ts`, `tests/proxyStack.ts`),
  so this gate means the relaunch mechanism does not engage during any existing
  test or a loopback-only dev run, with no separate test-mode flag needed.
- **Non-Windows hosts:** the `process.platform === 'win32'` guard means none of
  this logic runs at all elsewhere; `run-proxy`'s behavior on other platforms
  is unchanged.
- **Error handling:** a copy failure (permissions, disk space) or spawn failure
  is a hard failure — clear message, non-zero exit, no fallback to running
  through the entry node.exe. Falling back would silently reintroduce the
  broad-rule exposure this design removes.
- **Consequences for `host-allow-vm-inbound.ps1`:** `Resolve-RunProxyNode` and
  the `-NodePath` parameter are deleted entirely. The script computes the same
  fixed dedicated path (mirroring the TS convention) and creates the
  `-Program`-scoped Allow rule against it unconditionally — no discovery, no
  "could not locate node.exe" warning branch, since the path is a known
  constant rather than a discovery result. The existing stale
  `Query User*`-rule cleanup for that binary is kept, now matched against the
  fixed path directly.
- **Consequences for `verify-proxy.ps1`'s new check (gap 2a):** "no
  `Query User*` rule exists for the dedicated node.exe path" needs no
  resolution logic of its own — it checks the one known constant, the same one
  `host-allow-vm-inbound.ps1` uses.

**Rejected alternatives:**

- **(b) Modify the `configamatron` shim/launcher** to route the `run-proxy`
  subcommand through a dedicated node.exe before the CLI's JS even starts.
  Rejected: shim format varies by install method (global npm/pnpm, `npx`,
  pnpm's own node.exe placement), giving less control than handling it inside
  the action handler where the exact entry point and its arguments are known.
- **(c) Package run-proxy as a true standalone executable** (Node SEA or a
  bundler like `pkg`). The properly-correct version of this idea — the binary
  would have no script argument to redirect at all — but adds a real packaging
  step beyond the existing `tsup` build, with its own caveats (native modules,
  blob injection). Disproportionate to the rest of this project's footprint;
  a plain copy achieves the same firewall-scoping outcome at a fraction of the
  cost.
- **(d) Run as a Windows service**, scoping the firewall rule by `-Service`.
  Changes how `run-proxy` starts/stops/is supervised — a materially bigger
  change than this work's scope.

## Implementation changes

- **`src/runProxy/relaunchViaDedicatedNode.ts` (new)** — `getDedicatedNodePath()`,
  `ensureDedicatedNodeCopy()` (copy + write/refresh `readme.txt`), and
  `relaunchIfNeeded()` (the platform/forward-gated check, copy, spawn, wait,
  propagate exit code). Dependencies (fs operations, spawn, platform) are
  injectable, matching the existing `RunProxyDeps` pattern used elsewhere in
  `runProxy.ts`, so the decision logic is unit-testable without touching a
  real filesystem or process.
- **`src/commands/runProxy.ts`** — one call at the very top of the `.action()`
  handler: if the relaunch fires, return immediately without doing anything
  else in that process.
- **`templates/proxy/host-allow-vm-inbound.ps1`**:
  - Delete `Resolve-RunProxyNode` and the `-NodePath` parameter.
  - Compute the fixed dedicated path via the same convention as the TS side.
  - Add `-LocalAddress $hostIp` to the TCP 80/443 and UDP 53 rules; UDP 67
    stays interface-scoped only.
  - Keep the stale `Query User*`-rule cleanup, now matched against the fixed
    path unconditionally.
- **`templates/proxy/verify-proxy.ps1`**:
  - New FAIL-severity check: strong-host + no-forwarding on `$AdapterAlias`.
  - New check: no `Query User*` rule exists for the fixed dedicated path.

## Tests

- Unit tests for `relaunchViaDedicatedNode.ts` (injected fs/spawn/platform):
  already on the dedicated path → no-op; not yet copied → copy then spawn;
  copy already present → spawn only, no re-copy; non-win32 → no-op;
  `--no-forward` → no-op; differently-cased `process.execPath` matching the
  dedicated path → treated as already-relaunched, no infinite loop.
- `templates.test.ts`-style content assertions: `host-allow-vm-inbound.ps1`
  contains `-LocalAddress` and no longer contains `Resolve-RunProxyNode` or
  `-NodePath`; `verify-proxy.ps1` contains the new forwarding/weak-host check
  and the `Query User` check.
- No new automated test exercises a real Windows firewall or Hyper-V adapter —
  consistent with this project's existing posture, where these host-only
  scripts are verified manually at checkpoints, not by CI.

## Verification

- `pnpm test` passes.
- On a Windows host: `host-allow-vm-inbound.ps1` runs cleanly and creates rules
  scoped as designed; `verify-proxy.ps1` passes, including the two new checks.
- Manual (deferred per Scope): confirm the strong-host/no-forwarding check
  actually reports FAIL when a real adapter's weak-host-receive is enabled,
  once a guest/host pair is available to test it without weakening a
  production host.

## Success criteria

- The inbound allow rules confine guest traffic to the Internal-switch address
  independently of the host model, and `verify-proxy.ps1` fails loudly if that
  host model is ever weakened.
- The firewall rule that admits run-proxy's process is scoped to a binary that
  only ever runs run-proxy — not a shared interpreter that could also carry
  unrelated traffic.
- `verify-proxy.ps1` fails loudly if a stale `Query User*` rule for that binary
  ever reappears, rather than silently permitting drift back to the
  pre-`aee5cfe` state.
- No behavior change on non-Windows platforms, and no behavior change for any
  existing test or loopback-only dev invocation.

## Risks

- **The dedicated-copy convention is enforced by construction, not by the OS.**
  Nothing stops someone from manually invoking the copy for an unrelated
  purpose — but doing so requires a deliberate act, unlike today's shared
  node.exe which could pick up unrelated use unintentionally.
- **Node.exe copy staleness.** The copy is created once and never
  auto-refreshed; a newer node.exe from an updated install will not propagate
  until the copy is deleted. Low severity (an older but still-functional
  runtime), documented in the `readme.txt`.
- **Order of operations on first-ever setup.** `host-allow-vm-inbound.ps1` may
  run before the dedicated copy file exists (the documented flow runs it
  before `run-proxy`'s first start). This is fine — `New-NetFirewallRule
  -Program` does not require the target file to exist at rule-creation time —
  but is worth stating explicitly so it isn't mistaken for a bug during
  implementation or review.

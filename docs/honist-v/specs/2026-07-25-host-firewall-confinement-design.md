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
  TCP 80/443, UDP 53, and SMB 445 rules; `-LocalPort` scoping on the node.exe
  `-Program` rule to the ports it actually needs; replace node-path discovery
  with a dedicated copy of node.exe.
- `templates/proxy/verify-proxy.ps1` — two new checks: strong-host/no-forwarding
  on the Internal-switch adapter, and no stale `Query User*` rule for any
  node.exe (not just the dedicated copy's path).
- `src/commands/runProxy.ts`, new `src/runProxy/relaunchViaDedicatedNode.ts` —
  the dedicated-copy-and-relaunch mechanism; also removes the unused
  `--forward-ports` option (see Design decision 3).
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
- **Multi-user hosts.** The dedicated node.exe's location
  (`%USERPROFILE%\.configamatron-host\...`) assumes the same Windows account
  runs both `host-allow-vm-inbound.ps1` and `run-proxy` — see Design decision 3.
- **Coordinating the forwarder's bind address across scripts.** The
  `-LocalAddress` fix assumes the Internal-switch adapter carries a single
  IPv4 address and that it's the one `run-proxy` actually forwards from — see
  Design decision 1.

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

**Assumes the adapter carries exactly one IPv4 address, and that it's the one
`run-proxy` actually forwards from.** `$hostIp` is the first address
`Get-NetIPConfiguration -InterfaceAlias $AdapterAlias` reports — not
necessarily the one `run-proxy` binds. `run-proxy` resolves its own forward
address independently (`resolveForwardListenAddress()`) and accepts an
explicit `--forward-listen <ip>` override this script has no way to see. If
the adapter ever carries a second IPv4 address, or `--forward-listen` points
elsewhere, `-LocalAddress` can silently scope to the wrong address and drop
the real listener's traffic. Adding a second IPv4 to the Internal-switch
adapter is an intentional, out-of-band act — not something normal setup or
DHCP does — so this is treated as an unsupported deviation for now rather than
solved here. A follow-up could have both scripts read one resolved IP from
`.configamatron` instead of each computing it independently; deferred as a
separate issue (see Scope).

**Also applied to the SMB (445) share rule.** That rule spans two adapters
(`$AdapterAlias` and `$NatAdapterAlias`), so a single `-LocalAddress` value
isn't enough — Windows evaluates multiple `-InterfaceAlias`/`-LocalAddress`
values as independent ORs, not paired tuples, so a shared list would still let
a packet arriving on one interface match an address that belongs to the
other, defeating the point. Splitting into two `New-NetFirewallRule` calls,
each with its own single `-InterfaceAlias`/`-LocalAddress` pair (both still
under the existing `$smbRuleName` `DisplayName`, matching the "safe to re-run"
pattern already used elsewhere), avoids that. The `$NatAdapterAlias` address
is resolved the same way as `$hostIp`, and treated the same way if it can't be
found: `throw`, same as the existing check for `$hostIp` on `$AdapterAlias`. A
silent interface-only fallback would quietly reopen exactly the gap this
design closes, contradicting the Success Criteria's "independently of the
host model" claim for SMB; failing setup instead keeps that claim true. This
only affects setup-time rule creation — it doesn't change how the VM uses the
SMB share once both rules exist, whether it's on the Internal-switch or NAT
network.

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
  copy actually covered by the Allow rule. Assumes a single-user host: the
  account that runs `host-allow-vm-inbound.ps1` (needs admin) and the account
  that runs `run-proxy` are the same Windows user, so `%USERPROFILE%` resolves
  to the same path for both — see Scope.
- **Creation and relaunch, in `src/commands/runProxy.ts`:** as the first thing
  the `run-proxy` action does, gated on `process.platform === 'win32' &&
  options.forward` (see below): if `process.execPath` does not already match
  the dedicated path (case-insensitive, matching Windows path semantics — a
  naive case-sensitive compare risks an infinite relaunch loop if
  `process.execPath` is ever reported in different casing than the stored
  constant), ensure the dedicated copy is present and current (see below),
  then spawn it as a child process with `process.argv.slice(1)` — `argv[0]`
  is the *current* node executable's own path, so passing it unmodified would
  hand the child a bogus leading argument — and the same cwd/env, inherited
  stdio. Before spawning, register a no-op `SIGINT` listener on the parent:
  Ctrl-C on Windows delivers `CTRL_C_EVENT` to every process sharing the
  console, parent and child alike, and Node's default reaction to an
  *unhandled* `SIGINT` is immediate termination — without the listener the
  parent would very likely die on the same keystroke that's supposed to
  trigger the child's graceful shutdown, before it can wait for the child's
  exit and propagate its code. With the listener installed, the child (which
  already has its own `SIGINT`-driven graceful shutdown in `runProxyLoop`)
  handles the keystroke normally, and the parent's own exit is driven solely
  by the child's `exit` event: Node's `exit` event supplies `(code, signal)`;
  when `code` is non-null it's propagated directly as the parent's exit code,
  and when it's null (the child died by signal rather than exiting normally)
  the parent falls back to a fixed non-zero exit code (`1`) with a message —
  Windows has no real signals to re-raise on the parent, so reproducing POSIX
  kill semantics isn't warranted here. The parent does nothing else once
  relaunching.
- **Ensuring the dedicated copy is present and current:** compare file size
  first (cheap `stat`); if they differ, copy. If sizes match, compare a
  streamed SHA-256 of both files and copy on mismatch. This runs at most once
  per `run-proxy --forward` session — not a hot path — so hashing an
  ~80-120MB node.exe (a fraction of a second) is negligible next to the rest
  of startup (bringing up Docker containers, etc.). This replaces a simpler
  create-if-missing-only plan and closes two things at once: it stops
  trusting whatever already happens to be at the dedicated path without
  checking it's actually a copy of `process.execPath`, and it removes the
  staleness risk noted below — a newer node.exe from an updated install now
  propagates on the next start instead of requiring the file to be deleted
  manually.
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
- **Why the ports can be treated as fixed:** `--forward-ports` is unused
  anywhere in this codebase outside its own definition in `runProxy.ts`, and
  is being deleted as dead code in this change (see Implementation changes)
  rather than supported alongside the new port-scoped rule. `ENVOY_HTTP_PORT`
  / `ENVOY_HTTPS_PORT` remain, but the only place that sets them
  (`tests/proxyStack.ts`) always pairs them with `--no-forward`, so they only
  ever affect the loopback listener — never the Internal-switch-facing one
  this rule covers. Not hardened against someone combining a custom
  `ENVOY_HTTP_PORT`/`ENVOY_HTTPS_PORT` with `--forward` for a real (non-test)
  run, since nothing in the codebase does that today.
- **Consequences for `host-allow-vm-inbound.ps1`:** `Resolve-RunProxyNode` and
  the `-NodePath` parameter are deleted entirely. The script computes the same
  fixed dedicated path (mirroring the TS convention). Since that binary now
  only ever runs run-proxy, and run-proxy's forwarded listener only ever binds
  TCP 80/443, UDP 53, and UDP 67 on this adapter (see above), the
  `-Program`-scoped Allow rule is also scoped by `-LocalPort` — closing the
  "any port" residual this design's Goal calls out, not just the "any
  program" one. This needs **three** rules, not two: a single
  `New-NetFirewallRule` can't mix TCP and UDP under one `-Protocol`, so it
  mirrors the plain port rules' existing three-way split — TCP 80/443 with
  `-LocalAddress $hostIp`, UDP 53 with `-LocalAddress $hostIp`, and UDP 67
  alone without it, for the same broadcast reason as the plain DHCP rule
  above. No discovery, no "could not locate node.exe" warning branch, since
  the path is a known constant rather than a discovery result. The existing
  stale `Query User*`-rule cleanup for that binary is kept, now matched
  against the fixed path directly.
- **Consequences for `verify-proxy.ps1`'s new check (gaps 2a and 2b):** rather
  than checking only the one known dedicated-path constant, the check scans
  for *any* `Query User*` rule whose target ends in `node.exe`, and **FAILs**
  listing each by name — reporting, not deleting, since a rule for some other
  node.exe might be legitimate (e.g. a user's unrelated tool) and this script
  is read-only diagnostics. This also catches gap 2b (a stale rule for a
  *different*, older node.exe that once hosted run-proxy — e.g. a repo-local
  dev build), which a dedicated-path-only check could not see.
  `host-allow-vm-inbound.ps1` itself still only *deletes* the stale rule for
  its own fixed path (unchanged from today), since deleting on the basis of
  "looks like node.exe" would risk removing a rule the user allowed for an
  unrelated program.

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
  `ensureDedicatedNodeCopy()` (size, then SHA-256, comparison against
  `process.execPath`; copy on mismatch; write/refresh `readme.txt`), and
  `relaunchIfNeeded()` (the platform/forward-gated check, ensure-copy, spawn
  with `argv.slice(1)`, install the no-op parent `SIGINT` listener, wait,
  propagate exit code). Dependencies (fs operations, spawn, platform) are
  injectable, matching the existing `RunProxyDeps` pattern used elsewhere in
  `runProxy.ts`, so the decision logic is unit-testable without touching a
  real filesystem or process.
- **`src/commands/runProxy.ts`** — one call at the very top of the `.action()`
  handler: if the relaunch fires, return immediately without doing anything
  else in that process. Also delete the unused `--forward-ports` option and
  `forwardPorts`/`options.forwardPorts` handling (see Design decision 3).
- **`templates/proxy/host-allow-vm-inbound.ps1`**:
  - Delete `Resolve-RunProxyNode` and the `-NodePath` parameter.
  - Compute the fixed dedicated path via the same convention as the TS side.
  - Add `-LocalAddress $hostIp` to the TCP 80/443 and UDP 53 rules; UDP 67
    stays interface-scoped only.
  - Split the SMB 445 rule into two rules, one per adapter, each with its own
    `-LocalAddress` (`$hostIp` for `$AdapterAlias`, the resolved
    `$NatAdapterAlias` address for the other — `throw` if that address can't
    be resolved, same as the existing `$hostIp` check).
  - Add three `-Program`-scoped rules for the dedicated node.exe path — TCP
    80/443 and UDP 53 with `-LocalAddress $hostIp`, UDP 67 without — closing
    the "any port" gap this design's Goal names, not just the "any program"
    one.
  - Keep the stale `Query User*`-rule cleanup, now matched against the fixed
    path unconditionally.
- **`templates/proxy/verify-proxy.ps1`**:
  - New FAIL-severity check: strong-host + no-forwarding on `$AdapterAlias`.
  - New FAIL-severity check: no `Query User*` rule exists for *any* node.exe,
    listing matches by name (covers gaps 2a and 2b — see Design decision 3).

## Tests

- Unit tests for `relaunchViaDedicatedNode.ts` (injected fs/spawn/platform):
  already on the dedicated path → no-op; not yet copied → copy then spawn;
  copy present and matching (size + hash) → spawn only, no re-copy; copy
  present but size or hash mismatched → re-copy then spawn; non-win32 → no-op;
  `--no-forward` → no-op; differently-cased `process.execPath` matching the
  dedicated path → treated as already-relaunched, no infinite loop; spawn is
  called with `argv.slice(1)` (not the raw `argv`) and the same cwd/env; a
  parent `SIGINT` listener is installed before spawning; a non-null child
  exit code is propagated as the parent's; a null (signal-terminated) child
  exit code falls back to a fixed non-zero exit code.
- `templates.test.ts`-style content assertions: `host-allow-vm-inbound.ps1`
  contains `-LocalAddress` on the TCP/DNS/SMB rules and three `-LocalPort`
  `-Program` rules for the node.exe path, and no longer contains
  `Resolve-RunProxyNode` or `-NodePath`; `verify-proxy.ps1` contains the new
  forwarding/weak-host check and the broadened `Query User` check.
- A test (or an assertion in an existing `runProxy.ts` test) confirming
  `--forward-ports` is gone from the CLI's option list.
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

- The inbound allow rules — TCP 80/443, UDP 53, and SMB 445 — confine guest
  traffic to the Internal-switch (and, for SMB, Default Switch) address
  independently of the host model, and `verify-proxy.ps1` fails loudly if that
  host model is ever weakened.
- The firewall rule that admits run-proxy's process is scoped to a binary that
  only ever runs run-proxy, on only the ports it actually needs — not a
  shared interpreter, and not an unrestricted port range.
- `verify-proxy.ps1` fails loudly if a stale `Query User*` rule for that binary
  *or any other node.exe* ever reappears, rather than silently permitting
  drift back to the pre-`aee5cfe` state.
- No behavior change on non-Windows platforms, and no behavior change for any
  existing test or loopback-only dev invocation.

## Risks

- **The dedicated-copy convention is enforced by construction, not by the OS.**
  Nothing stops someone from manually invoking the copy for an unrelated
  purpose — but doing so requires a deliberate act, unlike today's shared
  node.exe which could pick up unrelated use unintentionally.
- **Order of operations on first-ever setup.** `host-allow-vm-inbound.ps1` may
  run before the dedicated copy file exists (the documented flow runs it
  before `run-proxy`'s first start). This is fine — `New-NetFirewallRule
  -Program` does not require the target file to exist at rule-creation time —
  but is worth stating explicitly so it isn't mistaken for a bug during
  implementation or review.

# `create-host-network` / `delete-host-network`

## Purpose

`setup-machine.md` today has two manual, host-level steps done once per Windows host, before any environment exists: (1) create a Hyper-V Internal switch and assign it a static host IP by hand, and (2) run `templates/proxy/host-allow-vm-inbound.ps1` — a script templated into every environment's `.susentorno/proxy/` by `susentorno init`, even though its effect is host-wide, not per-environment — to open the firewall.

This design replaces both with two CLI commands, `susentorno create-host-network` and `susentorno delete-host-network`, following the pattern `setup-guest-unix` already established for elevated Hyper-V/PowerShell automation from this CLI (pure command-string builders, a thin untested `PowerShellExec` wrapper, an `isElevated()` gate checked first). `host-allow-vm-inbound.ps1` and its template copy step are deleted outright — the underlying decision, including the `--isolation-name` sandboxing mechanism and the new real-Hyper-V test tier this enables, is recorded in [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md).

## Scope

Both commands are host-level: unlike `setup-guest-unix`, they do not require an environment directory (`requireEnvPathsOrExit` does not apply) and run before any environment exists, matching where `setup-machine.md` sits relative to `setup-environment.md` today. Both require an elevated terminal, checked first via the existing `isElevated()`/`elevationCheck.ts` module, before any prompting — same as `setup-guest-unix`.

## Naming and `--isolation-name`

The switch name is fixed by default: `susentorno-internal`, reusing the existing `DEFAULT_INTERNAL_SWITCH_ADAPTER` constant (`src/runHosting/forwarder.ts`) rather than introducing a second source of truth. An optional `--isolation-name <name>` flag (both commands) renames the switch to `susentorno-<name>-internal` and its adapter alias to `vEthernet (susentorno-<name>-internal)`. Every firewall rule's `DisplayName` gets the same treatment — `susentorno` becomes `susentorno-<name>` throughout:

| Rule | Default `DisplayName` | With `--isolation-name test` |
| --- | --- | --- |
| TCP 80/443 | `susentorno Envoy Proxy (VM inbound)` | `susentorno-test Envoy Proxy (VM inbound)` |
| UDP 53 | `susentorno DNS stub (VM inbound)` | `susentorno-test DNS stub (VM inbound)` |
| UDP 67 | `susentorno DHCP (VM inbound)` | `susentorno-test DHCP (VM inbound)` |
| TCP 445 (both adapters) | `susentorno share (VM inbound)` | `susentorno-test share (VM inbound)` |

This exists purely so the `host-network` test tier (below) can create and delete a fully separate, sandboxed network (`susentorno-test-internal`) without ever touching a developer's real `susentorno-internal` switch — both can coexist on the same machine. It is not a general multi-network feature; nothing else in the system (run-hosting, guest setup scripts) is parameterized to talk to a non-default host network today.

Two things `--isolation-name` does **not** affect:
- **The dedicated node.exe copy** (`getDedicatedNodePath`, `src/runHosting/relaunchViaDedicatedNode.ts`) that the TCP/DNS/DHCP rules are `-Program`-scoped to. There is exactly one such copy, host-wide, regardless of how many named host networks exist — a production and an isolated test rule set both reference the same path.
- **The Default Switch (NAT) adapter itself.** It's a real, shared Windows/Hyper-V object this project never creates or deletes; only the `DisplayName` of the SMB rule's NAT-side half varies with `--isolation-name`, not the adapter it's scoped to.

## `create-host-network`

Flags: `--isolation-name <name>` (optional), `--subnet <n>` (optional, 0–255, skips the interactive prompt), `--nat-adapter-alias <alias>` (optional, default `vEthernet (Default Switch)`, needed for the SMB rule's NAT-side half). No `--switch-name` — the switch name is derived from `--isolation-name` only, per the fixed-name decision above.

1. **Elevation check.** Exit immediately if not admin, before any prompting.
2. **Existence check.** `Get-VMSwitch -Name <switch-name> -ErrorAction SilentlyContinue`, parsed structurally (empty output = not found, not a failure — same convention `hyperVQueries.ts`/`preflightChecks.ts` already use for `Get-VM`/`Get-VMSwitch`). If found, resolve its current IPv4 via `resolveForwardListenAddress(<adapter-alias>)` (`src/runHosting/forwarder.ts` — reads `os.networkInterfaces()` in-process, no PowerShell round-trip needed) and exit with:
   > `create-host-network: host network already exists at <ip> (switch '<switch-name>'). Run 'susentorno delete-host-network' first if you'd like to re-create it in a pristine state.`

   If the switch exists but has no IPv4 yet (a prior partial failure), say so explicitly instead of printing a blank or misleading IP.
3. **Resolve the subnet's third octet.**
   - If `--subnet <n>` was passed, use it directly (still validated against the taken-list below — fails loudly on collision, since no interactive fallback exists).
   - Otherwise, read every IPv4 address currently configured on any local adapter via `os.networkInterfaces()` (in-process, same source `resolveForwardListenAddress` already reads — no PowerShell shell-out needed), compute which `192.168.n.0/24` ranges are already in use, and prompt (`promptText`) for `Subnet (192.168.<n>.x)` with the lowest free `n` as the suggested default.
4. `New-VMSwitch -Name <switch-name> -SwitchType Internal`.
5. `New-NetIPAddress -InterfaceAlias <adapter-alias> -IPAddress 192.168.<n>.1 -PrefixLength 24`.
6. Clear any stale Windows "Query User"-prompt rule for the dedicated node.exe path — same cleanup `host-allow-vm-inbound.ps1` does today, and not isolation-scoped (there's one node.exe path regardless of `--isolation-name`).
7. Create the four firewall rule sets, ported from `host-allow-vm-inbound.ps1`'s logic to TypeScript command builders (see Module layout): TCP 80/443 + UDP 53, both `-Program`-scoped to the dedicated node.exe path and `-LocalAddress`-scoped to the new host IP; UDP 67, interface-scoped only (DHCP broadcast has no destination address to scope to); TCP 445 on both `<adapter-alias>` and `--nat-adapter-alias`, each `-LocalAddress`-scoped to that adapter's own IP.
8. Print the host IP and a short "what's next" pointer, replacing today's script's closing `Write-Host` lines.

## `delete-host-network`

Flags: `--isolation-name <name>` (optional). No `--nat-adapter-alias` — the NAT-side SMB rule is found by name, not by interface (below), so it needs no adapter parameter.

This command is deliberately a "return this adapter to a pristine state" tool, not a strict undo of what a matching `create-host-network` made — the sweep in step 1 removes rules regardless of who created them, so it can also clean up a corrupted host where unrelated rules have accumulated on the adapter.

1. **Elevation check.**
2. **Interface sweep.** Every firewall rule whose interface filter matches `<adapter-alias>` is removed, regardless of `DisplayName` — including the DHCP rule (interface-scoped, no `-LocalAddress`) and any stale "Query User" rule.
3. **Named sweep.** Every firewall rule named `<rule-prefix> share (VM inbound)` is removed regardless of adapter — this is what catches the SMB rule's Default-Switch/NAT-adapter half, which step 2's interface filter deliberately does not touch.
4. **Switch removal.** `Get-VMSwitch -Name <switch-name>`; if found, `Remove-VMSwitch` (its IP assignment goes with it — no separate step). If not found, this is a no-op, not an error.
5. Print a summary of what was actually removed (switch: yes/no; rule count).

Steps 2–4 each run unconditionally and independently — a rerun after a partial failure, or against an already-clean host, just finishes whatever's left rather than erroring on "nothing to do."

## Error handling

Two different PowerShell call shapes need different treatment, matching the split `hyperVQueries.ts` (queries) vs. `hyperVOperations.ts`/`vmReconcile.ts` (mutations) already use:

- **Query commands** (`Get-VMSwitch`, `Get-NetFirewallRule`) are built with `-ErrorAction SilentlyContinue` and read via **parsed stdout**, not exit code — empty output means "not found," which is meaningful information the orchestration acts on (proceed with creation; skip a removal step), never a reason to abort the whole command. (IP/subnet lookups don't hit this concern at all — they're in-process `os.networkInterfaces()` reads, not PowerShell calls, per the subnet-selection and existence-check steps above.)
- **Mutating commands** (`New-VMSwitch`, `New-NetIPAddress`, `New-NetFirewallRule`, `Remove-VMSwitch`, `Remove-NetFirewallRule`) are where a non-zero exit or thrown error is real failure: print `create-host-network: <message>` / `delete-host-network: <message>`, set `process.exitCode = 1`, stop immediately rather than continuing to later steps.

`delete-host-network` never fails solely because there was nothing to delete, per its idempotency design above — a clean host is a successful no-op run.

## Module layout

New `src/hostNetwork/` folder, mirroring the existing `src/guestSetup/` split (pure builders/parsers, unit-tested directly; orchestration composed from them, unit-tested with fakes; the actual `execa` call is the existing untested `PowerShellExec` wrapper, reused as-is):

| File | Responsibility |
| --- | --- |
| `src/hostNetwork/hostNetworkNames.ts` | Derives `switchName`/`adapterAlias`/every rule `DisplayName` from an optional `isolationName`. |
| `src/hostNetwork/subnetSelection.ts` | Detects taken `192.168.n.0/24` ranges from `os.networkInterfaces()` (injectable, same convention `resolveForwardListenAddress` uses); computes the lowest free `n`; validates a given `n`. |
| `src/hostNetwork/hostNetworkOperations.ts` | Command builders for `New-VMSwitch`, `New-NetIPAddress`, the four firewall rule sets, the stale-rule cleanup, `Remove-VMSwitch`, the interface-scoped sweep, and the named sweep. |
| `src/hostNetwork/createHostNetwork.ts` | Orchestrates the create flow (steps 1–8 above) against injected `PowerShellExec`/prompt/query dependencies. |
| `src/hostNetwork/deleteHostNetwork.ts` | Orchestrates the delete flow (steps 1–5 above). |
| `src/commands/createHostNetwork.ts` | Thin CLI glue: elevation gate, prompt, call `createHostNetwork`, print results. Registered in `src/cli.ts`. |
| `src/commands/deleteHostNetwork.ts` | Thin CLI glue: elevation gate, call `deleteHostNetwork`, print results. Registered in `src/cli.ts`. |

Reused as-is, no duplication: `isElevated`/`elevationCheck.ts`, `createRealPowerShellExec`/`powerShellExec.ts`, `quoteForPowerShell`, `promptText` (`cliPrompt.ts`), `buildGetVmSwitchCommand`/`parseVmSwitchExists` (`hyperVQueries.ts`), `resolveForwardListenAddress` (`runHosting/forwarder.ts`), and `getDedicatedNodePath` (`relaunchViaDedicatedNode.ts`).

## Testing

**Unit tier** (`tests/unit/hostNetwork/`): every command builder/parser above, plus the subnet-detection algorithm (given a set of local IPv4 addresses, which `n` values are taken; lowest-free-`n` computation; out-of-range/taken-collision rejection) and the isolation-name-driven name derivation (default vs. `--isolation-name test`, including that the NAT-adapter alias and dedicated-node.exe path are unaffected by it).

**New `host-network` tier** (`pnpm test:host-network`, `tests/host-network/`, `vitest.host-network.config.ts`), per [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md): runs `create-host-network`/`delete-host-network` against real Hyper-V and real Windows Firewall state, always passing `--isolation-name test` and `--subnet <n>` (non-interactive — required for an automated suite), so it has free reign over `susentorno-test-internal` without ever touching a developer's real `susentorno-internal`. A startup gate checks `isElevated()` and fails fast (not skip-silently) if not admin, matching the existing "a missing live-tier prerequisite is an environmental failure" philosophy `proxy-stack`/`guest` already establish. Each test calls `delete-host-network --isolation-name test` first for a guaranteed-clean starting point, then exercises `create-host-network`, asserting real state via `Get-VMSwitch`/`Get-NetFirewallRule`. Wired into the default `pnpm test` pipeline alongside `guest` — a full green run now also requires an elevated shell.

## Documentation updates

- `templates/proxy/host-allow-vm-inbound.ps1` is deleted; the copy step that templates it into a fresh environment's `.susentorno/proxy/` (`src/initEnv.ts`/`src/templates.ts`) is removed.
- `setup-machine.md` §1–2 collapse into one step: run `susentorno create-host-network` from an Administrator PowerShell. The existing "One host IP, used everywhere" and "Two host addresses, only one stable" callouts are unaffected — they describe the host IP's role elsewhere in the system, not how it's created. `delete-host-network` is documented as the reset path.
- `setup-environment.md` loses its "if this is the first environment you've set up on this machine, also open the host firewall now" callout entirely — firewall setup has no per-environment trigger anymore. It also loses its separate manual `New-NetFirewallRule` block for SMB (445) under "Enable shared drives": that block was already redundant with (and inconsistently scoped compared to — no `-LocalAddress`, no NAT-adapter half) the SMB rule `host-allow-vm-inbound.ps1` created; now that `create-host-network` is the single, correctly-scoped source of that rule, the duplicate manual block is removed rather than left as a confusing second path.
- `src/commands/init.ts` drops its printed `(Windows) admin PowerShell: powershell -File .susentorno/proxy/host-allow-vm-inbound.ps1` next-step line.
- `verify-proxy.ps1`'s references to `host-allow-vm-inbound.ps1` (WARN hint text and explanatory comments) are updated to point at `susentorno create-host-network`; its rule-matching logic is unaffected since the same fixed `DisplayName`s are preserved by default (an isolation-named network is never what `verify-proxy.ps1` checks — it always verifies the default, production names).

## Out of scope

- **A VM-attachment guard before switch deletion.** `Remove-VMSwitch` already fails on its own if a VM's network adapter is currently connected to the switch being removed — that natural Hyper-V error propagates as a normal step-4 failure. No separate pre-check is added.
- **General multi-network support.** `--isolation-name` exists for test sandboxing; nothing else in the system (run-hosting, guest setup) is parameterized to address a non-default host network.
- **Changing what the firewall rules allow.** This design changes *who creates* the rules and *how cleanly they can be torn down*, not their scope or the ports/protocols they admit — that remains exactly what `host-allow-vm-inbound.ps1` already enforces, per [ADR-0003](../../adr/0003-transparent-interception-and-network-isolation-boundary.md).

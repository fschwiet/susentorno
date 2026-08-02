# Rename `run-proxy` to `run-hosting`

## Purpose

`run-proxy` has grown well beyond running a proxy: it owns the Envoy container lifecycle, DNS/DHCP for the guest network, credential rotation for Claude and Codex, host-run MCP server processes, blue/green config swaps, log streaming, and abnormal-exit alerting. `run-hosting` names what the command actually is — the single foreground process that hosts everything an isolated environment's guest depends on — without implying it's just a proxy launcher.

This is a rename plus one small, related firewall simplification surfaced while touching the affected script; it introduces no new behavior otherwise.

## Scope

Renamed, in full, with no back-compat alias — consistent with this repo's existing practice of clean renames (`vm-shared` → `vm-shared-linux`, `configamatron` → `susentorno`):

- The CLI command itself (`run-proxy` → `run-hosting`).
- Source code: files, directories, types, functions, and log-message prefixes.
- Tests referencing the command.
- User-facing docs (README and the setup/diagnostics docs).
- The two ADRs whose titles/filenames embed the old name, plus prose in ten others that mention it.
- The dedicated node.exe copy's filename (decoupled naming, see below) and the firewall rules scoped to it.

**Explicitly not renamed** — these are distinct, unrelated concepts that happen to share the word "proxy":

- The **"Proxy stack"** domain term in `CONTEXT.md` (the network boundary concept — DNS, DHCP, Envoy, credential injection, MCP routing — as experienced by a guest). This term is correct as-is and outlives any particular command name.
- The `tests/proxy-stack/` test directory and `vitest.proxy-stack.config.ts` — named after the domain term above, not the command.
- `tests/checkNoRunningProxy.ts` — checks that no Envoy container is running, independent of which command started it.
- `docs/honist-v/plans/*.md` — timestamped historical implementation-plan records, treated like commit messages rather than living reference docs. Not rewritten.

## Rename surface

**Source code:**

- `src/commands/runProxy.ts` → `src/commands/runHosting.ts`; `registerRunProxy` → `registerRunHosting`; the registered command string `'run-proxy'` → `'run-hosting'`.
- `src/runProxy/` directory → `src/runHosting/` (all 37 files move; the one file whose name itself embeds "Proxy", `runProxyLoop.ts`, is renamed to `runHostingLoop.ts`).
- Types/functions embedding the name: `RunProxyOptions` → `RunHostingOptions`, `RunProxyDeps` → `RunHostingDeps`, `runProxyLoop` → `runHostingLoop`, and any other identifier following the same pattern.
- Console log/error message prefixes: every `run-proxy: ...` string (gateway/DNS/DHCP startup lines, error paths, the `uncaughtException`/`unhandledRejection` handlers, etc.) → `run-hosting: ...`.

**Tests:** `tests/unit/commands/runProxy.test.ts` → `runHosting.test.ts`; update incidental `run-proxy`/`runProxy` string references in the other test files that invoke or describe the command (string substitutions, not structural renames).

**Docs:** `README.md`, `setup-environment.md`, `setup-guest.md`, `setup-machine.md`, `diagnostics.md` — replace `run-proxy`/`susentorno run-proxy` references with `run-hosting`/`susentorno run-hosting`, including the manual firewall-rule fallback snippet in `setup-guest.md` (display-name text only — that snippet's own mechanism is unrelated to the merge below).

**ADRs:**

- Rename `0008-run-proxy-owns-proxy-lifecycle.md` → `0008-run-hosting-owns-hosting-lifecycle.md`.
- Rename `0019-run-proxy-speaks-on-abnormal-exit.md` → `0019-run-hosting-speaks-on-abnormal-exit.md`.
- Update prose mentions of `run-proxy` in: 0003, 0004, 0005, 0007, 0009, 0010, 0011, 0012, 0014, 0020.

No changes needed to `CONTEXT.md` — it never named the command directly, only the "Proxy stack" domain concept, which is unaffected.

## Dedicated node.exe rename + firewall rule merge

**File rename:** the dedicated node.exe copy at `%USERPROFILE%\.susentorno-host\run-proxy-node.exe` is renamed to `node-copy-with-custom-firewall-rules.exe` — a self-documenting name decoupled from the CLI command, so a future command rename won't require touching it again. Update:

- `getDedicatedNodePath()` in `relaunchViaDedicatedNode.ts` (the path constant).
- The embedded `README_CONTENT` text written alongside the copy, describing what it is and that deleting it is safe.
- The mirrored `Get-DedicatedNodePath` function in `verify-proxy.ps1`.

**Firewall rule merge in `host-allow-vm-inbound.ps1`:** today this script creates two parallel rule sets for the same three port groups — one unrestricted-by-program set (`susentorno Envoy Proxy (VM inbound)` TCP 80/443, `susentorno DNS stub (VM inbound)` UDP 53, `susentorno DHCP (VM inbound)` UDP 67) and a second, separately-named, program-scoped set for the dedicated node.exe copy. Since the dedicated copy is the *only* process that ever binds these ports on the Internal-switch adapter, the second set is redundant. Fold `-Program $nodePath` directly into the three existing rules and delete the separate program-scoped rule set entirely — six `New-NetFirewallRule` calls become three. This also tightens the firewall slightly: only the dedicated copy (not "any program") can use these ports on this adapter going forward. The SMB rule is untouched — it's a different program (the OS's own SMB server), unrelated to this merge. The header comment explaining the Windows firewall-dialog-preemption rationale is rewritten to describe one merged rule set instead of two.

**`verify-proxy.ps1` updates to match:**

- Fold `Program = $nodePath` into the `'TCP 80/443'`, `'DNS 53'`, `'DHCP 67'` `Test-RuleSet` expected tuples, flipping their `Program` expectation from "must be unrestricted" (`$null`) to "must be scoped to the dedicated copy."
- Delete the now-redundant fourth `Test-RuleSet` call, currently labeled `'run-proxy node.exe'`.
- Update the "stale prompt-generated rule" check's `Get-DedicatedNodePath` call to the new filename.

## Manual follow-up (after this change lands)

This only affects your one machine's existing state, and is not automated as part of this change — a reminder to do by hand:

1. Re-run `host-allow-vm-inbound.ps1` (as admin) to create the new merged, renamed rules.
2. Manually remove the old `"susentorno run-proxy node (VM inbound)"` firewall rule (the pre-merge, program-scoped one) — it's now orphaned and unused.
3. Manually delete the orphaned `%USERPROFILE%\.susentorno-host\run-proxy-node.exe` and its `readme.txt`, once `node-copy-with-custom-firewall-rules.exe` exists in its place.

## Testing

This is a rename plus a firewall-rule consolidation, not new runtime behavior:

- The existing unit test suite covering the renamed module (`runHostingLoop` and friends) continues to exercise the same logic under new names — a rename doesn't require new test cases, just updated names/paths in existing ones.
- `pnpm build`/typecheck, plus this repo's existing PowerShell syntax linting, catch any missed reference or syntax error introduced by the file moves and the two edited `.ps1` scripts.
- The firewall rule merge itself has no automated coverage (it requires a real Windows host with a Hyper-V Internal-switch adapter, which CI doesn't have) — `verify-proxy.ps1`, run manually per the existing convention, is the verification path, and is updated above to check the merged rule shape.

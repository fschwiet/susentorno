# Preparing susentorno for a real-Hyper-V guest test tier

## Purpose

The `guest` test tier boots a QEMU/KVM Ubuntu guest inside WSL2 ([ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md)). A follow-on project ("spec 2" throughout this document) will replace that harness with real Hyper-V VMs, so the tier exercises the production network path instead of substituting for it. This design covers only the **product changes that must land first** — it does not build, change, or retire any test harness.

Three changes travel together here because spec 2 needs all three and none of them is harness code:

| Change | Why spec 2 needs it |
| --- | --- |
| `run-hosting --isolation-name` | `run-hosting` must bind the sandboxed `susentorno-test-internal` adapter, not the developer's real one |
| `setup-guest-unix` answer flags | Its end-to-end test invokes the real command and cannot answer interactive prompts |
| Trimming the Linux guest templates | Otherwise that test installs the .NET SDK, VS Code, and four extensions over the network on every run |

Each is independently worthwhile: the first two remove a flag that produces a worse result than its replacement and a flag whose derivation the codebase already distrusts; the third stops shipping one developer's tooling preferences to every user.

### Direction this prepares for, not decided here

Spec 2's shape was settled during this design's interview and is recorded here as motivation only — no ADR in this changeset records it as decided, because it is not yet built:

- The Hyper-V guest tier pursues **fidelity**, not merely a QEMU-to-Hyper-V port. The concrete goal is to drop `--no-forward` from the suite's `run-hosting` invocation (`tests/proxyStack.ts:157`), which today disables the gateway forwarder, the DNS responder, and the DHCP server in one flag (`runHosting.ts:194`, `:222`) while WSL's `dnsmasq` and `socat` stand in for all three.
- The disposable guest comes from an **automated golden VHDX** built by an unattended Ubuntu Server autoinstall, with per-test guests as differencing VHDXs.
- Phase-by-phase tests drive the **orchestration modules** (`mountShare`, `runPreScripts`, `isolateVmToSwitch`, `runPostScripts`) so they can assert intermediate state; a single **end-to-end test drives the real `setup-guest-unix`** using the flags added here.
- The suite creates and destroys its **own SMB share account** rather than requiring a manual prerequisite.

[ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md) is deliberately **not** amended by this changeset. It still accurately describes the tier that exists today; superseding it belongs to spec 2, when there is an implemented decision to record rather than an intention.

## Scope

Three product changes, their tests, and the documentation and ADR updates they force. No test-harness work. `pnpm test` — including the existing WSL2 `guest` tier — must be green when this lands; that tier is not retired until spec 2.

Explicitly **not** in scope, each considered and declined during design (see "Considered and rejected"): a `--non-interactive` mode, an SSH key-auth preflight probe, any persistent SMB-password channel (file or environment variable), and any change to `templates/vm-shared-windows/`.

## 1. `run-hosting --isolation-name <name>`

### Flag surface

`--isolation-name <name>` is added. `--forward-listen <ip>` is **removed**. `--no-forward` is unchanged.

Passing `--isolation-name` together with `--no-forward` is an error that sets `process.exitCode = 1` and returns, matching this project's convention throughout `src/commands/*.ts`. `--no-forward` disables the gateway's non-loopback listener, the DNS responder, and the DHCP server — the only three consumers of the resolved address — so the combination has no coherent meaning. Failing loudly is required rather than preferred: this is a flag whose entire job is to select which adapter gets bound, and silently ignoring it would produce a `run-hosting` that looks configured for a sandbox but is serving the default network.

### Resolution

A new pure function turns the optional isolation name into a resolved network. It lives in a **new module** (`src/runHosting/isolationNetwork.ts`), not in `forwarder.ts`: `hostNetworkNames.ts:2` already imports `DEFAULT_INTERNAL_SWITCH_ADAPTER` from `forwarder.ts`, so a resolver in `forwarder.ts` importing `resolveHostNetworkNames` back would create an import cycle. A new module importing both, imported by neither, has no cycle.

```
isolationName given   ──►  resolveHostNetworkNames(name).adapterAlias
                             // "vEthernet (susentorno-test-internal)"
isolationName absent  ──►  DEFAULT_INTERNAL_SWITCH_ADAPTER
                             // "vEthernet (susentorno-internal)"
                                        │
                                        ▼
                      resolveInternalSwitchNetwork(alias, interfaces)
                                        │
                                        ▼
                      { adapterAlias, address, netmask } | null
```

It takes an injectable `networkInterfaces()` exactly as `resolveForwardListenAddress` and `resolveInternalSwitchNetwork` already do, which is what makes it unit-testable — the command action around it is not.

Name validation is inherited, not re-implemented: `resolveHostNetworkNames` (`src/hostNetwork/hostNetworkNames.ts`) already enforces `ISOLATION_NAME_RE` and throws `HostNetworkError`. Both commands **catch `HostNetworkError` at the command boundary**, print its message, set `process.exitCode = 1`, and return — matching `createHostNetwork.ts:77-97` and `deleteHostNetwork.ts:35-66`. This is required, not stylistic: in `run-hosting` an escaping throw would enter the abnormal-exit machinery ([ADR-0019](../../adr/0019-run-hosting-speaks-on-abnormal-exit.md)) and report a typo'd flag as a crash; in `setup-guest-unix` it would escape the action handler entirely. `run-hosting` does not interpolate the name into wildcard-tolerant PowerShell queries the way `create-host-network` does, so the regex is stricter than `run-hosting` alone requires — that is deliberate. Two commands disagreeing about what a valid isolation name is would be a worse defect than an unnecessarily narrow character set.

### What this deletes

Today the address and the netmask are resolved **separately**. `runHosting.ts:195` resolves an address (possibly from `--forward-listen`), and `:240-241` re-resolves the network and guards with:

```ts
const network = resolveInternalSwitchNetwork();
const netmask = network?.address === dnsIp ? network.netmask : '255.255.255.0';
```

That guard is reachable for two reasons: `--forward-listen` can name an address belonging to no resolvable adapter, and — even without the flag — the two calls are independent `networkInterfaces()` snapshots, so the second can return `null` or a different first IPv4 after the first succeeded. Either way DHCP hands every guest a **guessed** `/24`.

Removing the flag alone is therefore *not* what closes this. **Consolidating to a single `resolveInternalSwitchNetwork(alias)` call** whose address and netmask both feed the downstream code is what makes the fallback unreachable, and removing the flag is what makes that consolidation possible. Both must happen; the spec treats them as one change. This is a correctness improvement, not tidying.

### Error handling

The adapter-not-found path (`runHosting.ts:196-201`) currently advises "Pass `--forward-listen <ip>`, or `--no-forward` to disable forwarding." Neither remains useful — the overwhelmingly likely cause is that the switch was never created. It becomes a message that names the alias it looked for and points at `susentorno create-host-network`, echoing `--isolation-name <name>` back when one was given.

The DNS and DHCP bind-failure messages (`:234`, `:253`) are unchanged. They already explain their specific failure well, and their causes are unrelated to adapter resolution.

### Blast radius

Source: `src/commands/runHosting.ts` — the options interface (`:51-52`), flag registration (`:121-125`), and the two `if (options.forward)` blocks (`:194`, `:222`) — plus the new `src/runHosting/isolationNetwork.ts`.

Tests: `tests/unit/commands/runHosting.test.ts` inspects the registered Commander options directly (it already asserts the absence of the removed `--forward-ports`), so it gains the equivalent assertions for `--forward-listen` and `--isolation-name`.

Docs: `--forward-listen` appears in three live places — `setup-environment.md:12`, `setup-machine.md:9`, and [ADR-0019](../../adr/0019-run-hosting-speaks-on-abnormal-exit.md)`:21`, whose accepted consequence lists "unresolvable forward-listen IP" among the failures `run-hosting` reports on abnormal exit. That failure mode survives the change (an isolation name can still resolve to no adapter), so the ADR needs its wording updated, not its decision revisited. No test or script references the flag.

## 2. `setup-guest-unix` answer flags and `--isolation-name`

### Flag surface

| Flag | Suppresses prompt | Value when neither flag nor answer is given |
| --- | --- | --- |
| `--vm-name <name>` | `:109` "Hyper-V VM name" | prompts |
| `--guest-address <host>` | `:125` "Guest address (hostname or IP)" | prompts |
| `--guest-username <user>` | `:126` "Guest username" | prompts |
| `--share-name <name>` | `:127` "SMB share name" | prompts, default `vm-shared-linux` |
| `--share-account <name>` | `:128` "Share account name" | prompts, default `susentorno-share` |
| `--isolation-name <name>` | — (replaces `--adapter-alias`) | the unnamed `susentorno-internal` network |
| `--nat-adapter-alias <name>` | — (unchanged) | `vEthernet (Default Switch)` |

Each flag suppresses **only its own** prompt; anything absent still prompts, in today's order. There is no all-or-nothing mode.

**Prompt staging is preserved exactly.** Today the answers are gathered in two stages either side of preflight: the VM name is prompted at `:109`, `runPreflightChecks` runs at `:111`, and the remaining five are prompted at `:125-129` only after it succeeds. That ordering is deliberate — a bad VM name or a missing switch fails before the user types five more answers — so flag resolution must not collapse into a single up-front gather. The answer-resolution function is therefore **called twice**, once per stage, rather than once for all six.

The SMB share password (`:129`, `promptMasked`) is **always prompted** — never a flag, never a file, never an environment variable. Automation answers it by piping one line into the process's stdin. [ADR-0022](../../adr/0022-promptmasked-releases-stdin-explicitly.md) establishes that this works against this repo's own `promptMasked` — its unit tests inject non-TTY `PassThrough` streams and the CLI tests pipe answers into a spawned child via `execa(..., { input: '...\n' })` — and that this exact property is what disqualified `@clack/prompts`.

### Name resolution, and the derivation it inverts

`--isolation-name` feeds `resolveHostNetworkNames`, which yields both `adapterAlias` and `switchName` from one authoritative source.

Today those two travel separately and in the opposite direction. The command accepts an adapter alias, and `preflightChecks.ts:26` recovers the *switch* name from it by stripping `vEthernet (` and `)` via `deriveSwitchName`. The 2026-08-06 design that introduced this calls the relationship "a naming convention, not a guaranteed-durable identity," which is why `:27-31` must guard against an alias that doesn't parse and why `:64` phrases its failure as "derived switch name '<name>' (from '<alias>')". With both names produced by `resolveHostNetworkNames` they cannot disagree, so the internal-switch half of that guard is **deleted** rather than left unreachable; the NAT half stays.

`deriveSwitchName` does **not** become dead code. It is still required for the NAT side (`vEthernet (Default Switch)` → `Default Switch`), and `resolveHostNetworkNames` itself uses it to derive the base name from `DEFAULT_INTERNAL_SWITCH_ADAPTER`.

`PreflightOptions` (`src/guestSetup/preflightChecks.ts:13-19`) therefore changes shape: `adapterAlias: string` becomes the pair `internalAdapterAlias: string` and `internalSwitchName: string`, both supplied by the caller. Inside `runPreflightChecks`, the `deriveSwitchName` call and its failure branch survive for `natAdapterAlias` only. The switch-existence loop (`:56-67`) still checks **both** switches against real Hyper-V and keeps its full value — it is what catches "you never ran `create-host-network`" before a VM is stopped — but the internal-switch message no longer claims the name was derived from an alias.

`resolveGuestNetwork` (`src/commands/setupGuestUnix.ts:46-62`) takes the isolation name instead of an adapter alias, resolving the alias internally. Its injectable `interfaces` parameter is retained.

### Error handling

`setupGuestUnix.ts:53`'s hint ("Pass `--adapter-alias`, or complete setup-machine.md first") becomes a pointer to `susentorno create-host-network`, echoing `--isolation-name <name>` back when one was given — the same treatment as `run-hosting`'s equivalent message, so both commands fail identically for the same underlying cause. No other failure path in the command changes.

### Breaking change

`--adapter-alias` is removed, not deprecated. A hand-made Internal switch whose name does not follow `susentorno-<name>-internal` becomes unsupported — the same trade accepted in removing `--forward-listen`, and consistent with it. `--nat-adapter-alias` is untouched; the Default Switch is a shared Windows object this project neither creates nor names.

### Guest-side preconditions (documentation only)

A flag-driven run is unattended only if the guest never prompts. Two things are required, and neither is enforced by this design:

1. **Key-based SSH auth.** `createSshRemoteExec` spawns a fresh `ssh` or `scp` with `stdio: 'inherit'` for every remote command. A single run makes roughly twenty of them — `ensureKvpDaemon` 1, `mountShare` ~8, pre-scripts ~4, `mountShare` again after isolation ~8, post-scripts ~2 — each prompting for the guest password without a key.
2. **Passwordless sudo.** `buildSshRunArgv` passes `-t`, so every remote command gets a fresh pty, and sudo's per-tty credential timestamp never carries from one invocation to the next. Nearly every remote step uses sudo.

`setup-guest.md` currently presents key auth as "optional but recommended." It gains a note that key auth **and** passwordless sudo together are what make a flag-driven run unattended. This is documentation only — no probe, no enforcement, no breaking change. Spec 2's test guest satisfies both by construction, exactly as today's QEMU harness already does (`tests/guest/harness/seed/user-data` sets `sudo: ALL=(ALL) NOPASSWD:ALL`).

## 3. Trimming the Linux guest templates

### What is kept, and why

Only what a guest requires to function as a susentorno guest:

| File | Kept | Removed |
| --- | --- | --- |
| `01-apt-packages.sh` | `apt update`, `apt upgrade -y`, then `curl`, `git`, `jq`, `gh` | `okular`, `build-essential` |
| `02-install-pnpm.sh` | the pnpm install | `dotnet-sdk-10.0` |
| `03-install-tools.sh` | `pnpm runtime set node latest -g`; the Claude, Codex, and Pi agent installs | `snap install code`, `dotnet-outdated-tool`, `csharpier`, the `~/.bashrc` dotnet PATH block |
| `04-configure-tools.sh` | — | **deleted outright** |
| `nn-configure-network.sh` | unchanged logic | — |
| `post-scripts/01-auth-config.sh` | unchanged | — |
| `post-scripts/02-apply-home-jq-transforms.sh` | unchanged | — |
| `home-jq-transforms/vscode-settings.jq` | — | **deleted**, with its `manifest.yaml` entry |

Three retentions need justification because they are not obviously load-bearing:

- **`gh`** is required by `01-auth-config.sh`, which runs `gh auth login --with-token` and `gh auth setup-git`; **`jq`** by the home settings transforms.
- **pnpm** survives solely as the vehicle for `pnpm runtime set node latest -g`. The guest needs node because `02-apply-home-jq-transforms.sh` runs `apply-home-jq-transforms.mjs`.
- **The three agent installs** stay because each has a first-class host credential channel and placeholder mount in the product ([ADR-0002](../../adr/0002-credential-injection-at-proxy.md), [ADR-0018](../../adr/0018-pi-agent-reuses-codex-placeholder-literal.md)). Shipping credential injection for an agent the templates do not install would be incoherent.
- **`apt upgrade -y`** stays. It is slow and it is the single largest cost in spec 2's end-to-end test, which makes it tempting to drop here — but it is a legitimate step in setting up a real user's guest, and removing it to speed up a test that does not yet exist would be the wrong reason. Spec 2 may revisit it with evidence; this changeset does not.

`04-configure-tools.sh` is deleted rather than emptied: every line in it is preference — four named VS Code extensions, GNOME screensaver `gsettings`, `codebase-memory-mcp`, and context7 MCP wiring for both Claude and Codex. Removing the `~/.bashrc` dotnet PATH block also removes the hardcoded `/home/username/.dotnet/tools` path at `03-install-tools.sh:19`, a latent bug for any guest whose user is not named `username`.

### The VS Code home settings transform goes too

`templates/home-jq-transforms/vscode-settings.jq` and its `manifest.yaml:4-6` entry are deleted. The transform sets `files.autoSave`, `editor.formatOnSave`, `chat.disableAIFeatures`, and `editor.defaultFormatter` to `esbenp.prettier-vscode` and `csharpier.csharpier-vscode`. Leaving it would ship settings configuring formatters for two extensions this changeset stops installing, in an editor it stops installing — actively incoherent on Linux the moment the trim lands, and a violation of the new ADR by a file the rest of section 3 never touches.

It is preference by the same test as everything else removed here, and it goes to user customizations with them. `home-jq-transforms/` is a shared folder rather than part of `vm-shared-windows/`, but the deleted manifest entry carries a `windows:` target as well as a `linux:` one, so this does reach the Windows guest. That is deliberate and is the one place this changeset touches Windows behavior: splitting the entry to keep a Windows-only half would leave a transform naming extensions only the Windows templates install, which is a worse thing to hand to the later Windows cleanup than a clean deletion.

`claude-onboarding.jq` and `pi-openai-codex-auth.jq` stay — both configure agents the templates still install, against credential channels the product owns.

Test fallout, all of which uses `vscode-settings.jq` as a convenient stand-in for "some transform" rather than testing it specifically, so each needs re-pointing at a surviving transform rather than deleting:

- `tests/unit/templates.test.ts:40` lists it in the expected template inventory → removed; `:185-204`'s manifest/`.jq` consistency test then covers two entries instead of three.
- `tests/cli/updateShares.test.ts:41` asserts `update-shares` output contains `vscode-settings.jq`, and `:73` writes deliberately invalid jq into it to test the error path.

`templates/vm-shared-windows/` is otherwise **untouched** in this changeset.

### Renumbering fallout

`renumber()` (`src/weaveScripts.ts:117-127`) assigns prefixes sequentially by index, and `compareScripts` sorts the `nn` sentinel last. With four built-in Linux pre-scripts today, `nn-configure-network.sh` weaves out as `05-configure-network.sh`. With three, it becomes **`04-configure-network.sh`**. Windows keeps four built-ins and stays `05-`, so the platforms legitimately diverge.

Production code is already immune — `runPreScripts.ts:20` matches the slug `configure-network`, never the number. Only documentation, echo strings, and tests hardcode it:

- `setup-guest.md:158` and `:205` → `04-`. `setup-guest.md:200` is the Windows path and correctly **stays** `05-`.
- `templates/vm-shared-linux/verify-config.sh:93` → `04-`.
- `tests/cli/init.test.ts:33` asserts the woven `05-configure-network.sh` exists.
- `tests/cli/updateShares.test.ts:101-106` weaves a custom script and asserts `05-docker.sh` and `05-configure-network.sh`; both shift by one built-in.
- `tests/guest/guest.test.ts:154,233,459` invoke the literal path; `:156` **and `:461`** each assert `toContain('05-configure-network:')`.
- `tests/unit/initEnv.test.ts:49-50` lists `05-configure-network.sh` in the expected woven inventory → `04-`.
- `tests/unit/templates.test.ts:20-24` lists `04-configure-tools.sh` in `expectedTemplateFiles`, which must drop with the file; `:174`'s test title ("ubuntu 05-configure-network leaves addressing and DNS to DHCP") is coupled to the old number, though the body reads the `nn-` source path and is otherwise unaffected.

`tests/unit/guestSetup/listScripts.test.ts` and `tests/unit/guestSetup/runPreScripts.test.ts` reference these names too, but as **synthetic fixtures** in their own temp directories — they are unaffected and must not be "fixed."

### Removing the number from the script's own output

`nn-configure-network.sh` hardcodes the woven number in two different kinds of string, which need different treatments:

- **Log prefixes** at `:26`, `:58`, `:60`, `:75` — `echo "05-configure-network: ..."` becomes `echo "configure-network: ..."`. `tests/guest/guest.test.ts:156` and `:461` follow.
- **The usage string** at `:9` — `host_ip="${1:?usage: 05-configure-network.sh <host-ip> [cert-path]}"`. A bare `configure-network:` prefix would be wrong here, since this line names a *file* the user is meant to invoke. It becomes `usage: $(basename "$0") <host-ip> [cert-path]`, which prints whatever number weaving actually assigned and so stays correct permanently.

This is in scope rather than gratuitous: the same lines are already being edited for the renumber, and it removes the coupling permanently. Spec 2's rewritten tests then never depend on how many built-in scripts ship. The Windows `nn-configure-network.ps1` has the same defect at `:9`, `:29`, `:35`, but is left alone with the rest of `vm-shared-windows/`.

## Verification

### Where the new logic is tested

Both commands gate on conditions a test cannot fake — `setup-guest-unix` calls `isElevated()` before anything else and then immediately touches Hyper-V — so no tier can drive either flow end to end. The testable seams must therefore be pure functions, which is the pattern the repo already uses.

| Tier | Coverage |
| --- | --- |
| `unit` | The new isolation-name resolver in `forwarder.ts`: named and unnamed cases, an invalid name propagating `HostNetworkError`, and an adapter present with no IPv4 |
| `unit` | `resolveGuestNetwork` taking an isolation name; existing tests adjusted |
| `unit` | A pure answer-resolution function with injected prompt callbacks, covering all six answers — the five flag-backed ones falling back to prompts, and the always-prompted password. This is what makes per-flag suppression testable at all, given the elevation gate |
| `unit` | `runPreflightChecks` with the new `internalAdapterAlias`/`internalSwitchName` pair |
| `unit` | The Commander option surface, in the two existing suites that already inspect it directly: `tests/unit/commands/runHosting.test.ts` (add `--forward-listen` absent, `--isolation-name` present) and `tests/unit/commands/setupGuestUnix.test.ts:17-28` (currently asserts `--adapter-alias` and its default — rewritten for the new flag set) |
| `cli` | `tests/cli/setupGuestUnix.test.ts:20-31` currently passes `--adapter-alias does-not-exist-adapter` and asserts the old adapter-resolution message. Commander would reject the removed option before the asserted behavior, so this test is rewritten around `--isolation-name` and the new `create-host-network` hint |
| `host-network` | After `create-host-network --isolation-name test`, resolving the derived alias returns that switch's real address **and netmask** — the only exercise of alias-to-real-adapter against Windows rather than a fixture |

What remains uncovered: `run-hosting` actually binding `:53`/`:67` on the sandbox adapter. That is spec 2's work, and this spec does not imply otherwise.

### Regression surface

Beyond the renumbering fallout listed above, `pnpm test` must be green end to end, including the existing WSL2 `guest` tier. That tier's `tests/guest/harness/seed/user-data` installs `nodejs` directly because the suite runs `nn-configure-network.sh` without running `01`–`03`, so the template trim does not affect the harness image.

## Documentation and records

| File | Change |
| --- | --- |
| `setup-environment.md:12` | Drop the `--forward-listen` reference |
| `setup-machine.md:9` | Drop the `--forward-listen` reference |
| `setup-guest.md:158`, `:205` | `05-` → `04-` (Linux); `:200` unchanged (Windows) |
| `setup-guest.md:111-118` | Currently shows the bare `susentorno setup-guest-unix` and states it prompts for every answer. Document the new flags here — the unattended note below is not actionable without them |
| `setup-guest.md` | Note that key-based SSH auth **and** passwordless sudo are what make a flag-driven run unattended |
| `CONTEXT.md` | Add the **Isolation name** domain term |
| ADR-0019`:21` | Reword "unresolvable forward-listen IP" — the failure mode survives, the flag does not |
| ADR-0023 | Add a consequence: the concept now spans `run-hosting` and `setup-guest-unix` |
| New ADR | Shipped guest templates contain only what a susentorno guest requires |

**Isolation name** (`CONTEXT.md`, under "Network policy"): *The name that selects which parallel host network susentorno's commands act on — the Internal switch and its firewall rules — so a sandboxed installation can coexist with the default one on the same machine. Omitting it selects the unnamed default.* _Avoid_: sandbox name, test name.

The definition is deliberately confined to the host network, which is all the term scopes once this changeset lands. Spec 2 may extend it to the SMB share account and guest VM names; if it does, it amends this definition then. Writing the broader meaning now would record an intention as domain truth, the same error this design avoids with ADR-0010.

The new ADR must state the rule *and* name `templates/vm-shared-windows/` as a known, deliberate exception with the same treatment intended later. Without that, it is a rule the repository violates on the day it is written. It complements [ADR-0013](../../adr/0013-user-customizable-committable-environment.md), which established that environments are user-customizable and committable, by stating what belongs on which side of that line.

## Considered and rejected

**A `--non-interactive` mode for `setup-guest-unix`.** With five answer flags, the only remaining prompt is the password, which automation already answers by piping stdin — so the mode would add a guard, not a capability. Rejected as speculative: it has one hypothetical consumer. The cost accepted is that a mistyped flag makes an automated run block on a prompt until its timeout rather than failing fast; that is a small addition later if a second consumer appears.

**An SSH key-auth preflight probe.** Proposed to fix the roughly twenty password prompts per run, then withdrawn on discovering it would not: `-t` gives every remote command a fresh pty, so sudo's per-tty timestamp re-prompts regardless, trading twenty SSH prompts for twenty sudo prompts. The real fix is guest-side configuration, which spec 2's image provides and this design documents.

**SSH connection multiplexing** (`ControlMaster`/`ControlPath`/`ControlPersist`) to authenticate once per run. Rejected as unavailable on Windows: Win32-OpenSSH issue #405 has been open since 2016, still labelled "0 - Backlog / Issue-Enhancement". Worth a brief spike during implementation to confirm, but not designed around.

**A persistent SMB password channel** — `--share-password-file <path>` or a `SUSENTORNO_SHARE_PASSWORD` environment variable. Both were proposed against a misread requirement (retyping *between* runs). The password is prompted once per run already (`:129`, passed into both `mountShare` calls), so neither solves a real problem, and each adds a place for a secret to live. The environment variable is the worse of the two on Windows, where a process's environment is readable by anything running as the same user and where it tends to become permanent in a shell profile.

**Trimming `templates/vm-shared-windows/` in this changeset.** Deferred at the user's request. The Windows guest path is covered by no test tier and will not be by spec 2, so the trim would be unverifiable beyond review — and a Windows guest may enter the test mix later, which would change what "required" means there.

**Amending ADR-0010 now.** It accurately describes the tier that exists today. Amending it before spec 2 is implemented would record an intention as a decision.

**Splitting the template trim into its own spec.** Considered — the three changes have no implementation dependency on each other beyond all being spec 2 prerequisites, and together they touch command behavior, orchestration types, templates, four test tiers, documentation, and ADRs. Declined: the trim is mostly deletion, and a separate brainstorm-plan-implement cycle for it would cost more than it saves. The implementation plan should still sequence the three as independent phases, each landing green on its own, so the grouping is a spec-level convenience and not a single large commit.

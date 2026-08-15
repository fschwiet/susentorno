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

A new pure function in `src/runHosting/forwarder.ts` turns the optional isolation name into a resolved network:

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

Name validation is inherited, not re-implemented: `resolveHostNetworkNames` (`src/hostNetwork/hostNetworkNames.ts`) already enforces `ISOLATION_NAME_RE` and throws `HostNetworkError`. `run-hosting` does not interpolate the name into wildcard-tolerant PowerShell queries the way `create-host-network` does, so the regex is stricter than `run-hosting` alone requires — that is deliberate. Two commands disagreeing about what a valid isolation name is would be a worse defect than an unnecessarily narrow character set.

### What this deletes

Today the address and the netmask are resolved **separately**. `runHosting.ts:195` resolves an address (possibly from `--forward-listen`), and `:240-241` re-resolves the network and guards with:

```ts
const network = resolveInternalSwitchNetwork();
const netmask = network?.address === dnsIp ? network.netmask : '255.255.255.0';
```

That guard exists only because `--forward-listen` can name an address belonging to no resolvable adapter, in which case DHCP hands every guest a **guessed** `/24`. With one `resolveInternalSwitchNetwork(alias)` call feeding both the gateway listen address and the DHCP netmask, the guess disappears and both values provably originate from the same real adapter. This is a correctness improvement, not tidying: removing `--forward-listen` is what makes the fallback unreachable, so the fallback goes with it.

### Error handling

The adapter-not-found path (`runHosting.ts:196-201`) currently advises "Pass `--forward-listen <ip>`, or `--no-forward` to disable forwarding." Neither remains useful — the overwhelmingly likely cause is that the switch was never created. It becomes a message that names the alias it looked for and points at `susentorno create-host-network`, echoing `--isolation-name <name>` back when one was given.

The DNS and DHCP bind-failure messages (`:234`, `:253`) are unchanged. They already explain their specific failure well, and their causes are unrelated to adapter resolution.

### Blast radius

`src/commands/runHosting.ts` only: the options interface (`:51-52`), flag registration (`:121-125`), and the two `if (options.forward)` blocks (`:194`, `:222`). Outside the source, `--forward-listen` appears in exactly two prose sentences — `setup-environment.md:12` and `setup-machine.md:9` — and in no test or script.

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

Three retentions need justification because they are not obviously load-bearing:

- **`gh`** is required by `01-auth-config.sh`, which runs `gh auth login --with-token` and `gh auth setup-git`; **`jq`** by the home settings transforms.
- **pnpm** survives solely as the vehicle for `pnpm runtime set node latest -g`. The guest needs node because `02-apply-home-jq-transforms.sh` runs `apply-home-jq-transforms.mjs`.
- **The three agent installs** stay because each has a first-class host credential channel and placeholder mount in the product ([ADR-0002](../../adr/0002-credential-injection-at-proxy.md), [ADR-0018](../../adr/0018-pi-agent-reuses-codex-placeholder-literal.md)). Shipping credential injection for an agent the templates do not install would be incoherent.
- **`apt upgrade -y`** stays. It is slow and it is the single largest cost in spec 2's end-to-end test, which makes it tempting to drop here — but it is a legitimate step in setting up a real user's guest, and removing it to speed up a test that does not yet exist would be the wrong reason. Spec 2 may revisit it with evidence; this changeset does not.

`04-configure-tools.sh` is deleted rather than emptied: every line in it is preference — four named VS Code extensions, GNOME screensaver `gsettings`, `codebase-memory-mcp`, and context7 MCP wiring for both Claude and Codex. Removing the `~/.bashrc` dotnet PATH block also removes the hardcoded `/home/username/.dotnet/tools` path at `03-install-tools.sh:19`, a latent bug for any guest whose user is not named `username`.

`templates/vm-shared-windows/` is **untouched** in this changeset.

### Renumbering fallout

`renumber()` (`src/weaveScripts.ts:117-127`) assigns prefixes sequentially by index, and `compareScripts` sorts the `nn` sentinel last. With four built-in Linux pre-scripts today, `nn-configure-network.sh` weaves out as `05-configure-network.sh`. With three, it becomes **`04-configure-network.sh`**. Windows keeps four built-ins and stays `05-`, so the platforms legitimately diverge.

Production code is already immune — `runPreScripts.ts:20` matches the slug `configure-network`, never the number. Only documentation, echo strings, and tests hardcode it:

- `setup-guest.md:158` and `:205` → `04-`. `setup-guest.md:200` is the Windows path and correctly **stays** `05-`.
- `templates/vm-shared-linux/verify-config.sh:93` → `04-`.
- `tests/cli/init.test.ts:33` asserts the woven `05-configure-network.sh` exists.
- `tests/cli/updateShares.test.ts:101-106` weaves a custom script and asserts `05-docker.sh` and `05-configure-network.sh`; both shift by one built-in.
- `tests/guest/guest.test.ts:154,233,459` invoke the literal path; `:156` asserts `toContain('05-configure-network:')`.
- `tests/unit/templates.test.ts` and `tests/unit/initEnv.test.ts` must be checked for template-file-list assertions.

`tests/unit/guestSetup/listScripts.test.ts` and `tests/unit/guestSetup/runPreScripts.test.ts` reference these names too, but as **synthetic fixtures** in their own temp directories — they are unaffected and must not be "fixed."

### Removing the number from the script's own output

`nn-configure-network.sh` prints `05-configure-network:` on five of its own lines (`:9`, `:26`, `:58`, `:60`, `:75`), hardcoding a prefix that *weaving* assigns and that the source file cannot know. Those become plain `configure-network:`, and `tests/guest/guest.test.ts:156` follows.

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
| `cli` | `--help` output for both commands: new flags present, `--forward-listen` and `--adapter-alias` absent. The only tier that sees the actual commander wiring |
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
| `setup-guest.md` | Note that key-based SSH auth **and** passwordless sudo are what make a flag-driven run unattended |
| `CONTEXT.md` | Add the **Isolation name** domain term |
| ADR-0023 | Add a consequence: the concept now spans `run-hosting` and `setup-guest-unix` |
| New ADR | Shipped guest templates contain only what a susentorno guest requires |

**Isolation name** (`CONTEXT.md`, under "Network policy"): *The single name that scopes every host artifact susentorno creates for one parallel installation — the Internal switch, its firewall rules, and (from the Hyper-V guest tier onward) the SMB share account and guest VM names — so one value makes the whole set discoverable and sweepable. Omitting it selects the unnamed default installation.* _Avoid_: sandbox name, test name.

The new ADR must state the rule *and* name `templates/vm-shared-windows/` as a known, deliberate exception with the same treatment intended later. Without that, it is a rule the repository violates on the day it is written. It complements [ADR-0013](../../adr/0013-user-customizable-committable-environment.md), which established that environments are user-customizable and committable, by stating what belongs on which side of that line.

## Considered and rejected

**A `--non-interactive` mode for `setup-guest-unix`.** With five answer flags, the only remaining prompt is the password, which automation already answers by piping stdin — so the mode would add a guard, not a capability. Rejected as speculative: it has one hypothetical consumer. The cost accepted is that a mistyped flag makes an automated run block on a prompt until its timeout rather than failing fast; that is a small addition later if a second consumer appears.

**An SSH key-auth preflight probe.** Proposed to fix the roughly twenty password prompts per run, then withdrawn on discovering it would not: `-t` gives every remote command a fresh pty, so sudo's per-tty timestamp re-prompts regardless, trading twenty SSH prompts for twenty sudo prompts. The real fix is guest-side configuration, which spec 2's image provides and this design documents.

**SSH connection multiplexing** (`ControlMaster`/`ControlPath`/`ControlPersist`) to authenticate once per run. Rejected as unavailable on Windows: Win32-OpenSSH issue #405 has been open since 2016, still labelled "0 - Backlog / Issue-Enhancement". Worth a brief spike during implementation to confirm, but not designed around.

**A persistent SMB password channel** — `--share-password-file <path>` or a `SUSENTORNO_SHARE_PASSWORD` environment variable. Both were proposed against a misread requirement (retyping *between* runs). The password is prompted once per run already (`:129`, passed into both `mountShare` calls), so neither solves a real problem, and each adds a place for a secret to live. The environment variable is the worse of the two on Windows, where a process's environment is readable by anything running as the same user and where it tends to become permanent in a shell profile.

**Trimming `templates/vm-shared-windows/` in this changeset.** Deferred at the user's request. The Windows guest path is covered by no test tier and will not be by spec 2, so the trim would be unverifiable beyond review — and a Windows guest may enter the test mix later, which would change what "required" means there.

**Amending ADR-0010 now.** It accurately describes the tier that exists today. Amending it before spec 2 is implemented would record an intention as a decision.

# Test tiers

Configamatron's automated tests are divided into four tiers: `unit`, `cli`,
`proxy-stack`, and `guest`. Each tier is named for the **highest observable
interface it crosses** — its _test surface_ — not for an amount of integration
or a ranking of importance. Naming by surface makes two things predictable: where
a new test belongs, and what a suite requires to run (so a prerequisite failure
is distinguishable from a product failure).

The tier names use the project's domain vocabulary (see [CONTEXT.md](../CONTEXT.md)).
In particular, `guest` names the domain actor whose behavior is observed, not the
mechanism used to run it.

| Tier | Package command | Directory | Vitest config | Observable surface |
| --- | --- | --- | --- | --- |
| `unit` | `pnpm test:unit` | `tests/unit/` | `vitest.config.ts` | In-process behavior through a module interface or an intentional internal seam |
| `cli` | `pnpm test:cli` | `tests/cli/` | `vitest.cli.config.ts` | The packaged CLI (`dist/cli.js`) and the filesystem artifacts it generates |
| `proxy-stack` | `pnpm test:proxy-stack` | `tests/proxy-stack/` | `vitest.proxy-stack.config.ts` | The live proxy stack (Docker + local upstream adapters), without entering a guest |
| `guest` | `pnpm test:guest` | `tests/guest/` | `vitest.guest.config.ts` | Behavior observed through a disposable guest |

## What each tier exercises

- **`unit`** — Tests that call an in-process module interface directly, or that
  drive an intentional internal seam. A unit test that uses a local in-memory or
  stub adapter is still a unit test: the observation is made through the module,
  not through a packaged command or a running stack. This tier keeps the fast,
  Node-based execution model and requires no external services.

- **`cli`** — Tests that invoke the built, user-facing `configamatron` command
  and assert on its behavior or on the artifacts it writes to disk. Building the
  package (`pnpm build`) is a prerequisite because these tests run against
  `dist/cli.js`. Several in-process modules may participate in producing a
  result; that does not make it a unit test — the observation is made through the
  packaged interface.

- **`proxy-stack`** — Tests that bring the real proxy stack up (Envoy in Docker,
  networking, mock upstreams, and other local adapters) and observe its behavior
  without booting a guest. Their Docker and local-upstream requirements are
  meant to be obvious from the tier name and directory.

- **`guest`** — Tests whose observations are made from inside a disposable guest.
  A guest test typically crosses the CLI and the proxy stack as well, but it is
  placed here because the guest is the highest surface it exercises. The test
  implementation boots the guest with QEMU under WSL2; **Hyper-V remains the
  production guest platform, and is not the test runtime** (see
  [ADR-0010](adr/0010-wsl-qemu-vm-test-platform.md)). The `guest` name refers to
  the domain actor under test, not to the virtualization mechanism.

## Placing a new test

**The highest observable interface a test crosses determines its tier.** When a
test could plausibly live in more than one tier, choose the tier of the highest
surface it actually exercises, and prefer asserting at the highest stable seam
available rather than reaching down to lower-level implementation detail.

Worked cases:

- **Several in-process modules compose to produce a result** → `unit`, as long as
  the observation is made by calling a module directly (including through a local
  in-memory or stub adapter). Depth of composition does not promote a test to a
  higher tier; the surface does.
- **The test invokes the packaged CLI** → `cli`, even when many in-process
  modules participate. The suite name describes the observation (the packaged
  command and its artifacts), not the implementation depth behind it.
- **The test needs a live proxy stack but never enters a guest** → `proxy-stack`,
  so that its Docker and local-adapter requirements are discoverable from its
  location.
- **The test drives behavior from inside a disposable guest** → `guest`, even
  when it also crosses the CLI and the proxy stack, because the guest is the
  highest exercised seam.

Avoid proliferating new tiers. If a test seems not to fit, re-express it in terms
of the highest surface it observes and place it there.

## Placement rule for new tests

The tier decision above chooses _which suite_ a test joins. The same principle
also decides _which file and group_ a test joins inside a tier. State it as one
rule:

> **Place each test at the highest stable interface through which its behavior is
> observed.** Never categorize a test by its subjective size or by how much
> integration it performs.

"Highest" means closest to a contract a caller depends on. "Stable" means it does
not change when private implementation is refactored. Amount of integration,
number of modules touched, line count, and runtime are **not** placement criteria
— they are consequences, not causes, of where the observable interface sits.

A coding agent applies the rule mechanically:

1. **Name the observable behavior** the test verifies (an outcome a caller can
   see), not the function that happens to produce it.
2. **Find the highest stable interface that exposes that behavior.** Candidates,
   from highest surface down: the guest, the live proxy stack, the packaged CLI,
   a module interface, or an intentional internal seam (a protocol codec, a
   deterministic state machine, a formatter/parser, or an adapter with meaningful
   failure behavior). Prefer the highest one that still lets the test observe the
   behavior directly.
3. **Assert through that interface only.** Do not reach past it to inspect private
   state merely because the state is convenient — that couples the test to
   implementation and defeats the rule.
4. **Name for the interface, not the action.** The filename identifies the module
   interface or observable capability; the top-level group names that same
   interface; a nested group names the behavioral situation (startup, allowlist
   change, credential rotation, refresh nudging, shutdown, setup phase, isolated
   phase, ...); the individual test states a present-tense observable outcome.

An internal seam is a legitimate "highest stable interface" only when its contract
is independently valuable and durable — protocol encode/decode, deterministic
state transitions, and adapters whose failure behavior is itself the contract.
Reaching for a seam to avoid the cost of a higher interface is not justified; the
seam must be the highest interface at which the behavior is genuinely observed.

## Prerequisites per tier

Each tier fails for its own environmental reasons; knowing them keeps a missing
prerequisite from being mistaken for a product defect.

| Tier | Prerequisites |
| --- | --- |
| `unit` | Node only. |
| `cli` | A production build (`pnpm build`, run automatically before the suite in the default pipeline). The suite shells out to `jq`; install it on the dev host and CI, or the jq-dependent tests self-skip. |
| `proxy-stack` | Docker running (Envoy is brought up via docker compose against local mock upstreams on transient ports). No guest and no real credential are required. |
| `guest` | Windows host with WSL2 (mirrored networking, `ignoredPorts=67`), a real Debian-based WSL2 distro set as default, QEMU/KVM available inside WSL2, Docker, and the one-time golden-image build. See the "Development" section of [README.md](../README.md) and the guest-harness notes in [technical-notes.md](../technical-notes.md) for the exact WSL configuration and setup command. |

When a guest run cannot verify because a prerequisite is unavailable (no WSL2, no
KVM, wrong default distro, etc.), report that explicitly as an environmental gap
rather than as a test failure.

## Default verification pipeline

`pnpm test` runs the default pipeline, which covers the **unit, CLI, and
proxy-stack** tiers (alongside format, lint, typecheck, and the build). The exact
fail-fast step order lives in the "Verification Pipeline" section of
[README.md](../README.md), the single source for the per-step commands.

The **guest** tier is **not** part of `pnpm test`. It is invoked separately with
`pnpm test:guest` because of its Windows/WSL2/QEMU prerequisites and its runtime
(guest boots and reboots take minutes). Run it when touching
`templates/vm-shared/` or proxy configuration. Stop any running
`configamatron run-proxy` first — the suite and `run-proxy` manage the same Envoy
stack and will clobber each other (see [technical-notes.md](../technical-notes.md)).

## Shared test support

Support code that serves more than one tier lives at the root of `tests/` and is
**shared**, not owned by any single tier — for example `proxyStack.ts`,
`testEnvRoot.ts`, `rmEnvRoot.ts`, `checkDockerRunning.ts`, `checkNoRunningProxy.ts`,
and `tests/fixtures/`. Multiple tiers consume these — for example the CLI tier
reads `tests/fixtures/`, while the proxy-stack and guest tiers share the stack
helpers.

Tier-specific setup and harness code stays inside its owning tier's directory —
for example `tests/proxy-stack/globalSetup.ts`, `tests/guest/globalSetup.ts`, and
`tests/guest/harness/`. Do not relocate a shared helper into one tier's directory,
which would give it misleading single-tier ownership.

## Migration map (#40 reorg)

This is the concrete reference for the [#40](https://github.com/fschwiet/configamatron/issues/40)
reorg: every existing test file, its target filename, and the domain vocabulary
its `describe` groups should adopt. It records intent so cleanup does not depend on
rediscovering the structure. It renames and regroups the prior art; it does **not**
change any assertion.

Reading the tables:

- **Target file** names a coherent module interface or observable capability, not
  an implementation action. Where a source-aligned name already names a coherent
  interface it is kept — this is not a blanket rename.
- **Target group vocabulary** is what the top-level (and, where noted, nested)
  `describe`s should say, drawn from the project glossary in
  [CONTEXT.md](../CONTEXT.md): environment, host, guest, setup phase, isolated
  phase, proxy stack, allowlist, credential channel, VM share, pre-isolation step,
  post-isolation step, home settings transform, internal switch.
- **Acronyms are deliberately retained** where they precisely identify the
  interface under test rather than making it vague: **DNS**, **DHCP**, **CA**,
  **JWT**, and **IPv4**. Keep them; do not "domain-ify" a protocol codec into an
  ambiguous phrase. Conversely, use `proxy stack` (not "Envoy") when the behavior
  belongs to Configamatron's interface, and name the implementation technology only
  when that technology is itself the subject of the assertion.
- No file below is renamed _in #43_. This document is the map the per-tier reorg
  tickets (#44–#53) follow.

### Unit tier

Organized into the seven conceptual clusters of #40. Focused seam files are kept
where each interface is independently meaningful; shallow helpers are absorbed into
a coherent module where they are not.

#### Environment lifecycle & paths

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/envPaths.test.ts` | `envPaths.test.ts` | environment paths & layout; VM share and proxy secret locations |
| `tests/unit/initEnv.test.ts` | `initEnv.test.ts` | environment initialization (scaffolds VM shares, allowlist, sanitized credentials, home settings transforms) |
| `tests/unit/collisions.test.ts` | `collisions.test.ts` | VM share collision detection |
| `tests/unit/gitignore.test.ts` | `gitignore.test.ts` | environment ignore rules (customization surface vs. secrets) |

#### Allowlist compilation & proxy configuration

Distinguish parsing, collision resolution, and generated proxy behavior; do not
promote every helper to a top-level capability.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/allowlist.test.ts` | `allowlist.test.ts` | allowlist parsing, formatting, collision resolution (passthrough / claude-authenticated / auth-candidate / github-authenticated sections) |
| `tests/unit/policyFile.test.ts` | `policyFile.test.ts` | policy import (network/allow → allowlist) |
| `tests/unit/envoyConfig.test.ts` | `proxyConfig.test.ts` | proxy configuration generation (filter chains & clusters per allowlist section); nested groups per credential channel — retain **CA** where the leaf/CA chain is the subject |

#### Certificate & credential modules

Separate credential channels stay explicit where their formats and lifecycle
differ. Per #40, credential **reading**, **secret formatting**, and
**sanitization** modules cluster here even when the file currently lives under
`runProxy/`.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/ca.test.ts` | `ca.test.ts` | **CA** creation & validation (root/leaf issuance, signing, SAN extraction) — **CA** retained |
| `tests/unit/leaf.test.ts` | `leaf.test.ts` | leaf certificate issuance & reuse — retains leaf/SAN terms |
| `tests/unit/jwt.test.ts` | `jwt.test.ts` | **JWT** build/decode helpers — **JWT** retained |
| `tests/unit/codexPlaceholder.test.ts` | `codexPlaceholder.test.ts` | Codex placeholder credential constants (far-future **JWT** exp, no real secret) |
| `tests/unit/githubToken.test.ts` | `githubToken.test.ts` | GitHub host-credential token-format validation |
| `tests/unit/githubConfig.test.ts` | `githubConfig.test.ts` | GitHub credential configuration formatting |
| `tests/unit/githubSecret.test.ts` | `githubSecret.test.ts` | GitHub credential secret formatting (Basic / api token SDS) |
| `tests/unit/runProxy/writeSecret.test.ts` | `writeSecret.test.ts` | credential secret formatting (claude / codex SDS) |
| `tests/unit/runProxy/readCredentials.test.ts` | `readCredentials.test.ts` | credential reading — claude credential channel |
| `tests/unit/runProxy/readCodexCredentials.test.ts` | `readCodexCredentials.test.ts` | credential reading — codex credential channel (**JWT** exp) |
| `tests/unit/sanitizeCredentials.test.ts` | `sanitizeCredentials.test.ts` | credential sanitization — claude credential channel (placeholder swap) |
| `tests/unit/sanitizeCodexCredentials.test.ts` | `sanitizeCodexCredentials.test.ts` | credential sanitization — codex credential channel |

#### Generated provisioning & VM shares

Preferred vocabulary: generated provisioning, VM share, customization input,
pre-isolation step, post-isolation step, home settings transform.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/templates.test.ts` | `templates.test.ts` | generated provisioning inventory (packaged VM share & proxy templates, pre-/post-isolation step scripts) |
| `tests/unit/weaveScripts.test.ts` | `weaveScripts.test.ts` | pre-/post-isolation step weaving (ordering, renumbering, customization-input validation) |
| `tests/unit/weaveShares.test.ts` | `weaveShares.test.ts` | VM share weaving (built-ins + customization inputs into both shares) |
| `tests/unit/homeJqTransforms.test.ts` | `homeSettingsTransforms.test.ts` | home settings transforms (manifest load, target resolution, apply/preview) |

#### Proxy stack supervision

The supervisor state machine is named for the capability, not its implementation
function. Nested groups: startup, access logging, allowlist changes, credential
changes, event coalescing, refresh nudging, shutdown, multiple credential channels.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/runProxy/runProxyLoop.test.ts` | `proxyStackSupervisor.test.ts` | proxy stack supervision — startup / inline access logging / allowlist changes / credential changes / coalescing / refresh nudging / shutdown / multiple credential channels |
| `tests/unit/runProxy/planNextActions.test.ts` | `supervisionPlanning.test.ts` | supervision planning (deterministic next-action transitions, refresh-window nudge arming) |
| `tests/unit/runProxy/credentialChannel.test.ts` | `credentialChannel.test.ts` | credential channel lifecycle (startup/propagation, refresh nudging, isolation between channels) |
| `tests/unit/commands/runProxy.test.ts` | `commands/runProxy.test.ts` | run-proxy command option surface (internal seam guarding the registered flags) |

#### Proxy stack adapters & internal seams

Kept as focused seam files because each interface has meaningful, deterministic
failure behavior behind the live stack. Target filenames name the capability the
seam provides, not the implementation function that provides it.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/runProxy/waitColorReady.test.ts` | `readiness.test.ts` | proxy stack readiness polling |
| `tests/unit/runProxy/killProcessTree.test.ts` | `processTermination.test.ts` | process-tree termination |
| `tests/unit/runProxy/buildConfig.test.ts` | `proxyConfigWriting.test.ts` | proxy configuration writing (upstream overrides applied) |
| `tests/unit/runProxy/parseLine.test.ts` | `logLineParsing.test.ts` | access-log line parsing |
| `tests/unit/runProxy/classify.test.ts` | `logLineClassification.test.ts` | access-log line classification |
| `tests/unit/runProxy/formatOutput.test.ts` | `outputFormatting.test.ts` | access-log output formatting |
| `tests/unit/runProxy/uniqueTracker.test.ts` | `uniqueTracker.test.ts` | first-occurrence access-log deduplication |
| `tests/unit/runProxy/allocateColorPorts.test.ts` | `portAllocation.test.ts` | loopback port allocation |
| `tests/unit/runProxy/relaunchViaDedicatedNode.test.ts` | `runtimeRelaunch.test.ts` | dedicated-node runtime relaunch |
| `tests/unit/runProxy/serviceStack.test.ts` | `serviceStack.test.ts` | service-stack start/rollback/close lifecycle |
| `tests/unit/runProxy/abortableSleep.test.ts` | `abortableSleep.test.ts` | abortable sleep seam |

#### Internal switch networking protocols

Protocol seams stay explicit because they give precise, deterministic behavior
behind the live network interface. **DNS**, **DHCP**, and **IPv4** are retained.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/unit/runProxy/dhcpMessage.test.ts` | `dhcpMessage.test.ts` | **DHCP** message encode/decode |
| `tests/unit/runProxy/dhcpLeases.test.ts` | `dhcpLeases.test.ts` | **DHCP** lease table |
| `tests/unit/runProxy/dhcpHandler.test.ts` | `dhcpHandler.test.ts` | **DHCP** request handling (offer/ACK/relay) |
| `tests/unit/runProxy/dhcpServer.test.ts` | `dhcpServer.test.ts` | **DHCP** serving |
| `tests/unit/runProxy/dnsMessage.test.ts` | `dnsMessage.test.ts` | **DNS** message parsing & response construction |
| `tests/unit/runProxy/dnsResponder.test.ts` | `dnsResponder.test.ts` | **DNS** responding |
| `tests/unit/runProxy/forwarder.test.ts` | `forwarder.test.ts` | internal switch address selection & forwarding |
| `tests/unit/runProxy/gateway.test.ts` | `gateway.test.ts` | internal switch gateway lifecycle (connection routing, drain, flip) |
| `tests/unit/runProxy/ip.test.ts` | `ip.test.ts` | **IPv4** addressing helpers |

### CLI tier

Organized around the global CLI interface and the individual user-facing commands.
Global help, version, command registration, and parsing stay under the CLI
interface; command-specific behavior uses the full user-facing command name.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/cli/cli.test.ts` | `cli.test.ts` | CLI interface — help, `--version`, command registration, parsing. The `import-sbx-network-policy` (allowlist import) and `write-github-config` cases move to their command files below |
| `tests/cli/cli.test.ts` | `importSbxNetworkPolicy.test.ts` | `import-sbx-network-policy` — allowlist import command (absorbs the cli.test.ts import-sbx-network-policy cases) |
| `tests/cli/init.test.ts` | `init.test.ts` | `init` — environment initialization command |
| `tests/cli/generateCa.test.ts` | `generateCa.test.ts` | `generate-ca` — certificate generation command (**CA** retained) |
| `tests/cli/writeGithubConfig.test.ts` | `writeGithubConfig.test.ts` | `write-github-config` — GitHub configuration command (absorbs the cli.test.ts write-github-config cases) |
| `tests/cli/updateShares.test.ts` | `updateShares.test.ts` | `update-shares` — VM share regeneration command (pre-/post-isolation step reweave, home settings transform preview) |
| `tests/cli/vmApplier.test.ts` | `vmApplier.test.ts` | packaged guest applier artifact (built into both VM shares, listed in the npm package) |

### Proxy-stack tier

Organized around observable stack capabilities. Say `proxy stack`, not "Envoy",
except where the concrete adapter is the subject.

| Current file | Target file | Target group vocabulary |
| --- | --- | --- |
| `tests/proxy-stack/proxy.test.ts` | `allowlistEnforcement.test.ts` | live allowlist enforcement (allow-listed passthrough / port-80 host / dropped non-allow-listed SNI / default-deny) **and** access logging — rename "Envoy sandbox proxy stack" → proxy stack; **CA** retained on the leaf-chain case |
| `tests/proxy-stack/runProxy.test.ts` | `stackLifecycle.test.ts` | stack lifecycle & replacement (blue-green credential-rotation swap) |
| `tests/proxy-stack/runProxyRobustness.test.ts` | `stackRobustness.test.ts` | robustness under failure (config-issue fast-fail, prompt SIGINT, collision startup) |
| `tests/proxy-stack/githubInjection.test.ts` | `githubInjection.test.ts` | credential injection — GitHub credential channel (placeholder replacement, pass-through, missing auth, scheme handling, upstream observation) |
| `tests/proxy-stack/codexInjection.test.ts` | `codexInjection.test.ts` | credential injection — Codex credential channel (parallel structure to GitHub) |
| `tests/proxy-stack/isColorRunning.test.ts` | `servingStateDetection.test.ts` | serving-state detection (container running check) |

### Guest tier

Remains a single lifecycle-oriented file; the expensive shared guest and
proxy stack setup make splitting counterproductive. Drop the `S1`/`S1b`/`S2`/`S2b`/
`S2c`/`S3` labels and order the groups by lifecycle. Use `setup phase` (not "NAT
phase") and `isolated phase` (not "offline"/"gateway-less").

| Current file | Target group (ordered by lifecycle) | Target group vocabulary |
| --- | --- | --- |
| `tests/guest/guest.test.ts` | `S1: setup during NAT phase` → | provisioning during the setup phase |
| | `S1b: applier onboarding ... offline` → | guest home & authentication configuration |
| | `S2: switch to gateway-less and reboot` → | transition to the isolated phase |
| | `S2c: cold DNS cache vs. restart-warmup ...` → | passthrough destination resolution after proxy warmup (keep the cold-resolution investigation reference in a nearby comment, not the group name; **DNS** retained in the body) |
| | `S2b: run-proxy inline logging` → | proxy stack access logging & replacement |
| | `S3: fresh guest on the isolated network` → | a fresh guest starting in the isolated phase |

The `guest.test.ts` filename is kept: the whole file is one lifecycle capability
observed through the guest seam.

## One-tier discoverability guarantee

Every moved suite must remain discoverable by **exactly one** tier configuration —
so the reorg neither duplicates a test into two tiers nor drops it from all of them.

Concretely:

- A test file is discovered by exactly one of `vitest.config.ts` (unit),
  `vitest.cli.config.ts`, `vitest.proxy-stack.config.ts`, or
  `vitest.guest.config.ts`, by virtue of living under that tier's directory
  (`tests/unit/`, `tests/cli/`, `tests/proxy-stack/`, `tests/guest/`). No file is
  matched by two tiers' include globs, and none falls outside all of them.
- **Before** moving anything, record each tier's discovered test count
  (`pnpm test:unit`, `pnpm test:cli`, `pnpm test:proxy-stack`, `pnpm test:guest`).
  **After** each structural phase, re-run discovery and confirm every suite is
  still counted once and only once. A rename or move that leaves a file un-matched
  (dropped) or double-matched (duplicated) is a discovery regression, not a
  passing move.
- Shared support at the root of `tests/` is **not** a test suite and is excluded
  from every tier's include globs; moving a helper does not change any tier's test
  count.

This guarantee is what makes the migration behavior-preserving: the same
assertions run afterward, each under exactly one tier, with unchanged effective
coverage.

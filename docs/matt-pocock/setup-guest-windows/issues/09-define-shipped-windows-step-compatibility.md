# Define shipped Windows step compatibility changes

Type: grilling
Status: resolved
Blocked by: 04, 05

## Question

What exact changes must the shipped Windows pre-isolation and post-isolation steps make to satisfy the settled Windows script-runner contract and run reliably through noninteractive PowerShell Direct sessions?

Audit every shipped `.ps1` step for native commands whose nonzero status is currently ignored, accepted idempotent native outcomes that must remain successful, fresh-process PATH and environment propagation, package-manager readiness, reboot requirements, interactivity, and execution from a read-only UNC VM share. Decide the required script and documentation adaptations without implementing them.

Account for the ambient-trust design before finalizing changes to `configure-network`. The answer must distinguish genuine provisioning failures from explicitly accepted idempotent outcomes and identify any prerequisite checks or reboot boundaries that end-to-end orchestration must provide.

## Answer

All shipped Windows steps must adopt one rule: a mutating native command succeeds only with exit code `0`. A step may accept a nonzero status only for a named, read-only state probe whose meaning is documented and tested, such as WinGet's supported-version result for "package absent." Do not treat arbitrary WinGet "already installed," "no applicable upgrade," or reboot HRESULTs as success. Inspect state before mutation, check `$LASTEXITCODE` immediately after every native invocation, and throw a step-specific terminating error containing the operation and numeric status. PowerShell cmdlets continue to rely on `$ErrorActionPreference = 'Stop'`.

Each script must remain noninteractive, replay-safe, and writable only outside the UNC share. Shipped steps may read scripts and sibling inputs through `$PSScriptRoot` or the phase working directory, but downloads, staging files, package caches, credentials, and generated settings belong in the guest's temporary, profile, or managed system directories. No step maps a drive, edits the share, changes persistent execution policy, prompts, or assumes session state left by another step.

### `01-install-packages.ps1`

Remove these operations entirely:

- `winget settings --enable/--disable BypassCertificatePinningForMicrosoftStore`;
- `winget upgrade Microsoft.AppInstaller`; and
- `winget upgrade --all --include-unknown`.

Windows installation and Windows Update are prerequisites, ambient trust is reconciled before provisioning, and ADR-0024 limits this step to software required by shipped behavior. Self-updating App Installer and upgrading unrelated guest packages violate those boundaries.

Require a usable supported WinGet command and source before package mutation. For each of `jqlang.jq`, `Git.Git`, and `GitHub.cli`, query exact installed state, skip a verified installed package, and otherwise run an exact, silent, agreement-accepting, interactivity-disabled install from the `winget` source. The implementation must pin and test the supported WinGet version's one package-absent probe result rather than parse localized prose or broadly allow nonzero statuses. Every source/readiness error and every install nonzero is a provisioning failure.

After installation, rebuild only the current script process's PATH from the persisted machine and user PATH values for postcondition checks; do not write a synthesized PATH. Verify `jq`, `git`, and `gh` resolve and each can report a version with exit code `0`. Later steps still check their own prerequisites in their naturally fresh process. Delete the obsolete "open a new terminal" instruction from output.

### `02-install-pnpm.ps1`

Keep the official `https://get.pnpm.io/install.ps1` bootstrap and floating pnpm version policy. Download it to a uniquely named file under the guest's temporary directory, invoke it noninteractively under the step's existing per-process execution-policy bypass, and remove the temporary file in `finally`. A download, bootstrap, or cleanup failure is reported explicitly; the UNC directory is never used for staging.

After bootstrap, read the persisted user `PNPM_HOME` and user PATH, refresh only the current process environment for verification, and require that the resolved pnpm executable is under the persisted pnpm home and that `pnpm --version` exits `0`. Missing or inconsistent persisted environment state is failure even if the bootstrap itself returned success. The next fresh step must independently resolve pnpm; no runner-supplied PATH compatibility behavior is added.

### `03-install-tools.ps1`

Start by requiring `pnpm` to resolve and `pnpm --version` to exit `0`. Preserve the existing floating installs: latest Node through `pnpm runtime set node latest -g`, current Pi through `pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent`, current Claude Code through `Anthropic.ClaudeCode`, and current Codex through `pnpm add -g @openai/codex`.

Check every pnpm result immediately. Install Claude Code with the same exact-state-first WinGet pattern as step 01 and explicit silent, agreement, and no-interactivity options; an already-present exact package is the idempotent skip, not an ignored install status. Refresh the current process PATH from persisted values only for verification, then require `node`, `pi`, `claude`, and `codex` to resolve and return successful version output. Remove the "open a new terminal" message.

None of the shipped package or tool installs is expected to require a reboot. A reboot-required or reboot-initiated native result is failure, not accepted success.

### `nn-configure-network.ps1`

The host-driven trust reconciler settled in ticket 05 is the sole owner of certificate imports, managed trust files, and `NODE_EXTRA_CA_CERTS`. Remove `CertPath`, `certutil`, the proxy-CA copy, trust-directory creation, and machine environment mutation from this step.

Retain the mandatory `HostIp` parameter for the settled runner interface, validate that it is an IPv4 address, but do not use it to mutate addressing. While this step still runs on the Default Switch, the Internal-switch route and DHCP lease do not yet exist; orchestration verifies those after switching.

Before making the remaining configuration change, verify against the reconciler's managed state that:

- the environment proxy certificate's DER SHA-256 fingerprint is present in `LocalMachine\\Root`;
- the manifest identifies that same current proxy fingerprint;
- machine-scoped `NODE_EXTRA_CA_CERTS` names the stable combined bundle; and
- the bundle exists and contains the manifest's retained ambient fingerprints plus the current proxy fingerprint without duplicates.

Missing, malformed, or mismatched reconciled state is failure, never repaired here. Then run `git config --global http.sslBackend schannel`, check its exit status, read it back with another checked invocation, and require the value to be `schannel`. Clear the DNS cache with its PowerShell cmdlet and report that trust and Git are ready while addressing remains DHCP-owned.

### `01-auth-config.ps1`

Before changing guest state, validate and parse `github-config.txt`, require all three GitHub values, require readable `credentials.json` and `auth.json`, and validate that the two JSON inputs have the expected managed placeholder shapes. Never print or embed the GitHub token in diagnostics.

Check both `git config` calls. Run GitHub authentication with explicit hostname/protocol and token-on-stdin options that cannot prompt, check it immediately, then run and check hostname-specific `gh auth setup-git`. Re-authenticating and reapplying Git identity are intended idempotent mutations; no nonzero result is accepted as an "already configured" outcome.

Stage the Claude and Codex managed files in their destination profile directories and atomically replace the existing copies. Replay intentionally refreshes both placeholders, including Codex's host account identifier after a workspace switch. Validate the installed files before reporting success and remove staging files best-effort after failure.

### `02-apply-home-jq-transforms.ps1`

Require `node --version` and `jq --version` to exit `0` before invoking the bundled transformer. Invoke the `.mjs` by its `$PSScriptRoot` path, pass the shared transform directory as data, and propagate its nonzero exit immediately. The transformer already reads the share, writes only under the user profile, atomically replaces outputs, reports per-transform failures, and is idempotent for idempotent transforms; retain those semantics.

### Verification script and documentation

Although `verify-config.ps1` is not a numbered provisioning step, align its diagnostics with the new ownership model. Replace subject-name proxy lookup and the old single-proxy Node-file assertion with DER SHA-256 checks against the managed manifest and combined bundle. Capture native status immediately for Git and every curl probe so a stale `$LASTEXITCODE` cannot misclassify a check.

Update the generated customization READMEs and `setup-guest.md` when the command is implemented. Document that Windows `.ps1` customizations run elevated under fresh Windows PowerShell 5.1 processes with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, from a read-only UNC phase directory; must not prompt; must explicitly handle every native exit; and must be idempotent because recovery replays the complete flow. Remove the manual persistent `Set-ExecutionPolicy Bypass`/`RemoteSigned` sequence and obsolete new-terminal guidance.

### Orchestration prerequisites and reboot boundary

Before the first step, orchestration must verify that WinGet is discoverable and usable at the supported version, no Windows pending-reboot indicators are set, the guest is elevated, and trust reconciliation completed. Fresh processes provide persisted environment changes; each consuming step still performs its own command-readiness check. Before isolation, orchestration must verify that no package operation introduced a pending reboot. After switching, it owns DHCP lease, route, DNS, share, and isolated-egress readiness checks rather than assigning them to `configure-network`.

The initial implementation does not reboot from a shipped step. If an installer requests one, fail with the package and status named, leave recovery to a guest reboot followed by complete command replay from the Default Switch, and never continue into isolation with a pending reboot. If end-to-end testing proves a required supported installer unavoidably needs a reboot, ticket 06 may add a controlled reboot while still on the Default Switch, reconnect through PowerShell Direct, and replay the complete pre-isolation plan; it must not resume after the individual step.

# 18: `windowsE2e` guest role proves the packaged command and replay

**What to build:** A new `windowsE2e` guest-tier role that runs the packaged `setup-guest-windows` against a disposable Windows 11 guest. It checks the real footer after a deliberate failure, proves that a replay succeeds, and verifies the isolated guest. It replaces and retires `windowsFresh`, whose network-boundary assertions move here. See the spec's "Testing Decisions" and ticket 08.

- **Golden image:** the `git` stage becomes a `winget-ready` stage. It keeps the App Installer registration retry, requires `winget --version` to exit `0` at the version G3 supports, and installs nothing. The stamp change forces one image rebuild. `SUSENTORNO_WINDOWS_ISO` stays a required prerequisite.
- **Staging:**
  - Start the real proxy stack on the `test` isolation name and create the test share.
  - Write `github-config.txt` containing the placeholder PAT.
  - Add a customized `post-scripts/99-fail.ps1` that throws.
  - Put a `gh.cmd` shim (exit `0` for any arguments) in a directory at the front of the guest's machine PATH. Isolation-residue sweeping removes it after an aborted run.
- **Run 1:** run `node dist/cli.js setup-guest-windows` with every non-secret flag and both secrets on stdin; the golden `Administrator` is the guest user account. The command must exit `1` at G13 on `99-fail.ps1`, and the footer must name that phase and step, the VM as `Running` on the test Internal switch, both VM share credentials as verified, and the instruction to rerun.
- **Run 2:** remove `99-fail.ps1` and rerun. The command must exit `0`.
- **Assertions inside the isolated guest after run 2:**
  - addressing, route, and DNS come from `run-hosting`, and there is no in-guest DNS responder or direct Internet route;
  - allow, terminate against the proxy CA, `git ls-remote` over schannel, drop, and 403 behave as expected;
  - the proxy fingerprint is in `LocalMachine\Root`, the manifest names it, and `NODE_EXTRA_CA_CERTS` points at the bundle;
  - the share is reachable by UNC on both addresses, both credential targets are present, and there is no mapped drive;
  - `jq`, `git`, `node`, `pnpm`, `pi`, `claude`, and `codex` report versions, and the real GitHub.cli package is installed;
  - the auth config (including the host Codex account ID) and the home settings transform were applied;
  - the persistent execution policy is unchanged.
- **Operations:**
  - `beforeAll` gets a 2-hour budget.
  - Output streams live and is saved to a log per run.
  - `reboot-evidence.txt` records the production pending-reboot probe and the WinGet, pnpm, and Claude step outcomes.
  - Windows diagnostics add WinGet logs, pending-reboot markers, `cmdkey /list` targets, the trust manifest and bundle fingerprints, a VM screenshot, and both run logs.
  - Every artifact and log is scanned for both passwords.
- **Docs:**
  - `testing.md` describes `windowsE2e`, its runtime, and the `gh` shim, and drops `windowsFresh`.
  - ADR-0027 is amended: `windowsE2e` replaces `windowsFresh`, the `gh` shim is the only remaining substitution, and the rejected "Windows arm of ambient trust in `src/`" option is noted as superseded.

**Blocked by:** 15, 17

**Status:** resolved

- [x] `windowsFresh` and its test-only substitutions are removed, and no test depends on preinstalled Git.
- [x] Run 1 and run 2 behave as specified, and every in-guest assertion above passes.
- [x] No password appears in either run's output or in any collected artifact.
- [x] `reboot-evidence.txt` is produced on every run.
- [x] The guest-tier rows of ticket 08's acceptance checklist (rows 26–37) each map to a passing assertion.
- [ ] The unit, CLI, and guest tiers pass.
  - Unit (1307) and CLI (48 passed, 1 skipped) tiers pass. In the guest tier `windowsE2e`, `phases`, `fresh`, and `ambientTrust` pass. The Ubuntu `e2e` role failed in its `beforeAll` in three runs, for environmental reasons that do not touch this ticket: once a graceful `Stop-VM` timeout of the Ubuntu guest, and twice apt in the Ubuntu guest failing to fetch the ~170 MB `linux-modules` package because this host's own egress truncates large downloads (host `curl` of the same URL is cut off at 40-90 MB). Left unchecked until it passes on a healthy network.

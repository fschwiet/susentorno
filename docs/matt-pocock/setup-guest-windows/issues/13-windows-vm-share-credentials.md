# 13: Windows VM share credentials in the setup phase

**What to build:** Phase G4. After the guest checks pass, the command prompts for the `VM share account` and masked `VM share password`. It then installs and verifies the guest's Default-Switch VM share credential, so the guest can read the VM share by UNC path. The residual-state footer reports which credentials this run left verified and which it removed. See the spec's "VM share credentials" and ticket 03.

- **Host checks:** the host-local VM share account exists and can read the named share.
- **Credential replacement** for an address-keyed target: close any existing connection to the selected `\\<host-ip>\<share-name>`, delete the credential at that target, write the new one through the native Credential Manager API, then establish fresh UNC access. It never uses `cmdkey /pass:`, never places the password in an argument or file, and never creates a drive mapping.
- **Verification** passes only if all three hold:
  1. a known generated VM-share file can be read and the `pre-scripts` and `post-scripts` paths can be listed;
  2. creating a probe in the share root fails with access denied;
  3. if the probe is created anyway, the command removes it best-effort and fails as a structural error.
- **Failure handling:**
  - An SMB authentication failure repeats both VM share prompts as a pair, including an account name that came from a flag. EOF exits cleanly.
  - A missing account, a wrong share path or permission, missing content, a writable share, or an SMB identity conflict on the same address is structural. It is reported with remediation and never re-prompts.
  - A per-run credential ledger records written, verified, and removed entries. On a handled failure or cancellation, the command closes any open selected-share connection and removes only the entries it wrote but did not verify.
- The module also exposes the operations later tickets need: replace as unverified (for G8), verify (for G12), and close the connection after a phase.

**Blocked by:** 12

**Status:** resolved

- [x] Unit tests of the share-credential module cover replace, verify, close, remove-unverified, and the ledger, with a fake executor. They include the writable-share probe and the identity-conflict classification.
- [x] Unit tests of `runWindowsSetup` cover:
  - the SMB paired re-prompt loop and its EOF exit;
  - structural failures versus credential failures;
  - every prompt still occurring before any mutation;
  - the cleanup ledger shown in the footer for a G4 failure.
- [x] The guest-side script never carries the share password in a process argument. A unit test of the generated request asserts this.
- [x] The unit and CLI tiers pass.

## Implementation notes

- New module `src/guestSetup/windows/shareCredential.ts`:
  - `createVmShareCredentials({ executor, shareName, signal })` exposes `replace` (close, delete, write; recorded as written and unverified, which is what G8 will call), `verify` (what G12 will call), `replaceAndVerify` (G4), `close` (after a phase's steps; keeps the entry), `cleanup`, and the `ledger`.
  - `checkHostShareAccount` is the host half of G4: the host-local account exists and is enabled, and the named share grants it read (a direct grant, or Everyone / Authenticated Users).
  - `ShareCredentialLedger` records `written`, `verified`, `removed`, and `removal-failed` per address, and the selected-share connections this run may have left open.
- Guest side: one short script per operation, sent through the executor's redacted stdin request. The scripts compile a small C# helper with `Add-Type` (C# 5, for Windows PowerShell 5.1) that calls `CredWriteW`/`CredDeleteW` (a Domain Password entry with local-machine persistence, which is what `cmdkey /add:<ip>` writes) and `WNetCancelConnection2W` for the connection. The password appears only inside the `replace` script, as base64, and never in an argument. Nothing launches `cmdkey`, `net use`, or maps a drive. Checked live in Windows PowerShell 5.1 on this host: an entry written by the `replace` script shows in `cmdkey /list` as `Domain Password`, `Local machine persistence`, and the `close` and `cleanup` scripts removed it.
- Verification is done by the helper's `Verify`: read `verify-config.ps1` (the generated file at every Windows VM-share root), list `pre-scripts` and `post-scripts`, then try to create a `.susentorno-probe-<guid>` file in the share root. Access denied passes; a created probe is deleted best-effort and fails as `writable-share`.
- Classification by Windows error: only 1326 and 86 (bad account or password) at the Default-Switch address is `authentication` and re-prompts. 1326 at the Internal-switch address is `internal-authentication` (structural; the entry is removed by cleanup). 1219 is `identity-conflict` and names the address. 1327-1331, 1385, and 1909 (restricted, expired, disabled, no network logon right, locked out) are `account-rejected`. 53, 64, 67, 121, and 1231 are `share-unreachable`. 5 after authenticating is `permission`. 2, 3, an empty file, or a missing directory is `missing-content`. Everything else is `operation`.
- Flow: after G3, G4 asks the paired `VM share account` (prompt default `susentorno`; `--share-account` is used for the first pair only) and masked `VM share password`, host-checks the account, then `replaceAndVerify`s the Default-Switch address. An authentication failure asks for both again; EOF or Ctrl+C is a cancellation. The share prompts come after the guest prompts and before the first credential write.
- Cleanup runs for every ending, after the main flow returns and before the executor is disposed. It sends one request with no signal (so it still runs after Ctrl+C) and a 30-second limit. It closes any open selected-share connection and deletes only entries this run wrote but never verified. It never throws; a failed removal is `removal-failed`. When no share credential was ever written it does not touch the guest. The outcome (failure or cancelled) carries the ledger in `credentials`, and the footer prints one line per address, for example `VM share credential for Default Switch host address 172.29.240.1: verified, kept`.
- `pairedCredentialPrompt` gained an optional `defaultName` (the prompt default for the first name question).
- Until ticket 14, a run that passes G4 now ends with a `not-implemented` failure at phase `G5` (was `G4`).
- The Internal-switch operations exist and are unit-tested in the module but are not called by the flow yet (G8 and G12 belong to tickets 16 and 17).
- Verification: format, lint, typecheck, unit (1086 tests) pass; CLI tier passes (48 passed, 1 skipped; the 10 `setupGuestWindows` CLI tests ran and passed). Not run: the guest tier and a live PowerShell Direct run against a VM. Not exercised live: `Verify` against a real SMB share (the shell used for live checks was not elevated, so it could not create one), and that Credential Manager writes made from a PowerShell Direct session are honored by the guest's SMB client (the guest harness already relied on `cmdkey /add` from PowerShell Direct).
- Known limitation: on Ctrl+C the aborted `replace` bridge may still be running in the guest when cleanup starts; a very late credential write could survive cleanup. Any surviving unverified entry is replaced by the next run's delete-then-write.

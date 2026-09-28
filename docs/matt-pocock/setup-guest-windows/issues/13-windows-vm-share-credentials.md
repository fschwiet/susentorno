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

**Status:** ready-for-agent

- [ ] Unit tests of the share-credential module cover replace, verify, close, remove-unverified, and the ledger, with a fake executor. They include the writable-share probe and the identity-conflict classification.
- [ ] Unit tests of `runWindowsSetup` cover:
  - the SMB paired re-prompt loop and its EOF exit;
  - structural failures versus credential failures;
  - every prompt still occurring before any mutation;
  - the cleanup ledger shown in the footer for a G4 failure.
- [ ] The guest-side script never carries the share password in a process argument. A unit test of the generated request asserts this.
- [ ] The unit and CLI tiers pass.

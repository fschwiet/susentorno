# Define the Windows share credential lifecycle

Type: grilling
Status: resolved
Blocked by: 01

## Question

How should `setup-guest-windows` make the read-only Windows VM share available before and after isolation without confusing guest credentials with share credentials or retaining more secret state than required?

Decide how the command installs and verifies `cmdkey` credentials for the Default-Switch host address and Internal-switch host address; whether and when the setup-phase entry is removed; whether the isolated-phase entry intentionally remains for ongoing VM-share access; how reruns replace stale entries; whether a drive mapping is ever needed or all scripts run from UNC paths; and what failures and cleanup behavior apply when authentication or share access fails.

The answer must preserve the separate `--share-account` identity and masked SMB share-password prompt and account for Windows credentials being keyed by address.

## Answer

Persist two **VM share credentials** in the guest development user's Windows Credential Manager: one keyed by the Default-Switch host IPv4 address and one keyed by the Internal-switch host IPv4 address. Both contain the distinct host-local `--share-account` identity and the same prompted VM-share password. They authorize read-only SMB access; they are not guest logon credentials and do not let guest code change the Hyper-V switch. Retaining both is intentional so the VM share remains available when a host operator later moves the VM to either expected switch.

Use UNC paths (`\\<host-ip>\<share-name>`) throughout. Do not allocate a drive letter or create a persistent or temporary drive mapping. Credential Manager entries, rather than a live SMB connection, are the durable access mechanism.

### Secure installation and replay

Write entries in-process through the native Windows Credential Manager API, producing entries equivalent to `cmdkey /add:<host-ip>`. Do not launch `cmdkey.exe` with `/pass:<password>` or otherwise place the password in a process argument, output, diagnostic, or file. The password may exist only in the masked host prompt, the redacted PowerShell Direct request, guest process memory, and the two intentionally persistent Credential Manager entries. Documentation may use `cmdkey` terminology because users can inspect and remove those entries with it.

For each address, replay owns the selected share and credential target:

1. Close a pre-existing connection to the selected `\\<host-ip>\<share-name>` if one exists.
2. Delete any credential at that address-keyed target.
3. Write the newly prompted share identity and password.
4. Establish a fresh UNC access and verify it when that address is reachable.

Do not silently disconnect connections to other shares on the same host address. Windows permits only one SMB identity to a server address at a time and stores only one credential per address; if another connection prevents authentication, fail with the conflicting address and instructions to close it. Document that a guest cannot concurrently use different SMB identities for shares reached through the same host address.

### Phase ordering and verification

On the Default Switch, replace and verify the Default-Switch entry before any pre-isolation step. Also replace the Internal-switch entry before isolation, but mark it unverified because that address is not yet reachable. After the VM starts on the Internal switch and PowerShell Direct is ready, establish fresh UNC access through the Internal-switch address and verify it before any post-isolation step.

Verification must prove more than successful negotiation:

- read a known generated VM-share file and enumerate the expected `pre-scripts` and `post-scripts` paths;
- attempt to create a uniquely named probe in the share root and require an access-denied result; and
- if an unexpectedly writable share creates the probe, remove it best-effort and fail as a structural host-share error.

A bad account/password during the initial Default-Switch verification follows the settled paired re-prompt loop. Missing expected content, inability to read after authentication, unexpected write access, or an SMB identity conflict is structural and does not masquerade as a bad password. Because the same host account was already verified through the Default-Switch address, an authentication failure unique to the Internal-switch address is also structural: remove that unverified entry and require remediation plus a full rerun rather than asking for a different secret mid-flow.

After each phase's scripts finish, close the command-created connection to that phase's selected UNC share but retain its verified Credential Manager entry. Later user or guest-code access reconnects automatically. A failure while a selected-share connection is open closes it best-effort.

### Failure guarantees

On handled failure or cancellation, remove any entry written by this run that has not yet passed verification and close the selected-share connection. Keep entries already verified during the run: in particular, an Internal-switch failure does not erase the valid Default-Switch entry. This follows the command's observable-state/no-rollback contract while never retaining a credential that setup knows only as an unverified attempt.

Abrupt host or guest termination cannot guarantee cleanup and may leave an unverified entry or SMB connection. This is explicitly non-transactional. The next run first returns the guest to the Default Switch and then performs the delete/write/verify sequence for both address-keyed targets, repairing stale credential state without requiring a separate cleanup mode.

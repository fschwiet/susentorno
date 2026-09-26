# Define the Windows share credential lifecycle

Type: grilling
Blocked by: 01

## Question

How should `setup-guest-windows` make the read-only Windows VM share available before and after isolation without confusing guest credentials with share credentials or retaining more secret state than required?

Decide how the command installs and verifies `cmdkey` credentials for the Default-Switch host address and Internal-switch host address; whether and when the setup-phase entry is removed; whether the isolated-phase entry intentionally remains for ongoing VM-share access; how reruns replace stale entries; whether a drive mapping is ever needed or all scripts run from UNC paths; and what failures and cleanup behavior apply when authentication or share access fails.

The answer must preserve the separate `--share-account` identity and masked SMB share-password prompt and account for Windows credentials being keyed by address.

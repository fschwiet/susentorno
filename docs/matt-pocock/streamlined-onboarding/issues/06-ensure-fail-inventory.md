# The ensure/fail split: exact inventory and error-message contract

Type: grilling
Status: open
Blocked by: 02

## Question

Exactly which prerequisites does the shared ensure-and-preflight module create, which does it refuse
on, and what does a refusal say?

Settled while charting, and not up for re-litigation here: the module **auto-creates** what it can
derive without a secret or a GUI, and **hard-fails with the exact missing step named** for anything
needing a human. It never prompts inline and never half-provisions. Both `setup-guest-unix` and
`setup-guest-windows` call it.

The draft split, to be confirmed and completed against ticket 02's findings:

| Class | Members |
| --- | --- |
| Auto-create | host network (switch, host IP, firewall rules), `.susentorno/`, root CA and leaf, SMB shares |
| Detect-and-fail | share account and its password, the account's logon-deny rights, GitHub PAT, BIOS virtualization, the VM and its OS install |

Known complications:

- **The SMB share is auto-create gated behind a detect-and-fail.** It is scriptable, but only once
  the share account exists. The ordering has to be explicit, and the error when the account is
  missing has to be the one the user sees — not a confusing `New-SmbShare` failure downstream.
- **`create-host-network` requires elevation** (`src/guestSetup/elevationCheck.ts`), as does
  `setup-guest-unix`. If ensure auto-creates the host network, the whole chain inherits that
  requirement. Confirm this is stated once, early, rather than discovered midway.
- **`create-host-network` prompts for a subnet octet** when `--subnet` is absent
  (`promptSubnetForCreateHostNetwork` retries until a valid, free octet is given). A prompt inside a
  step described as "auto-create" contradicts the no-inline-prompt rule. Decide: does ensure pick an
  octet itself, require the flag, or is subnet selection an exception?
- **Existing preflight already does part of this job.** `src/guestSetup/preflightChecks.ts` verifies
  the VM exists, has exactly one adapter, that both switches resolve, and that `run-hosting` has
  bound 53 and 67. Establish whether ensure subsumes it, wraps it, or runs alongside it.
- **`generate-ca` derives its leaf SANs from `auth-list.txt`**, so it is not a one-shot: editing the
  auth list should reissue the leaf. Whether ensure re-runs it every time or only when absent is a
  real choice.

A resolution must produce the full inventory, the order checks run in, and the error-message
contract — at minimum: what a message must name (the missing thing, the command or manual step that
supplies it), and whether the module reports all failures at once or stops at the first. Reporting
all at once is the difference between one round trip and five for a user starting from nothing.

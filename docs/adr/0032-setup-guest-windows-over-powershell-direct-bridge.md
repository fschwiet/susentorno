# `setup-guest-windows` controls the guest only over PowerShell Direct, through a short-lived bridge per invocation

The command never reaches the guest over the network it is configuring, so it uses PowerShell Direct over the VMBus and needs neither SSH nor WinRM in the guest. Each invocation starts a short-lived shipped bridge whose argv holds only the bridge path and VM name; the guest credential and the script cross stdin as one JSON request, and the bridge drops its references and exits after that one call.

## Considered Options

- **SSH or WinRM in the guest.** Rejected: in-band with the network under configuration ([[windows-guest-tested-over-powershell-direct]] makes the same argument for the harness).
- **The credential in the PowerShell command line**, as the harness once did. Rejected: process arguments expose the password on the host.
- **A persistent PSSession.** Rejected: its small authentication saving does not justify retaining the credential longer or recovering stale sessions.

## Consequences

- VM share credentials follow the same rule: they are written in the guest through the native Credential Manager API, never `cmdkey /pass:`.
- The bridge ships outside every VM-share template directory, so `update-shares` never weaves it into a guest share.
- The guest-tier harness drives the guest through the same executor.

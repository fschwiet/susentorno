# Automate Windows guest setup

## Destination

Produce an approved, implementation-ready specification for `setup-guest-windows`: a host-side command that takes an installed and updated Windows 11 Enterprise guest on the Default Switch through the complete setup and isolated phases without further console work.

## Notes

- Match the automation boundary of `setup-guest-unix`; VM creation, Windows installation, and Windows Update remain prerequisites.
- Start from one DHCP network adapter attached to the Default Switch and end on the selected susentorno Internal switch with the Windows VM share available and all pre-isolation and post-isolation steps complete.
- Control the guest through PowerShell Direct, not SSH, WinRM, or the network under configuration.
- Support an existing local administrator account that is also the intended development user. The command does not create an account.
- Keep the guest administrator account distinct from the host-side SMB share account.
- Prompt separately and with masking for the guest password and SMB share password. Neither secret is accepted as a command-line flag or persisted by the command except where persistent guest access to the VM share is an explicit decision.
- Offer flags for every non-secret answer; an omitted answer prompts independently.
- A retry returns the guest to the Default Switch and replays the complete flow. Shipped and customized provisioning steps must therefore be idempotent.
- Run guest scripts with a per-process execution-policy bypass; do not mutate the guest's persistent execution policy.
- Require unit and CLI coverage plus an end-to-end guest-tier test of the packaged command against the disposable Windows 11 guest.
- Consult `grilling` and `domain-modeling` for decision tickets. Consult `prototype` for the PowerShell Direct boundary. Consult `codebase-design` when choosing production module boundaries.
- This map plans the command. Production implementation is a later handoff.

## Decisions so far

- [Define the command and prerequisite contract](issues/01-define-command-and-prerequisite-contract.md): `setup-guest-windows` supports an allowlisted Windows 11 Enterprise x64 25H2 platform, paired credential prompts, strict host/guest preflight, and full-flow replay from the Default Switch without rollback.
- [Prototype the secure PowerShell Direct boundary](issues/02-prototype-secure-powershell-direct-boundary.md): use a credential-scoped executor that sends each request to a short-lived PowerShell Direct bridge over stdin and returns UTF-8 stdout, stderr, and child-process status under explicit deadlines.
- [Define the Windows share credential lifecycle](issues/03-define-windows-share-credential-lifecycle.md): retain verified address-keyed credentials for both expected networks, use UNC paths without mappings, and securely replace, verify, and clean up each entry on replay.
- [Define Windows script-runner semantics](issues/04-define-windows-script-runner-semantics.md): discover deterministic numbered PowerShell steps, run each in a fresh bounded process from the phase UNC directory, and fail fast under an explicit native-command and replay contract.
- [Define Windows ambient-trust propagation](issues/05-define-windows-ambient-trust-propagation.md): reconcile host ambient roots and the environment proxy CA once before provisioning, retain additive ambient trust, rotate only provably managed proxy trust, and publish one atomic Node supplemental bundle.
- [Define shipped Windows step compatibility changes](issues/09-define-shipped-windows-step-compatibility.md): make every shipped step noninteractive, replay-safe, read-only-share compatible, and explicit about native status; narrow package installs, turn `configure-network` into trust verification plus Git setup, and reject pending reboots unless guest testing proves a controlled full replay is necessary.
- [Define end-to-end orchestration and recovery](issues/06-define-orchestration-and-recovery.md): a linear phase machine that asks every prompt before any mutation. It writes the Internal-switch share credential just before isolation, gates isolation on no pending reboot and a live `run-hosting`, and proves lease, DNS, and proxy reachability afterward. Deadlines are fixed. A failure never rolls back and prints a residual-state footer, and every residual state replays cleanly from the Default Switch.

## Not yet specified


## Out of scope

- Creating the Hyper-V VM, acquiring installation media, installing Windows, running Windows Update, or creating the guest development account.
- Supporting Windows 10, Windows Server, Microsoft accounts, domain accounts, or non-administrator development accounts in the first version.
- Adding SSH or WinRM to a Windows guest.
- Changing `setup-guest-unix` except for a clearly justified shared-module extraction that preserves its behavior.
- Implementing `setup-guest-windows` as part of this wayfinding map.

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

## Not yet specified

- Running the complete shipped pre-isolation sequence through a noninteractive PowerShell Direct session may expose assumptions in the current Windows scripts about interactive logons, PATH refresh, package-manager readiness, or reboots. Revisit the scripts after the execution boundary and script-runner semantics are concrete; graduate each demonstrated gap into its own decision ticket.
- The exact diagnostic artifacts available after failures may depend on what the production PowerShell Direct boundary can capture without retaining credentials or temporary guest files.

## Out of scope

- Creating the Hyper-V VM, acquiring installation media, installing Windows, running Windows Update, or creating the guest development account.
- Supporting Windows 10, Windows Server, Microsoft accounts, domain accounts, or non-administrator development accounts in the first version.
- Adding SSH or WinRM to a Windows guest.
- Changing `setup-guest-unix` except for a clearly justified shared-module extraction that preserves its behavior.
- Implementing `setup-guest-windows` as part of this wayfinding map.

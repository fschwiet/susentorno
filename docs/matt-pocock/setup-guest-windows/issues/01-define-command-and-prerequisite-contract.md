# Define the command and prerequisite contract

Type: grilling
Status: resolved

## Question

What exact user-facing and preflight contract should `setup-guest-windows` expose within the map's settled scope?

Decide the supported Windows 11 Enterprise baseline; the required VM, adapter, account, host-elevation, environment, and `run-hosting` state; every flag, prompt, default, and prompt order; how the existing local administrator/development account and the distinct SMB share account are named; which checks occur before either secret is requested; and the retry promise users can rely on. Keep non-secret answers independently flaggable, both passwords masked and absent from flags, and the guest address absent because PowerShell Direct does not use it.

The answer must be specific enough to define Commander help text, preflight failures, and the prerequisite section of `setup-guest.md` without designing the internal orchestration yet.

## Answer

### Supported guest platform

A **supported guest platform** is the repository-approved tuple of operating-system product, edition, architecture, and OS release. `setup-guest-windows` accepts only tuples in a source-controlled allowlist. The initial entry is:

- Windows 11 | Enterprise | x64 | 25H2

Enterprise Evaluation is accepted as the Enterprise licensing channel. Language and licensing channel are not tuple fields. Monthly patch/build numbers are reported for diagnosis but are neither pinned nor allowlisted. Adding a feature release, edition, architecture, or product requires deliberately adding another tuple after the Windows guest-tier suite passes against it. The existing Unix command does not yet use this model; aligning it is outside this effort.

The user must install Windows and complete Windows Update before running the command. Preflight checks standard pending-reboot markers but does not perform a live Windows Update scan: such a scan is slow and can fail before ambient trust is propagated.

### Command and options

The command is `susentorno setup-guest-windows`. Its help must say that it uses PowerShell Direct to run the complete Windows setup path, moves the VM's single adapter from the Default Switch to the selected Internal switch, mounts the Windows VM share on both networks, and runs all pre-isolation and post-isolation steps. It requires an elevated host terminal, a prepared environment and host network, and a running matching `run-hosting` process.

It exposes these non-secret options:

| Option | Meaning and omitted-value behavior |
| --- | --- |
| `--isolation-name <name>` | Select the same named host network as `create-host-network` and `run-hosting`; omission selects the unnamed default, `susentorno-internal`. |
| `--nat-adapter-alias <name>` | Select the setup-phase Hyper-V adapter alias; default `vEthernet (Default Switch)`. |
| `--vm-name <name>` | Hyper-V VM name; otherwise prompt `Hyper-V VM name`. |
| `--guest-username <user>` | Simple, unqualified local account name for the guest development account; otherwise prompt `Windows development user`. |
| `--share-name <name>` | Host SMB share exposing this environment's Windows VM share; otherwise prompt `SMB share name` with default `vm-shared-windows`. |
| `--share-account <name>` | Distinct host-local account authorized to read the VM share; otherwise prompt `VM share account` with default `susentorno`. |

There is no guest-address option because PowerShell Direct does not use the guest network. The **guest development account** is both the existing local administrator used by PowerShell Direct and the account through which the human uses the guest. The **VM share account** is a separate, restricted host account and is never treated as a guest logon.

Neither password has a flag, file, or environment-variable input. Both use masked prompts and are excluded from command output and diagnostics. Any persistence needed for continuing guest access to the VM share is left to [Define the Windows share credential lifecycle](03-define-windows-share-credential-lifecycle.md).

### Prompt and validation order

Each non-secret flag suppresses only its corresponding initial prompt. The interaction is:

1. Before prompting, require an elevated host process and an initialized environment containing the generated Windows VM share. Resolve and validate the isolation name, Default-Switch adapter alias, selected Internal switch, and their host IPv4 addresses.
2. Ask for any missing `Hyper-V VM name` and `SMB share name` answers.
3. Run all host checks possible without account names: the exact VM exists; its state is `Running` or `Off`; it has exactly one network adapter; that adapter is attached to either the derived Default Switch or selected Internal switch; both switches exist; the named SMB share exists and resolves exactly to this environment's generated Windows VM-share directory; and matching `run-hosting` DHCP and DNS listeners are bound on the selected host network.
4. Ask for the `Windows development user` immediately followed by masked `Guest password`.
5. Reconcile and start the VM on the Default Switch, wait boundedly for PowerShell Direct, and authenticate. An authentication failure repeats both guest-account prompts, including the username even when its first value came from `--guest-username`. EOF or cancellation exits cleanly instead of looping.
6. After authentication, require the initial supported guest platform, an enabled local account, local Administrators membership, an elevated PowerShell Direct token, and no standard pending-reboot marker. These are structural failures with remediation, not credential failures, so they do not re-prompt.
7. Ask for `VM share account` immediately followed by masked `VM share password`.
8. Require that host-local account to exist and have read access to the named share, then verify the pair through a real guest SMB access attempt. An SMB authentication failure repeats both VM-share-account prompts, including an initially flagged account. A missing account, wrong share path, or wrong share permission is a structural failure and does not masquerade as a bad password.
9. Recheck `run-hosting` immediately before isolation because it must remain alive throughout the command.

Preflight failures name the failed prerequisite, the relevant VM, switch, adapter, share, account, or address, and a concrete remediation command or documentation pointer where one exists. Secrets and secret-bearing commands must never appear in those errors.

### VM state and retry contract

A first run is documented to start from the Default Switch. A retry may start from either the Default Switch or the selected Internal switch. In either case the command accepts only a `Running` or `Off` VM with exactly one adapter, reconciles it to the Default Switch, starts it, and replays the whole flow. A disconnected adapter, an unrelated switch, additional adapters, or transitional/saved VM state fails rather than being silently repaired.

The command owns VM stop/start operations, expected-switch reconciliation, PowerShell Direct readiness waits, and complete replay. It does not create the VM, guest account, host network, SMB share, or VM share account, and it does not start `run-hosting`.

Failure does not trigger rollback. The VM remains in the observable state reached by the failed step: it may be running or off, on either expected switch, with partial provisioning applied. The error names that step. A rerun is safe because it first returns the guest to the Default Switch and replays every shipped and customized step; therefore all such steps must be idempotent. This is a replay guarantee, not a transactional or resume-in-place guarantee.

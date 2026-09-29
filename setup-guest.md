# Guest setup

Create and configure a guest VM under Hyper-V, isolated behind the host proxy. May be repeated for any number of guests; each guest pairs with one environment via its shared folder. Complete [setup-machine.md](setup-machine.md) and [setup-environment.md](setup-environment.md) first.

Guest setup is differentiated for Windows and Linux guests, both covered in this document.

This doc continues as if `192.168.67.x` was chosen as the subnet and the host was assigned `192.168.67.1` in `setup-machine.md`.

## 1. Prepare the VM

### VM Operating System Image Selection

- Hyper-V Manager includes some images, but the version seems to fall behind what is available if you download your own image.
- To use an included image: "Hyper-V Manager -> Action -> Quick Create"
  - An Ubuntu option is available, pick the latest LTS.
  - A time-limited Windows 11 Dev environment based on Windows Enterprise can be chosen with some pre-installed software. The time limit is not known, but I'd guess 90 days.
- To start with your own image: "Hyper-V Manager -> Action -> New -> Virtual Machine"
  - Ubuntu can be downloaded from: https://ubuntu.com/download
  - A 90-day evaluation ISO for Windows Enterprise can be downloaded from https://info.microsoft.com/ww-landing-windows-11-enterprise.html
- It was observed that the Windows image included with Hyper-V manager took 54.6GB of disk space after running all Windows updates while the evaluation ISO for Windows Enterprise took 26.7 GB for Windows with updates.

### VM creation

- Initial Creation Wizard
  - Select Generation 2 for the VM generation.
  - I've been using 12288 MB of memory and 127 GB of disk space.

- Modify the "Settings" scoped to the VM before starting the VM:

  - Hardware -> Network Adapter
    - Set "Virtual Switch" to **"Default Switch"** for now. The VM uses **one** adapter throughout; only which switch it is attached to changes. Do not add a second adapter — a guest with legs on both networks defeats the isolation the Internal switch exists to provide.
    - If you are installing Windows, you may prefer to leave the adapter **unconnected** for the install itself, so the OS setup cannot push you into signing in with a Microsoft account. Reconnect it to "Default Switch" afterwards.

  - Hardware -> Security => Secure Boot
    - For Windows:
      - "Enable Secure Boot" should be checked, use the default "Microsoft Windows" template.
      - "Enable Trusted Platform Module" should be checked if your OS requires it (True for Windows 11 Enterprise). "Encrypt state and virtual machine migration traffic" seems safe to check.
    - For Ubuntu:
      - Set the Secure Boot template to "Microsoft UEFI Certificate Authority" or disable Secure Boot.

  - Management -> Checkpoints
    - Consider disabling "Use automatic checkpoints" because it's annoying.

  - Management -> Automatic Start Action
    - Consider setting to "nothing" to avoid starting the VM every time you log into the host.

### OS installation

- If you left the network adapter unconnected for a Windows install, connect it to the "Default Switch" now in VM settings.
- Start the machine and install any pending updates.
  - It can be tricky to initiate booting from CD/DVD before it tries a network install. You need to press a key quickly after starting the VM to catch the "press any key to install from CD or DVD" message before it opts to try the network.
  - Restart the machine and check for updates, repeat until none are found.
- For a Windows guest, make sure the account you install with is a **local** administrator account (not a Microsoft or domain account). It is the _guest user account_ `setup-guest-windows` acts through and that you develop in afterwards; setup never creates it. See [Windows guest prerequisites](#windows-guest-prerequisites).

### Nested virtualization

A reference on setting up nested virtualization with Hyper-V: https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization#enable-nested-virtualization

- Make sure you have the right features enabled in BIOS for the host: Intel VT-x (Virtualization Technology) with EPT (Extended Page Tables) or AMD-V (AMD Virtualization) with NPT (Nested Page Tables).
- Make sure your host has the relevant optional Windows features enabled.
  - To check if they're enabled (run elevated):
    ```cmd/powershell
    dism /online /get-featureinfo /featurename:HypervisorPlatform
    dism /online /get-featureinfo /featurename:VirtualMachinePlatform
    ```
  - To enable them (run elevated):
    ```cmd/powershell
    dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
    dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
    ```
  - While the VM is off, run (elevated, you'll be prompted for the VM name):
    ```powershell
    Set-VMProcessor -ExposeVirtualizationExtensions $true
    ```
  - Start the VM so it can run some updates sometimes needed after enabling nested virtualization.

### Recommended save point

Shut down the VM and create a checkpoint before continuing, call it "Windows Installed and Updated" (or the Ubuntu equivalent). This provides a baseline you can return to if your network setup changes.

Hyper-V tip on **managing UI focus**: when the VM is selected it will capture keyboard controls, so alt-tab will enumerate applications in the VM. Use Ctrl+Alt+UpArrow to return focus to the host level, so alt-tab enumerates host applications instead.

## 2. Configure the guest network and mount the share

**Ubuntu guest** — leave the interface on **DHCP**; the installer's default configuration is already correct. Install `openssh-server` (there is no network path into the guest before this exists — everything after it is automated):

```bash
sudo apt update -y && sudo apt install -y openssh-server
```

**Optional but recommended: set up key-based SSH auth.** Configuring a key to use ssh without a password prompt reduces the number of prompts during `setup-guest-unix`:

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\susentorno_guest" -C "susentorno-guest-access"
```

(an empty passphrase is fine — this key only grants what the guest's own account already allows, gated by the account password you're about to authenticate with once below)

```powershell
Get-Content "$HOME\.ssh\susentorno_guest.pub" | ssh <username>@<guest-address> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

This prompts for `<username>`'s password this one time. Then add an entry to `~/.ssh/config` (create the file if it doesn't exist) so every future `ssh <guest-address>` — including `setup-guest-unix`'s own calls, since it SSHes to the same address you type at its "Guest address" prompt — picks up the key automatically:

```
Host <hostname> 192.168.67.*
    User <username>
    IdentityFile ~/.ssh/susentorno_guest
    IdentitiesOnly yes
```

Then, from the Host, in an **elevated (Administrator) PowerShell**, run the environment's setup command. It mounts the share, runs `pre-scripts/`, isolates the guest onto the selected Internal switch/network, re-mounts the share there, and runs `post-scripts/` — the entire remaining Ubuntu flow in one command:

```powershell
susentorno setup-guest-unix
```

It prompts for the Hyper-V VM name, the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno`), and the share password from setup-environment.md.

Any of those answers except the password can be supplied as a flag instead, and each flag suppresses **only its own** prompt — anything you leave off still prompts, in the same order:

| Flag                      | Answers                        |
| ------------------------- | ------------------------------ |
| `--vm-name <name>`        | Hyper-V VM name                |
| `--guest-address <host>`  | Guest address (hostname or IP) |
| `--guest-username <user>` | Guest username                 |
| `--share-name <name>`     | SMB share name                 |
| `--share-account <name>`  | Share account name             |

The SMB share password is always prompted. Automation answers it by piping one line into the command's stdin.

Two more flags select which networks the guest is moved between:

| Flag | Selects |
| --- | --- |
| `--isolation-name <name>` | The host network created by `susentorno create-host-network --isolation-name <name>`. Omit it for the default `susentorno-internal` network. |
| `--nat-adapter-alias <name>` | The Default-Switch adapter used during the setup phase. Defaults to `vEthernet (Default Switch)`. |

A few things worth knowing before running it:

- **`run-hosting` must already be running** (and stay running) before and during isolation —
- The script is idempotent, assuming your configured pre-script and post-script scripts are idempotent.
- **Every rerun of an already-isolated guest briefly reattaches it to the Default Switch** — there's no phase-detection/resume logic, so a rerun always executes all 8 steps from the top, including a round-trip through the internet-facing Default Switch and back. This is expected, not a bug: it's what makes "just rerun the whole command" a safe recovery path after a failure.
- **Four distinct addresses are in play** across this command: the guest's own DHCP lease on the Default Switch, the guest's own (different) DHCP lease on `susentorno-internal`, the Windows host's address on the Default Switch, and the Windows host's address on `susentorno-internal`. If a failure message is unclear about which one it means, this is the ordering to check against.
- **A flag-driven run is unattended only if the guest never prompts**, which needs two things this command does not check or configure: the **key-based SSH auth** set up above, _and_ **passwordless sudo** in the guest. A single run makes roughly twenty separate `ssh`/`scp` invocations, each of which prompts for the guest password without a key. Every remote command also gets a fresh pty (`ssh -t`), so sudo's per-tty credential timestamp never carries from one invocation to the next — nearly every remote step uses sudo, so without `NOPASSWD` you get roughly twenty sudo prompts even with the key in place. Key auth alone is not enough.

<details>
<summary>Manual fallback (for diagnosing a failure, or to see exactly what the command does)</summary>

With `openssh-server` installed you can open an ssh shell to make copying and pasting easier — use the guest's own address or hostname, **not** the Hyper-V VM name `setup-guest-unix` prompts for (the two have no necessary relationship; see "four distinct addresses" above):

```
ssh <username>@<guest-address>
```

For the following commands, replace `<the password from setup-environment.md>`. Special characters don't need to be escaped — the heredoc interpreter is only watching for an `EOF`.

```bash
sudo apt install -y cifs-utils

# Credentials file, readable only by root:
sudo tee /etc/susentorno-share.cred > /dev/null << 'EOF'
username=susentorno
password=<the password from setup-environment.md>
EOF
sudo chmod 600 /etc/susentorno-share.cred

sudo mkdir -p /mnt/vm-shared-linux
# /etc/fstab — auto-mounts at boot so the credentials symlink resolves. Use the
# Default-Switch host IP during the NAT phase and the Internal-switch host IP
# afterwards (both from setup-machine.md) — there is no single correct value
# to hardcode here, unlike a specific environment's own doc.
echo '//<host-ip>/vm-shared-linux  /mnt/vm-shared-linux  cifs  ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount  0  0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
```

If the share was already mounted against a different host IP (e.g. rerunning this after isolation), `mount -a` alone won't notice the change — unmount first: `mountpoint -q /mnt/vm-shared-linux && sudo umount /mnt/vm-shared-linux`, then rerun the `daemon-reload && mount -a` line above.

The share then lives at `/mnt/vm-shared-linux`. `cd` into `pre-scripts/` and run every script in number order; the last is `04-configure-network.sh <host-ip>` when there are no custom scripts, where `<host-ip>` is the Internal-switch host IP from setup-machine.md.

**Isolate** — confirm the host firewall is open and `run-hosting` is running (both from `setup-machine.md`/`setup-environment.md`), then see "Isolate" in §4 below for the `Stop-VM`/`Connect-VMNetworkAdapter`/`Start-VM` sequence. Wait for the guest to come back up, then redo the mount step above with the Internal-switch host IP.

**Post-scripts** — `cd` into `post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.

Before installing anything else, the automated command also installs a Hyper-V KVP/Data Exchange daemon package (`linux-cloud-tools-virtual` at the time of writing — see `src/guestSetup/unix/kvpDaemon.ts`) so `Get-VMNetworkAdapter`'s reported IP addresses work; if reproducing this by hand for diagnosis, `sudo apt-get install -y linux-cloud-tools-virtual` is that step. Its `hv-kvp-daemon.service` only comes up once the guest has rebooted since install — not an issue in the automated flow, since isolation reboots the guest before anything depends on the daemon, but if you install it by hand without a reboot the service will sit `inactive` until one happens (or until `sudo udevadm trigger && sudo udevadm settle` re-registers its vmbus device).

</details>

### Windows guest

For a Windows guest, one host-side command does the whole job: `susentorno setup-guest-windows`. It takes an installed and fully updated Windows 11 guest that is still on the Default Switch through the setup phase, moves it onto the Internal switch, and runs the isolated phase, with no console work inside the guest. It reaches the guest only through **PowerShell Direct**, a Hyper-V channel between the host and the VM, and never over the network being configured. So, unlike Ubuntu, the guest needs no SSH server, no WinRM, and no address to type in.

Follow this one path. Do not run the shipped steps yourself: the command supplies the guest trust, the share credentials, the per-step process and the exit-code checking that a hand-run step would skip.

#### Windows guest prerequisites

- **The guest:** Windows 11 Enterprise, x64, release 25H2 (the Enterprise evaluation edition counts), installed and fully updated, with no pending reboot. Any other product, edition, architecture, or release is refused with a message naming what it found. The guest also needs WinGet (App Installer) version 1.6.10121 or newer with a usable `winget` source.
- **One adapter, on the Default Switch.** A rerun also accepts the adapter on the Internal switch (see [Rerunning is a replay](#rerunning-is-a-replay)). A VM with more than one adapter, a disconnected adapter, or an adapter on any other switch is refused.
- **An existing guest user account** that is a **local** administrator (enabled, and a member of the local Administrators group). Setup acts through it and never creates it. Microsoft accounts, domain accounts, and non-administrators are not supported. Its PowerShell Direct session must have an elevated token; if it does not, the failure message tells you to use the built-in `Administrator` account or to disable UAC remote token filtering for the account.
- **The host network** (`susentorno create-host-network`, from [setup-machine.md](setup-machine.md)), the environment with its `vm-shared-windows` folder, the SMB share over that folder, and the **VM share account** (all from [setup-environment.md](setup-environment.md)). The SMB share must grant the VM share account read access only; setup fails if the account can write to it.
- **An elevated (Administrator) host terminal**, started in the environment directory (the one containing `.susentorno`).
- **`susentorno run-hosting` running** for the same environment and isolation name, before you start and throughout. It is checked at the start and again immediately before isolation.

The command does not create the VM, the guest user account, the host network, the SMB share, or the VM share account, and it does not start `run-hosting`.

#### Running it

```powershell
susentorno setup-guest-windows
```

Every non-secret answer can be given as a flag instead of a prompt, and each flag suppresses **only its own** prompt. Anything left off still prompts, in the order below.

| Flag | Answers | Default |
| --- | --- | --- |
| `--vm-name <name>` | Hyper-V VM name | none; prompted |
| `--share-name <name>` | SMB share name | prompt default `vm-shared-windows` |
| `--guest-username <user>` | Guest user account | none; prompted |
| `--share-account <name>` | VM share account | prompt default `susentorno` |
| `--isolation-name <name>` | The host network created by `susentorno create-host-network --isolation-name <name>` (letters, digits, and hyphens only) | omit it for the default `susentorno-internal` network |
| `--nat-adapter-alias <name>` | The Default-Switch adapter | `vEthernet (Default Switch)` |

There is no guest-address option, because PowerShell Direct does not use one, and there are **no password options**: `--guest-password` and `--share-password` are rejected as unknown options. Both passwords are masked prompts, so they never reach shell history, a process listing, a file, or the command's output. Automation supplies them by piping two lines into the command's stdin, the guest user account's password first and the VM share account's password second, once all four non-secret answers (`--vm-name`, `--share-name`, `--guest-username`, `--share-account`) are given as flags.

Everything that needs no answer is checked before the first prompt: host elevation, the environment and its Windows VM share, the isolation name, the adapter alias, and both switches and their host addresses. A problem there fails immediately without asking anything.

**Prompt order:**

1. `Hyper-V VM name`, then `SMB share name` (default `vm-shared-windows`). The command then checks the VM (it exists, is `Running` or `Off`, and has one adapter on the Default Switch or the Internal switch), that the SMB share points at this environment's Windows VM share, that `run-hosting` is listening for DHCP and DNS, and that the generated steps are well formed. A problem here is reported before either password is asked for.
2. `Guest username`, then `Guest password` (masked). The command then puts the VM on the Default Switch and starts it, waits for PowerShell Direct, authenticates, and checks the guest.
3. `VM share account` (default `susentorno`), then `VM share password` (masked). These come only after the guest has authenticated and passed its structural checks. Before it writes anything to the guest, the command also confirms on the host that the account exists, is enabled, and is granted read access by the SMB share.

Once the last password is entered the command runs unattended. Ending the input (EOF) or cancelling at any prompt ends the command as a cancellation (exit code `130`); if that happens before a VM has been chosen, nothing has been changed.

**Re-prompts come in pairs.** If the guest rejects the guest user account's credential, the command asks for the username _and_ the password again, even if the username came from a flag, so a wrong username is as easy to fix as a wrong password. The previous name is offered as the default. In the same way, if the guest cannot authenticate to the SMB share, the command asks for the VM share account _and_ its password again. Problems that a different password could not fix are never re-prompted. They are reported with a remediation instead: the account is not an administrator or its token is not elevated, the platform is unsupported, a reboot is pending, WinGet is missing or too old, the SMB share path is wrong or the share is writable, the VM share account does not exist on the host or lacks read access, or the guest already holds an SMB connection to that host address under a different identity.

#### What the command does

Each phase is announced as `setup-guest-windows: <phase> <description>...`, and a long wait prints a progress line about every 15 seconds. The phases are:

| Phase | What happens |
| --- | --- |
| H1 | Host prerequisites, then the VM name and share name prompts |
| H2 | Host checks (VM, adapter, switches, SMB share, `run-hosting` listeners) and the generated step plans |
| H3 | Guest username and password prompts |
| G1 | Reconcile the VM to the Default Switch and start it |
| G2 | Wait for PowerShell Direct and authenticate |
| G3 | Guest checks: platform, local administrator, elevated token, no pending reboot, WinGet |
| G4 | VM share account prompts; write and verify the Default-Switch share credential |
| G5 | Guest trust reconciliation |
| G6 | Run every pre-isolation step |
| G7 | Isolation gate: no pending reboot, and `run-hosting` still listening |
| G8 | Write the Internal-switch share credential (unverified until G12) |
| G9 | Stop the VM gracefully, connect its adapter to the Internal switch, start it |
| G10 | Wait for PowerShell Direct again |
| G11 | Prove the isolated network: a lease from `run-hosting` with the host as gateway, working DNS through the host, and a TCP connection to the proxy stack |
| G12 | Verify UNC access to the share at the Internal-switch host address |
| G13 | Run every post-isolation step |
| G14 | Success summary |

Fixed limits apply, and none of them has a flag: PowerShell Direct readiness 5 minutes, each share operation 1 minute, each step 30 minutes, isolated-network readiness 3 minutes, and a graceful stop about 3 minutes plus 60 seconds to confirm `Off`. The guest is never force-stopped, and the command never reboots it.

**Trust.** Before any step reaches the network, the command reconciles the guest's certificate trust. It adds the host's ambient trust roots (for example, the CA of a TLS-terminating corporate proxy) and the environment's proxy CA to the guest's `LocalMachine\Root` store, and points `NODE_EXTRA_CA_CERTS` at one combined bundle under `C:\ProgramData\susentorno\trust`, so Windows, Git, and Node trust the same roots. Ambient roots are only ever added. The proxy CA is replaced when the environment's `cert.pem` changes, and the old one is removed only if setup's own records prove it installed it. The shipped `configure-network` step only verifies this trust and sets Git to use `schannel`.

**Steps.** Pre-isolation steps run from `\\<default-switch-host-ip>\<share>\pre-scripts` and post-isolation steps from `\\<internal-switch-host-ip>\<share>\post-scripts`. Steps are the files named `NN-name.ps1` (two digits; the extension is case-insensitive), run in filename order. Other files are ignored, so a step can ship sibling resources. Each step runs in its own fresh, elevated Windows PowerShell 5.1 process started with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, working from its read-only UNC directory. The bypass applies to that one process only; the guest's persistent execution policy is never changed. Because each step is a new process, an earlier step's PATH change is visible to the next. Exit code `0` is the only success, and the sequence stops at the first step that fails, times out, or is cancelled. Each step's output is shown after it finishes, with stdout and stderr kept separate. Your own steps must check the exit code of every native command themselves, must not prompt, and must be idempotent; the generated `README.md` in your environment's `pre-scripts/` and `post-scripts/` folders spells out this contract.

**Accounts and share credentials.** The **guest user account** is the existing local administrator that the command acts through and that you develop in afterwards. The **VM share account** is a different, restricted account on the _host_ that the guest presents to read its VM share. It is never a guest logon, and the two accounts have unrelated passwords.

The command leaves two retained Credential Manager entries in the guest user account, one keyed by the Default-Switch host address and one by the Internal-switch host address, both holding the VM share account. They keep the share reachable if the VM is later moved to either switch. You can inspect them inside the guest with `cmdkey /list`: the targets show as `target=<host-address>`, and the password is never displayed. The command writes them through the native Credential Manager API, so the password never appears in a guest process argument, and it reaches the share by UNC path (`\\<host-address>\<share>`), taking no drive letter and leaving no mapped drive. A run rewrites each entry when it reaches the phase that writes it (G4 for the Default-Switch entry, G8 for the Internal-switch entry).

#### Rerunning is a replay

If any run fails or is cancelled, the recovery is always the same: fix what the message says, then **run the command again**. A rerun is a **replay from the Default Switch**. It is not a resume and it does not roll back.

- Nothing is rolled back on failure, and the command never detects how far a previous run got.
- The VM may be `Off` or `Running` on either expected switch. A VM running on the Default Switch is reused without a restart. A VM running on the Internal switch is stopped gracefully, returned to the Default Switch, and started; this is expected even for a guest that was fully set up. Saved, paused, or mid-transition VMs are refused rather than repaired.
- Every pre-isolation and post-isolation step runs again, including ones that already succeeded. **Customized steps must therefore be idempotent.** The shipped steps are: they skip packages that are already installed, and post-isolation auth configuration is refreshed on every replay, so a change of workspace takes effect when you rerun.
- Trust reconciliation only adds, so a partial trust failure leaves a safe state that the next replay converges from.

Ctrl+C cancels the in-flight guest operation, cleans up for up to about 30 seconds, prints the footer, and exits with `130`. A second Ctrl+C exits immediately. A failure exits with `1` and success with `0`.

#### Reading the residual-state footer

Every failure and cancellation ends with a footer that says what state the run left behind. The VM's power state and switch are queried from Hyper-V at that moment, not inferred. For example, a run that failed on the last post-isolation step:

```
setup-guest-windows: failed in phase G13 post-isolation steps at step 99-fail.ps1 [step-exit]: Step post-scripts/99-fail.ps1 exited with code 1. ...
setup-guest-windows: residual state
  Failed in phase: G13 post-isolation steps
  Failed step: 99-fail.ps1
  VM 'dev-vm': Running, attached to 'susentorno-internal'
  VM share credential for Default Switch host address 172.24.32.1: verified, kept
  VM share credential for Internal switch host address 192.168.67.1: verified, kept
  Nothing was rolled back.
  Rerun 'susentorno setup-guest-windows' to replay the whole flow from the Default Switch.
```

- **Failed in phase** (or **Cancelled during phase**) names a phase from the table above. **Failed step** (or **Interrupted step**) appears when a step was the cause. The bracketed word on the first line classifies the failure, for example `step-exit`, `step-timeout`, `guest-check`, `share-credential`, `guest-trust`, or `isolated-network`.
- The **VM line** is the queried power state and the switch the adapter is attached to. If the query itself fails, the footer says so instead of guessing. If the run ended before a VM was chosen, it says nothing was changed.
- Each **VM share credential line** is one of `verified, kept` (read access was proven, and it stays), `removed (written by this run but never verified)` (cleanup removed it, so a failure never leaves an unproven credential behind), `written but never verified (cleanup did not run)`, or `written but never verified, and could not be removed; rerunning replaces it`. You never need to delete an entry by hand: a rerun replaces the entries either way. A verified entry is never removed by a later failure.

As a rule of thumb for where the guest is left:

| Failed in | Typical residual state |
| --- | --- |
| H1 to H3 | Nothing changed. |
| G1 to G3 | VM on the Default Switch (or `Off` if a stop was interrupted); the guest untouched. |
| G4 | VM on the Default Switch; an unproven Default-Switch credential is removed. |
| G5 | VM on the Default Switch; trust partly reconciled, in a safe state; the Default-Switch credential is kept. |
| G6, G7 | VM on the Default Switch; some or all pre-isolation steps have run; the Default-Switch credential is kept. |
| G8, G9 | VM on the Default Switch, `Off`, or already on the Internal switch; the Internal-switch credential, unproven until G12, is removed. |
| G10 to G12 | VM `Running` on the Internal switch; the Default-Switch credential is kept, and the Internal-switch credential is removed unless verified. |
| G13 | VM `Running` on the Internal switch; both credentials kept. |

In every case the fix is the same: correct the reported problem and rerun.

**Pending reboot.** The command checks for a pending reboot at G3 and again at G7, because isolating a guest that still owes a reboot could strand it on the Internal switch. If it finds one, it fails naming the markers it found and saying to **restart the guest, then rerun**. Restart Windows in the guest (or from Hyper-V), let it come back up, and run the command again. The command never reboots the guest itself, and a shipped install step whose package asks for a reboot fails for the same reason.

**Other common failures:**

- PowerShell Direct readiness times out after 5 minutes: check in Hyper-V Manager that the VM booted to Windows with its integration services enabled, then rerun.
- The isolated network does not come up within 3 minutes: the message lists each unmet condition (`lease`, `gateway`, `dns`, or `proxy`) and points at `run-hosting`. Check that it is still running and that the host firewall allows its ports (see the firewall note below), then rerun. A Windows guest that booted before `run-hosting` was listening can take about five minutes to retry its lease, which is longer than this limit; see the next section.
- The generated steps are malformed (for example, no `configure-network` step, or several): run `susentorno update-shares` and check your customizations.

### If a guest comes up with no address

**If a guest ever comes up with no address**, `run-hosting` was not running when it booted. Start `run-hosting` and the guest will pick up a lease on its next retry — no action is needed inside the guest, but allow up to ~5 minutes before treating it as a failure. On **Windows** the guest falls back to a `169.254.x.x` self-assigned address and re-attempts on roughly a five-minute cycle (measured: 4m55s). On **Ubuntu** there is **no** APIPA fallback — `eth0` simply has no IPv4 address — and NetworkManager retries every 45s for three minutes, then goes quiet for about five minutes before trying again (measured: 2m53s from starting `run-hosting`, all of it spent inside that quiet gap). Neither wait can be shortened from the host. With `run-hosting` already running before boot, leases bind in well under a second. As a last resort, the Hyper-V console plus a static address (an IP in the Internal-switch subnet, no gateway, `nameserver = <host-ip>`) still works and is a supported fallback.

> **Before waiting out that timer, check the host firewall.** A guest with no address looks identical whether the DHCP server is absent or its replies are being dropped. `run-hosting` binds `:53` and `:67` on the Internal-switch adapter, whose network category is `Public`, so Windows may raise an "allow `node.exe` on public networks?" dialog and write a broad `Query User{…}` rule from whatever gets clicked — **Block** silently overrides all four correctly-scoped rules, and **Allow** masks their absence. Delete any such rule for the `run-hosting` `node.exe` (it is pnpm's global shim, `C:\Users\<user>\AppData\Local\pnpm\bin\node.exe`, not the repo's `dist/`) and add a program-scoped rule so the dialog has nothing to ask:
>
> ```powershell
> $node = "$env:LOCALAPPDATA\pnpm\bin\node.exe"
> Get-NetFirewallRule | Where-Object { $_.Name -like '*Query User*' -and $_.Name -like '*pnpm\bin\node.exe' } | Remove-NetFirewallRule
> New-NetFirewallRule -DisplayName 'susentorno run-hosting node (VM inbound)' -Direction Inbound `
>   -Program $node -InterfaceAlias 'vEthernet (susentorno-internal)' -Action Allow -Profile Any
> ```

## 3. Run the numbered scripts

The exact number of numbered steps may vary when custom steps are present.

**Ubuntu** — the Host-side `susentorno setup-guest-unix` command already did all of this: mounted the share, ran `pre-scripts/`, isolated the guest, re-mounted the share, and ran `post-scripts/`. Nothing further is needed here — see the manual fallback above if you need to reproduce or diagnose any individual step.

**Windows** — the Host-side `susentorno setup-guest-windows` command already did all of this: put the guest on the Default Switch, ran `pre-scripts/`, isolated the guest, and ran `post-scripts/` from the Internal-switch address. Nothing further is needed here. There is no manual per-script procedure for Windows; if a run stops early, read its message and residual-state footer (see [Reading the residual-state footer](#reading-the-residual-state-footer)) and rerun the command.

## 4. Isolate

Confirm the host firewall is open and `run-hosting` is running (both from `setup-machine.md` / `setup-environment.md`) before booting a guest into the isolated network:

```powershell
susentorno create-host-network
susentorno run-hosting
```

`susentorno setup-guest-unix` and `susentorno setup-guest-windows` do the isolation for you, so this section is for the Ubuntu manual fallback above and for reference. The VM's single adapter is reassigned like this:

```powershell
Stop-VM -Name '<VMName>'
Connect-VMNetworkAdapter -VMName '<VMName>' -SwitchName 'susentorno-internal'
Start-VM -Name '<VMName>'
```

Reassign back to `Default Switch` to reverse isolation; no guest-side change is needed. Rerunning a setup command does the same reversal for you as its first step.

## Next step

Continue to [diagnostics.md](diagnostics.md) to verify the environment and guest are configured correctly.

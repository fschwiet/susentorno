# Guest setup

Create and configure a guest VM under Hyper-V, isolated behind the host proxy. May be repeated for any number of guests; each guest pairs with one environment via its shared folder. Complete [setup-machine.md](setup-machine.md) and [setup-environment.md](setup-environment.md) first, so the environment's `vm-shared-linux/` and `vm-shared-windows/` folders contain `cert.pem`, `github-config.txt`, and `credentials.json`.

Both guest OSes stay on **DHCP** throughout: on the Default Switch they lease from Hyper-V's ICS (real gateway and DNS, so packages install) during setup, and on `susentorno-internal` they lease from `run-hosting` once isolated, which supplies the host as both router and DNS. Nothing inside the guest changes between the two, which is what makes switching networks a purely host-side operation.

This doc continues as if `192.168.67.x` was chosen as the subnet and the host was assigned `192.168.67.1` in `setup-machine.md`.

## 1. Prepare the VM

### Image options

- Hyper-V Manager includes some images but the version seems to fall behind what is available if you download your own image.
- To use an included image: "Hyper-V Manager -> Action -> Quick Create"
  - An Ubuntu option is available, pick the latest LTS.
  - A time-limited Windows 11 Dev environment based on Windows Enterprise can be chosen with some pre-installed software. The time limit is not known but I'd guess 90 days.
- To start with your own image: "Hyper-V Manager -> Action -> New -> Virtual Machine"
  - Ubuntu can be downloaded from: https://ubuntu.com/download
  - A 90-day evaluation ISO for Windows Enterprise can be downloaded from https://info.microsoft.com/ww-landing-windows-11-enterprise.html
- It was observed that the included Windows image took 54.6GB of disk space after running all Windows updates while the evaluation ISO for Windows Enterprise took 26.7 GB for Windows with updates

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

Then, from the Host, in an **elevated (Administrator) PowerShell**, run the environment's setup command. It mounts the share, runs `pre-scripts/`, isolates the guest onto `susentorno-internal`, re-mounts the share there, and runs `post-scripts/` — the entire remaining Ubuntu flow in one command:

```powershell
susentorno setup-guest-unix
```

It prompts for the Hyper-V VM name, the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno-share`), and the share password from setup-environment.md. Before prompting for anything it checks that the terminal is elevated and, once the VM name is given, that the VM exists with exactly one network adapter and that both `susentorno-internal` and `Default Switch` resolve to real Hyper-V switches — a typo or a missing prerequisite fails fast with a specific message rather than partway through.

A few things worth knowing before running it:

- **`run-hosting` must already be running** (and stay running) before and during isolation — the command checks this both before touching the VM and again right before isolating it, but a `run-hosting` that stops mid-run between those two checks (during the potentially multi-minute `pre-scripts/` run) is caught only at the second check.
- **Every rerun of an already-isolated guest briefly reattaches it to the Default Switch** — there's no phase-detection/resume logic, so a rerun always executes all 8 steps from the top, including a round-trip through the internet-facing Default Switch and back. This is expected, not a bug: it's what makes "just rerun the whole command" a safe recovery path after a failure.
- **A graceful-shutdown timeout is a failure, not an auto-forced power-off.** If the guest doesn't reach `Off` within the timeout after a graceful `Stop-VM`, the command stops and asks you to investigate or force-stop it manually — it will not call `Stop-VM -Force` on your behalf, since a stuck shutdown usually means something is genuinely wrong inside the guest.
- **A woven-in custom `pre-scripts/`/`post-scripts/` addition must be safe to rerun**, same as today — every invocation reruns the whole pipeline unconditionally.
- **The command installs a Hyper-V KVP/Data Exchange daemon package** on the guest as part of its own setup (separate from anything `pre-scripts/` itself installs) — this is what lets the command discover the guest's address automatically after isolation, when no prompted address is valid anymore.
- **Four distinct addresses are in play** across this command: the guest's own DHCP lease on the Default Switch, the guest's own (different) DHCP lease on `susentorno-internal`, the Windows host's address on the Default Switch, and the Windows host's address on `susentorno-internal`. If a failure message is unclear about which one it means, this is the ordering to check against.

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
username=susentorno-share
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

The share then lives at `/mnt/vm-shared-linux`. `cd` into `pre-scripts/` and run every script in number order; the last is `05-configure-network.sh <host-ip>` when there are no custom scripts, where `<host-ip>` is the Internal-switch host IP from setup-machine.md.

**Isolate** — confirm the host firewall is open and `run-hosting` is running (both from `setup-machine.md`/`setup-environment.md`), then see "Isolate" in §4 below for the `Stop-VM`/`Connect-VMNetworkAdapter`/`Start-VM` sequence. Wait for the guest to come back up, then redo the mount step above with the Internal-switch host IP.

**Post-scripts** — `cd` into `post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.

Before installing anything else, the automated command also installs a Hyper-V KVP/Data Exchange daemon package (`linux-cloud-tools-virtual` at the time of writing — see `src/guestSetup/kvpDaemon.ts`) so `Get-VMNetworkAdapter`'s reported IP addresses work; if reproducing this by hand for diagnosis, `sudo apt-get install -y linux-cloud-tools-virtual` is that step. Its `hv-kvp-daemon.service` only comes up once the guest has rebooted since install — not an issue in the automated flow, since isolation reboots the guest before anything depends on the daemon, but if you install it by hand without a reboot the service will sit `inactive` until one happens (or until `sudo udevadm trigger && sudo udevadm settle` re-registers its vmbus device).

</details>

**Windows guest** — leave the adapter on DHCP. Default Switch uses Hyper-V ICS; `susentorno-internal` uses `run-hosting` with the host as router and DNS. Save credentials with:

```powershell
cmdkey /add:192.168.67.1 /user:susentorno-share /pass:<the password from setup-environment.md>
```

`cmdkey` entries are **per-address**, so add one for the Default Switch host IP as well if you mount the share during the NAT phase. The share is then reachable at `\\192.168.67.1\vm-shared-windows` — the numbered scripts run from there. Two host addresses appear across this flow:

- `<default-switch-host-ip>` — the temporary address used to reach the SMB share while the VM is attached to the Default Switch.
- `<internal-switch-host-ip>` — the stable address assigned to `vEthernet (susentorno-internal)` in `setup-machine.md`. Pass this address to the network configuration script and use it after isolation.

> **If a guest ever comes up with no address**, `run-hosting` was not running when it booted. Start `run-hosting` and the guest will pick up a lease on its next retry — no action is needed inside the guest, but allow up to ~5 minutes before treating it as a failure. On **Windows** the guest falls back to a `169.254.x.x` self-assigned address and re-attempts on roughly a five-minute cycle (measured: 4m55s). On **Ubuntu** there is **no** APIPA fallback — `eth0` simply has no IPv4 address — and NetworkManager retries every 45s for three minutes, then goes quiet for about five minutes before trying again (measured: 2m53s from starting `run-hosting`, all of it spent inside that quiet gap). Neither wait can be shortened from the host. With `run-hosting` already running before boot, leases bind in well under a second. As a last resort, the Hyper-V console plus a static address (an IP in the Internal-switch subnet, no gateway, `nameserver = <host-ip>`) still works and is a supported fallback.
>
> **Before waiting out that timer, check the host firewall.** A guest with no address looks identical whether the DHCP server is absent or its replies are being dropped. `run-hosting` binds `:53` and `:67` on the Internal-switch adapter, whose network category is `Public`, so Windows may raise an "allow `node.exe` on public networks?" dialog and write a broad `Query User{…}` rule from whatever gets clicked — **Block** silently overrides all four correctly-scoped rules, and **Allow** masks their absence. Delete any such rule for the `run-hosting` `node.exe` (it is pnpm's global shim, `C:\Users\<user>\AppData\Local\pnpm\bin\node.exe`, not the repo's `dist/`) and add a program-scoped rule so the dialog has nothing to ask:
>
> ```powershell
> $node = "$env:LOCALAPPDATA\pnpm\bin\node.exe"
> Get-NetFirewallRule | Where-Object { $_.Name -like '*Query User*' -and $_.Name -like '*pnpm\bin\node.exe' } | Remove-NetFirewallRule
> New-NetFirewallRule -DisplayName 'susentorno run-hosting node (VM inbound)' -Direction Inbound `
>   -Program $node -InterfaceAlias 'vEthernet (susentorno-internal)' -Action Allow -Profile Any
> ```

## 3. Run the numbered scripts

Run without `sudo`/outside an elevated shell only where noted; each script elevates internally where needed. The exact count may vary when custom steps are present.

**Ubuntu** — the Host-side `susentorno setup-guest-unix` command already did all of this: mounted the share, ran `pre-scripts/`, isolated the guest, re-mounted the share, and ran `post-scripts/`. Nothing further is needed here — see the manual fallback above if you need to reproduce or diagnose any individual step.

**Windows**, in an **elevated (Administrator) PowerShell**:

```powershell
cd "\\<default-switch-host-ip>\vm-shared-windows\"
Set-ExecutionPolicy Bypass
```

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <internal-switch-host-ip>`.
2. Isolate the VM — reassign its single adapter to `susentorno-internal` (see "Isolate" below), with `run-hosting` already running.
3. Use the `cmdkey` entry for `<internal-switch-host-ip>`, then run every post-script in order from `\\<internal-switch-host-ip>\vm-shared-windows\post-scripts`: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.
4. Restore the normal execution policy with `Set-ExecutionPolicy RemoteSigned`.

When a script asks for `<host-ip>` (`05-configure-network.sh` / `05-configure-network.ps1`), it is the Internal-switch host IP from `setup-machine.md` (`192.168.67.1` here).

## 4. Isolate

Confirm the host firewall is open and `run-hosting` is running (both from `setup-machine.md` / `setup-environment.md`) before booting a guest into the isolated network:

```powershell
powershell -File .susentorno\proxy\host-allow-vm-inbound.ps1
susentorno run-hosting
```

Then isolate the VM by reassigning its single adapter:

```powershell
Stop-VM -Name '<VMName>'
Connect-VMNetworkAdapter -VMName '<VMName>' -SwitchName 'susentorno-internal'
Start-VM -Name '<VMName>'
```

Reassign back to `Default Switch` to reverse isolation; no guest-side change is needed.

## Next step

Continue to [diagnostics.md](diagnostics.md) to verify the environment and guest are configured correctly.

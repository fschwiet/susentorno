# Hosting with Hyper-V

Run a Windows or Ubuntu guest under **Hyper-V Manager**, isolated behind the host proxy. This doc covers the full host + VM setup — creating the VM, the virtual switch, static IPs, sharing the environment folder, and isolating the network. Once the shared folder is mounted, the guest follows the numbered-script flow:

- **Ubuntu guest:** the numbered scripts and verification in `README.md` ("VM setup" onward).
- **Windows guest:** the numbered scripts in `usage-windows-vm.md`.

The host side needs no code changes: both `configamatron run-proxy` and `host-allow-vm-inbound.ps1` default to the `vEthernet (configamatron-internal)` adapter, so no overrides are needed when you name the switch `configamatron-internal` as below.

Complete the host "Proxy setup" (`README.md`) first, so the environment's `vm-shared/` and `vm-shared-windows/` folders contain `cert.pem`, `github-config.txt`, and `credentials.json`.

## Networking and file sharing

Hyper-V has no transparent shared-folder mechanism, so we keep the host's environment folder **live** in the guest over a network file share (SMB). This matters because the guest's `~/.claude/.credentials.json` is symlinked to the shared `credentials.json` and the proxy rotates that file; a one-time copy-in (ISO, `Copy-VMFile`) would freeze the credential and is not an option. Note that these credential files sync'd to the VM do not contain the actual credentials but rather a placeholder — the proxy injects the real credentials. What is being sync'd is the rest of the information in ~/.claude/.credentials.json.

The isolated network is an **Internal virtual switch** (host + VMs, no internet). `run-proxy` supplies DHCP and DNS on it. The host IP is stable, and it is the one value that threads through the entire setup:

> **One host IP, used everywhere:** the static IPv4 you assign to the host's `vEthernet (<SwitchName>)` adapter is simultaneously the SMB server address, the IP that `host-allow-vm-inbound.ps1` reports, the `run-proxy --forward-listen` target, and the `<host-ip>` argument to the `07-*` scripts. This configuration remains stable during VM setup when network access is direct to the internet and after the VM is isolated and network traffic must go through the proxy.

> **Two host addresses, only one stable.** The Default Switch address used during the NAT phase is regenerated across host reboots. Look it up with `Get-NetIPAddress -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4` when needed.

## 1. Create the Internal switch and assign the host IP

First, identify which subnet will be used as an isolated network for your VMs. Run the 'ipconfig' command to find a subnet that is not taken (n in 192.168.n.x). The host IP will be .1 in that subnet. For this document we'll assume the 192.168.67.x subnet is used, so the host will be 192.168.67.1.

In an **Administrator** PowerShell on the host:

```powershell
New-VMSwitch -Name "configamatron-internal" -SwitchType Internal
# Assign a stable host IP on the resulting vEthernet adapter (no DHCP on an Internal switch):
New-NetIPAddress -InterfaceAlias "vEthernet (configamatron-internal)" -IPAddress 192.168.67.1 -PrefixLength 24
```

## 2. Create the dedicated share account

Storing a host credential inside the VM is a real exposure: the isolation boundary is **code running in the VM vs. the host**, and the SMB credential has to sit in a file the guest reads at boot — so VM-resident code can read it too. Make the account powerless so a leak grants nothing beyond the folder read the VM already has. Remember this password for when you set up VMs.

```powershell
$pw = Read-Host -AsSecureString "Password for configamatron-share"
New-LocalUser -Name "configamatron-share" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
```

Then, in **Local Security Policy** (`secpol.msc`) → Local Policies → User Rights Assignment, add `configamatron-share` to **Deny log on locally** and **Deny log on through Remote Desktop Services**.

Then in **Computer Management** -> "Local Users and Groups" -> "configamatron-share" -> "MemberOf" add the Users group and ensure no other group is added (which only grants "Access this computer from the network").

Do not enable guest/anonymous SMB access as an alternative — modern Windows blocks insecure guest auth by default and enabling it weakens the whole host.

## 3. Share both environment folders (read-only)

Create SMB shares for **both** `vm-shared` and `vm-shared-windows`, each granting only `configamatron-share` read access. A guest mounts whichever one matches its OS.

```powershell
$env_dir = "E:\repo\.configamatron"   # the environment's .configamatron folder
New-SmbShare -Name "vm-shared"         -Path "$env_dir\vm-shared"         -ReadAccess "configamatron-share"
New-SmbShare -Name "vm-shared-windows" -Path "$env_dir\vm-shared-windows" -ReadAccess "configamatron-share"
```

`host-allow-vm-inbound.ps1` scopes SMB (TCP 445) to the Internal-switch and Default Switch adapters. It is never exposed on the external NIC.

```powershell
New-NetFirewallRule -DisplayName "Configamatron VM share (SMB inbound)" `
    -Direction Inbound -Protocol TCP -LocalPort 445 `
    -InterfaceAlias "vEthernet (configamatron-internal)" -Profile Any -Action Allow
```

## 4. Prepare the VM

### Image options

- Hyper-V Manager includes some images but the version seems to fall behind what is available if you download your own image.
- To use an included image: "Hyper-V Manager -> Action -> Quick Create
  - An Ubuntu option is available, pick the latest LTS
  - A time-limited Windows 11 Dev environment based on Windows Enterprise can be chosen with some pre-installed software. The time limit is not known but I'd guess 90 days.
- To start with your own image: "Hyper-V Manager -> Action -> New -> Virtual Machine"
  - Ubuntu can be download from: https://ubuntu.com/download
  - A 90-day evaluation ISO for Windows Enterprise can be downloaded from https://info.microsoft.com/ww-landing-windows-11-enterprise.html

- Observations:
  - The included Windows 11 dev VM used 54.6 gb for Windows with updates and its included applications, then took 71.5 gb after running the configamatron install scripts.

### VM Creation

- Initial Creation Wizard
  - Select Generation 2 for the VM generation
  - I've been using 12288 mb of memory and 127 gb of disk space

- Modify the "Settings" scoped to the VM before starting the VM

  - Hardware -> Network Adapter
    - Set "Virtual Switch" to **"Default Switch"** for now. The VM uses one adapter throughout; only the switch changes.

  - Hardware -> Network Adapter 1
    - Set "Virtual Switch" to "configamatron-internal" (this is the VM's permanent network, used even when its switch to isolated mode)

  - Hardware -> Network Adapter 2
    - You may want to leave this one unconnected if you are installing Windows so the OS installation won't box you into creating a putting credentials for a Microsoft account on your isolated VM.
    - Keep the single adapter on "Default Switch" during setup.

  - Hardware -> Security => Secure Boot
    - For Windows
      - "Enable Secure Boot" should be checked, use the default "Microsoft Windows" template
      - "Enable Trusted Platform Module" should be checked if your OS requires it (True for Windows 11 Enterprise)
        - "Encrypt state and virtual machine migration traffic" seems safe to check
    - For Ubuntu
      - set the Secure Boot template to "Microsoft UEFI Certificate Authority" or disable Secure Boot.

  - Management -> Checkpoints
    - Consider disabling "Use automatic checkpoints" because its annoying

  - Management -> Automatic Start Action
    - Consider setting to "nothing" to avoid starting the VM everytime you log into the host

  - Management -> Automatic Stop Action
    - Consider setting to "shut down" to mimic the host's behavior- that which isn't saved on shutdown was not worth saving

### OS installation

- If you left the second network adapter unconnected for a Windows install, configure it to use the "Default switch" now in VM settings.

- Go ahead and start the machine and install any pending updates.
  - It can be tricky to initiate booting from CD/DVD before it tries a network install. You need to press a key quickly after starting the VM to catch the "press any key to install from CD or DVD" message before it opts to try the network.
  - Restart the machine and check for updates, repeat until none are found.

### Nested Virtualization

A reference on setting up nested virtualization with Hyper-V https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization#enable-nested-virtualization

- Make sure you have the right features enabled in BIOS for the host: Intel VT-x (Virtualization Technology) with EPT (Extended Page Tables) or AMD-V (AMD Virtualization) with NPT (Nested Page Tables)

- Make sure you're host has the relevant optional Windows features enabled.
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

  - While the VM is off, run (elevated):

    ```powershell
    Set-VMProcessor -ExposeVirtualizationExtensions $true
    ```

  - Start the VM so it can run some updates sometimes needed after enabling nested virtualization.

### Recommended Save Point

- Shut down the VM and create a checkpoint before continuing, call it "Windows Installed and Updated". This will provide a baseline you can return to if your network setup changes.

Hyper-V tip on **managing UI focus**: When the VM is selected it will capture keyboard controls, for instance alt-tab will enumerate applications in the VM. Use Ctrl+Alt+UpArrow to return focus to the host level, such that alt-tab enumerates host applications.

## 5. Configure the guest network and mount the share

Give the guest's **Internal-switch** interface a static IP in the same subnet, with **no gateway** — egress leaves through the proxy DNAT rules that the `07-*` script installs later. During setup the **Default Switch** adapter supplies the gateway and DNS (internet); it goes away when you isolate.

This guide continues as if 192.168.67.x was chosen as the subnet and the host was already assigned 192.168.67.1. In this guide we'll use 192.168.67.2 for the Ubuntu VM and 192.168.67.3 for the Windows VM. Feel free to adjust according to the subnet you're using.

**Ubuntu guest** — static IP via netplan (use a filename that won't collide with the `60-dns-override.yaml` that script 07 writes), then a boot-time CIFS mount:

```yaml
# /etc/netplan/50-internal-static.yaml  (set the interface name to the Internal-switch NIC)
network:
  version: 2
  ethernets:
    eth1:
      addresses: [192.168.67.2/24]
```

```bash
sudo netplan apply # bring the static IP up before mounting
```

```bash
# Credentials file, readable only by root:
sudo tee /etc/configamatron-share.cred > /dev/null << 'EOF'
username=configamatron-share
password=<the password from step 2>
EOF
sudo chmod 600 /etc/configamatron-share.cred

sudo mkdir -p /mnt/vm-shared
# /etc/fstab — auto-mounts at boot so the credentials symlink resolves:
echo '//192.168.67.1/vm-shared  /mnt/vm-shared  cifs  ro,credentials=/etc/configamatron-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount  0  0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
```

The share now lives at `/mnt/vm-shared` — the numbered scripts run from there.

**Windows guest** — leave the adapter on DHCP. Default Switch uses Hyper-V ICS; `configamatron-internal` uses `run-proxy` with the host as router and DNS. Save credentials with:

```powershell
cmdkey /add:192.168.67.1 /user:configamatron-share /pass:<the password from step 2>
```

The share is then reachable at `\\192.168.67.1\vm-shared-windows` — the numbered scripts run from there.

## 6. Run the numbered scripts

Follow the existing docs — nothing about the scripts changes. The **only** substitution is the folder you run them from:

Ok, one thing changes. On Windows, enable remote unsigned scripts before running the scripts:

> Set-ExecutionPolicy Bypass

Once done, set a more reasonable policy:

> Set-ExecutionPolicy RemoteSigned

| Guest | Existing doc | Run scripts from |
| --- | --- | --- |
| Ubuntu | `README.md` ("Run the numbered scripts from the VM") | `/mnt/vm-shared` |
| Windows | `usage-windows-vm.md` ("Run the numbered scripts") | `\\192.168.67.1\vm-shared-windows` |

When a script asks for `<host-ip>` (`05-configure-network.sh` / `05-configure-network.ps1`), it is the Internal-switch host IP from step 1 (`192.168.67.1` here).

### Start the host services before booting the VM into the isolated network

Start the firewall and `run-proxy` before the first isolated boot; they provide the guest's DNS and DHCP.

```powershell
powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1
configamatron run-proxy
```

## 7. Isolate

On the **host**, open the firewall and start forwarding. Both default to the `vEthernet (configamatron-internal)` adapter, so no overrides are needed when the switch is named `configamatron-internal`:

```powershell
# Firewall for Envoy 80/443, DNS 53, DHCP 67 and SMB; prints the host IP:
powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1

# Gateway + DNS + DHCP on that adapter:
configamatron run-proxy
```

(If your switch has a different name, pass `-AdapterAlias "vEthernet (<SwitchName>)"` to the firewall script and `--forward-listen <host-ip>` to `run-proxy`.)

Then isolate the VM by reassigning its single adapter:

```powershell
Stop-VM -Name '<VMName>'
Connect-VMNetworkAdapter -VMName '<VMName>' -SwitchName 'configamatron-internal'
Start-VM -Name '<VMName>'
```

Confirm `run-proxy` is running before booting. Reassign back to `Default Switch` to reverse isolation; no guest-side change is needed.

## 8. Verify

Run the read-only checks (`-AdapterAlias` defaults to the Internal-switch adapter, so no override is needed when the switch is named `configamatron-internal`):

- **Host (proxy):** with the proxy up, run `.configamatron\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** `/mnt/vm-shared/verify-config.sh 192.168.67.1`.
- **Windows guest:** `.\verify-config.ps1 192.168.67.1` from the mounted `vm-shared-windows` share.

Each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed. Omit the host IP to have the script discover and report it from the installed config.

## Security note: the share account

The isolation boundary configamatron enforces is **code running in the VM vs. the host**, not merely a human operator. Because the SMB credential must be stored where the guest can read it at boot, code inside the VM can read it too. That is why `configamatron-share` is scoped to read-only access on the two shared folders and denied interactive logon: even if VM-resident code exfiltrates the credential, all it grants is the folder read the VM already had.

The shared `credentials.json` and GitHub `github-config.txt` are both **placeholders** — the real Claude token and the real GitHub PAT are injected on the wire by the proxy, never stored in the VM. `configamatron-share` is the only credential anywhere in the VM — one more reason to keep it as inert as possible.

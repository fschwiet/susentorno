# Hosting with Hyper-V

Run a Windows or Ubuntu guest under **Hyper-V Manager** instead of VMware, isolated behind the host proxy. This doc covers only what Hyper-V does differently — creating the VM, virtual switches, static IPs, sharing the environment folder, and isolating the network. Once the shared folder is mounted, the guest follows the existing numbered-script flow unchanged:

- **Ubuntu guest:** the numbered scripts and verification in `README.md` ("VM setup" onward).
- **Windows guest:** the numbered scripts in `usage-windows-vm.md`.

The host side needs no code changes. `configamatron run-proxy` and `host-allow-vm-inbound.ps1` both take parameters that point them at the Hyper-V adapter instead of the VMware one; those substitutions are called out below.

Complete the host "Proxy setup" (`README.md`) first, so the environment's `vm-shared/` and `vm-shared-windows/` folders contain `cert.pem`, `github-config.txt`, and `credentials.json`.

## Why this is different from VMware

Hyper-V has no transparent Shared Folders mechanism (`/mnt/hgfs`, `\\vmware-host\Shared Folders`). The only way to keep a host folder **live** in the guest — which we need, because the guest's `~/.claude/.credentials.json` is symlinked to the shared `credentials.json` and the proxy rotates that file — is a network file share (SMB). A one-time copy-in (ISO, `Copy-VMFile`) would freeze the credential and is not an option. Note that these credential files sync'd to the VM do not contain the actual credentials but rather a placeholder- the proxy injects the real credentials. What is being sync'd is the rest of the information in ~/.claude/.credentials.json.

Hyper-V's analog of VMware's host-only network is an **Internal virtual switch** (host + VMs, no internet). Unlike VMware host-only, an Internal switch runs **no DHCP**, so the host adapter and the guest both get **static IPs**. That host IP is stable, and it is the one value that threads through the entire setup:

> **One host IP, used everywhere:** the static IPv4 you assign to the host's `vEthernet (<SwitchName>)` adapter is simultaneously the SMB server address, the IP that `host-allow-vm-inbound.ps1` reports, the `run-proxy --forward-listen` target, and the `<host-ip>` argument to the `07-*` scripts. This configuration remains stable during VM setup when network access is direct to the internet and after the VM is isolated and network traffic must go through the proxy.

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

Scope SMB (TCP 445) to the Internal adapter only — never expose it on the external NIC — mirroring how `host-allow-vm-inbound.ps1` scopes 80/443:

```powershell
New-NetFirewallRule -DisplayName "Configamatron VM share (SMB inbound)" `
    -Direction Inbound -Protocol TCP -LocalPort 445 `
    -InterfaceAlias "vEthernet (configamatron-internal)" -Profile Any -Action Allow
```

## 4. Create the VM

Create a **Generation 2** VM in Hyper-V Manager.

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

### Edit Settings

- Hardware -> Add Hardware
  - Add a second network adapter.

- Hardware -> Network Adapter 1
  - Set "Virtual Switch" to "configamatron-internal" (this is the VM's permanent network, used even when its switch to isolated mode)

- Hardware -> Network Adapter 2
  - Set "Virtual Switch" to "Default Switch" (Hyper-V's built-in NAT switch, added **temporarily** to provide internet during setup. You remove it in the isolate step.)

- Hardware -> Security => Secure Boot
  - **for Windows** (no change) Enable Secure Boot should be checked, use the default "Microsoft Windows" template
  - **for Ubuntu** set the Secure Boot template to "Microsoft UEFI Certificate Authority" or disable Secure Boot.

- Hardware -> Memory
  - I've been using 12288 MB

- Management -> Checkpoints
  - Consider disabling "Use automatic checkpoints" because its annoying

- Management -> Automatic Start Action
  - Consider setting to "nothing" because starting the VM everytime the host is started is insane

- Management -> Automatic Stop Action
  - Consider setting to "shut down" to mimic the host's behavior- that which isn't saved on shutdown was not worth saving

### Finish Creation

This concludes the pre-startup portion of VM creation.

- Go ahead and start the machine and install any pending updates.
  - Restart the machine and check for updates, repeat until none are found.

- Consider shutting down the VM and creating a checkpoint before continuing, call it "Windows Installed and Updated". This will provide a baseline you can return to if your network setup changes.

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

The share now lives at `/mnt/vm-shared` — this is the Hyper-V substitute for `/mnt/hgfs/vm-shared` used with the VMWare setup.

**Windows guest** — static IP and a saved credential so UNC access works without prompting:

```powershell
New-NetIPAddress -InterfaceAlias "Ethernet 2" -IPAddress 192.168.67.3 -PrefixLength 24   # Internal-switch NIC
cmdkey /add:192.168.67.1 /user:configamatron-share /pass:<the password from step 2>
```

The share is then reachable at `\\192.168.67.1\vm-shared-windows` — this is the Hyper-V substitute for `/mnt/hgfs/vm-shared-windows` used with the VMWare setup.

## 6. Run the numbered scripts

Follow the existing docs — nothing about the scripts changes. The **only** substitution is the folder you run them from:

Ok, one thing changes. On Windows, enable remote unsigned scripts before running the scripts:

> Set-ExecutionPolicy Bypass

Once done, set a more reasonable policy:

> Set-ExecutionPolicy RemoteSigned

| Guest | Existing doc | Run scripts from |
| --- | --- | --- |
| Ubuntu | `README.md` ("Run the numbered scripts from the VM") | `/mnt/vm-shared` instead of `/mnt/hgfs/vm-shared` |
| Windows | `usage-windows-vm.md` ("Run the numbered scripts") | `\\192.168.67.1\vm-shared-windows` instead of `\\vmware-host\Shared Folders\vm-shared-windows` |

When a script asks for `<host-ip>` (`05-configure-network.sh` / `05-configure-network.ps1`), it is the Internal-switch host IP from step 1 (`192.168.67.1` here).

## 7. Isolate

On the **host**, point the proxy's networking at the Hyper-V adapter (the auto-detection defaults to the VMware adapter):

```powershell
# Firewall for Envoy 80/443, scoped to the Internal adapter; prints the host IP:
powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1 -AdapterAlias "vEthernet (configamatron-internal)"

# Forward that adapter's :80/:443 to Envoy on loopback:
configamatron run-proxy --forward-listen 192.168.67.1
```

Then isolate the VM: in VM → Settings, **remove the temporary Default Switch adapter**, leaving only the Internal-switch adapter. Reboot the VM so the boot-time DNS/DNAT rules take effect. The VM can now reach only the host.

## 8. Verify

Unchanged from the VMware flow, just from the new mount path — except the host check needs `-AdapterAlias` so its VM-path probes hit the Internal-switch adapter instead of the (still-present, unused) VMware one:

- **Host (proxy):** with the proxy up, run `.configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (configamatron-internal)"`.
- **Ubuntu guest:** `/mnt/vm-shared/verify-config.sh 192.168.67.1`.
- **Windows guest:** `.\verify-config.ps1 192.168.67.1` from the mounted `vm-shared-windows` share.

Each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed. Omit the host IP to have the script discover and report it from the installed config.

## 9. Enable Nested Virtualization

ref: https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization#enable-nested-virtualization

Run the following to enable nested virtualization. This requires turning on a thing in BIOS. You will be prompted for the VM name.

```powershell
Set-VMProcessor -ExposeVirtualizationExtensions $true
```

## Security note: the share account

The isolation boundary configamatron enforces is **code running in the VM vs. the host**, not merely a human operator. Because the SMB credential must be stored where the guest can read it at boot, code inside the VM can read it too. That is why `configamatron-share` is scoped to read-only access on the two shared folders and denied interactive logon: even if VM-resident code exfiltrates the credential, all it grants is the folder read the VM already had.

The shared `credentials.json` and GitHub `github-config.txt` are both **placeholders** — the real Claude token and the real GitHub PAT are injected on the wire by the proxy, never stored in the VM. `configamatron-share` is the only credential anywhere in the VM — one more reason to keep it as inert as possible.

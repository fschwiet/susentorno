# Windows guest VM setup

Provision a Windows guest that runs the claude/codex agents against Windows-specific work, isolated behind the host proxy. Complete host "Proxy setup" (README.md) first, so `.configamatron/vm-shared-windows/` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

## Create the VM

- In VMware Workstation, create a Windows 11 VM. Leave the network as **NAT** for initial setup (pre-isolation).
  - A 90-day evaluation ISO can be downloaded from https://info.microsoft.com/ww-landing-windows-11-enterprise.html
- In network settings, disable "Connect at power on" to avoid needing a Windows account.
- Install Windows, then install **VMware Tools** (enables Shared Folders).

## Share the environment folder

Shut the VM down, then in VM → Settings → Options → Shared Folders: enable only the environment's `.configamatron\vm-shared-windows` folder, read-only. In a Windows guest the share appears at `\\vmware-host\Shared Folders\vm-shared-windows` (the analog of Ubuntu's `/mnt/hgfs`).

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**. The exact script count may vary when custom steps are present.

> cd "\\vmware-host\Shared Folders\vm-shared-windows\"

> Set-ExecutionPolicy RemoteSigned

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <ip>`.
2. Switch the VM network from NAT to **host-only**, then reboot.
3. `cd ..\post-scripts` and run every script in order: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.

## Verify

Inside the VM, run `.\verify-config.ps1 [host-ip]`. It prints one PASS/FAIL/WARN line per check and exits non-zero if anything failed. Omit `host-ip` to have it discover and report the value from the installed responder config.

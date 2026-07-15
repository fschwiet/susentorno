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

Open an **elevated (Administrator) PowerShell**, `cd` to the shared folder, and run the scripts in order. Open a **new terminal** where noted so PATH changes take effect.

> cd "\\vmware-host\Shared Folders\vm-shared-windows\"

> Set-ExecutionPolicy RemoteSigned

1. `.\01-install-packages.ps1`
2. `.\02-install-pnpm.ps1`
3. New terminal, then `.\03-install-tools.ps1`
4. New terminal, then `.\04-configure-tools.ps1`
5. `.\05-github-auth.ps1`
6. `.\06-trust-ca.ps1` — trusts the proxy CA (defaults to the `cert.pem` beside the script).
7. `.\07-setup-network.ps1 <host-ip>` — `<host-ip>` is printed by proxy setup step 5. Publishes the DNS responder, registers it as a startup task, and points the VM's DNS at it.
8. `.\08-claude-config.ps1` — sets the onboarding flag and installs the placeholder credential.
9. Switch the VM's network from NAT to **host-only**, then reboot so the isolation takes effect.

## Verify

Inside the VM, run `.\verify-config.ps1 [host-ip]`. It prints one PASS/FAIL/WARN line per check and exits non-zero if anything failed. Omit `host-ip` to have it discover and report the value from the installed responder config.

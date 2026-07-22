# Windows guest VM setup

Provision a Windows guest that runs the claude/codex agents against Windows-specific work, isolated behind the host proxy. Complete host "Proxy setup" (README.md) first, so `.configamatron/vm-shared-windows/` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

## Create the VM and share the folder

VM creation, the Internal switch, the guest's static IP, and the SMB share are covered in **`usage-hyper-v.md`** (Windows guest sections). Follow it first; it mounts the environment's `vm-shared-windows` folder at `\\<host-ip>\vm-shared-windows`. Return here for the guest-side scripts.

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**. The exact script count may vary when custom steps are present.

> cd "\\<host-ip>\vm-shared-windows\"

> Set-ExecutionPolicy RemoteSigned

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <ip>`.
2. Isolate the VM — remove the temporary Default Switch adapter (see `usage-hyper-v.md`), then reboot.
3. `cd ..\post-scripts` and run every script in order: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.

## Verify

Inside the VM, run `.\verify-config.ps1 [host-ip]`. It prints one PASS/FAIL/WARN line per check and exits non-zero if anything failed. Omit `host-ip` to have it discover and report the value from the installed responder config.

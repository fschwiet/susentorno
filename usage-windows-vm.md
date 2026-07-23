# Windows guest VM setup

Provision a Windows guest that runs the claude/codex agents against Windows-specific work, isolated behind the host proxy. Complete host "Proxy setup" (README.md) first, so `.configamatron/vm-shared-windows/` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

## Create the VM and share the folder

VM creation, the Internal switch, DHCP networking, and the SMB share are covered in **`usage-hyper-v.md`** (Windows guest sections). Follow it first; run the numbered scripts during the NAT phase, while direct internet is available.

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**. The exact script count may vary when custom steps are present.

> cd "\\<host-ip>\vm-shared-windows\"

> Set-ExecutionPolicy RemoteSigned

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <ip>`.
2. Isolate the VM — reassign its single adapter to `configamatron-internal` (see `usage-hyper-v.md`), with `run-proxy` already running.
3. `cd ..\post-scripts` and run every script in order: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.

## Verify

Inside the VM, run `.\verify-config.ps1 <host-ip>`. It checks that DHCP supplied the host as resolver and that names resolve to the host.

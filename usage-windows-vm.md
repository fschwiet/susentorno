# Windows guest VM setup

Provision a Windows guest that runs the claude/codex agents against Windows-specific work, isolated behind the host proxy. Complete host "Proxy setup" (README.md) first, so `.configamatron/vm-shared-windows/` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

## Create the VM and share the folder

VM creation, the Internal switch, DHCP networking, and the SMB share are covered in **`usage-hyper-v.md`** (Windows guest sections). Follow it first; run the numbered scripts during the NAT phase, while direct internet is available.

Two host addresses appear during this flow:

- `<default-switch-host-ip>` is the temporary address used to reach the SMB share while the VM is attached to the Default Switch.
- `<internal-switch-host-ip>` is the stable address assigned to `vEthernet (configamatron-internal)`. Pass this address to the network configuration script and use it after isolation.

`cmdkey` credentials are stored per-address. If you mount the share in both phases, save the `configamatron-share` credential for both host addresses as described in `usage-hyper-v.md`.

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**. The exact script count may vary when custom steps are present.

> cd "\\<default-switch-host-ip>\vm-shared-windows\"

> Set-ExecutionPolicy Bypass

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <internal-switch-host-ip>`.
2. Isolate the VM — reassign its single adapter to `configamatron-internal` (see `usage-hyper-v.md`), with `run-proxy` already running.
3. Use the `cmdkey` entry for `<internal-switch-host-ip>`, then run every post-script in order from `\\<internal-switch-host-ip>\vm-shared-windows\post-scripts`: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.
4. Restore the normal execution policy with `Set-ExecutionPolicy RemoteSigned`.

## Verify

Inside the VM, run `.\verify-config.ps1` to discover the host when exactly one IPv4 DNS server is configured, or run `.\verify-config.ps1 -HostIp <internal-switch-host-ip>` to check an explicit address. It checks that the configured resolver is the host and that names resolve to the host.

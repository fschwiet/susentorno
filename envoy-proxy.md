# Envoy Sandbox Proxy — Setup

See `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md` for the full design.

## Prerequisites

- Docker and Docker Compose on the host machine.
- Node.js >=18 and pnpm on the host machine (to run `configamatron` and the automated tests).
- An Ubuntu VM (VMware) with routable network access to the host machine's IP.
- OpenSSL on the host machine (used by `scripts/generate-ca.sh`).

## Host-side setup

1. `pnpm install .`
2. `pnpm exec configamatron import-sbx-network-policy balanced.policy.txt` — produces `allowlist.txt`. (copy to current-allow-list.txt to update version tracked in source control)
3. `bash scripts/generate-ca.sh` — produces `envoy/ca/cert.pem` and `envoy/ca/key.pem`. Duplicates cert.pem in the vm folder.
4. `pnpm exec configamatron build-envoy-config  ./current-allow-list.txt` — produces `envoy/envoy.yaml` from `allowlist.txt`.
5. Add the `SessionStart` hook to `~/.claude/settings.json`, then run `claude` once on the host so the hook populates `envoy/secrets/sds-secret.yaml`.

```
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/repo/scripts/host-session-hook.sh"
          }
        ]
      }
    ]
  }
```

6. `docker compose up -d`
7. **Windows hosts only:** in an **Administrator** PowerShell, `powershell -File scripts/host-allow-vm-inbound.ps1` — Windows Firewall blocks inbound connections by default, which silently breaks the VM's DNAT'd traffic to Envoy even though everything else is configured correctly. This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter, and prints the host IP to use in VM-side setup. It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
   - (Mac/Linux hosts: not yet scripted — allow inbound tcp/80 and tcp/443 from the VM through your host firewall equivalent (`pfctl`/`ufw`) and determine the host-only interface's IP yourself.)

## VM-side setup

1. Copy vm folder into the VM.
2. Copy `vm/credentials.json.template` into the VM, to wherever the Claude Code CLI expects `credentials.json`.
3. `sudo bash vm/vm-trust-ca.sh <path-to-cert.pem>` (inside the VM).
4. `sudo bash vm/vm-setup-persistence.sh <host-ip>` (inside the VM) — `<host-ip>` is printed by host-side step 7. Installs and starts `dns-stub.service` (answers the VM's own DNS queries locally — see `docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md`) and `iptables-rules@<host-ip>.service` (the DNAT rules previously applied by a standalone `vm-setup-iptables.sh` run), and points the VM's resolver at the local stub via a netplan override. Both units are enabled to start automatically on every future VM boot — no manual re-run needed after this.

## Verification

- Automated: `pnpm test` (runs the full pipeline, including `test:integration`, which brings up and tears down a transient copy of the Envoy stack against a mock upstream — no VM or real credential required).
- Manual (requires the VM — see the design spec's Testing / Verification Plan for the full list):
  - `curl` an allow-listed domain from inside the VM succeeds; a non-allow-listed domain fails/resets.
  - Running the coding agent inside the VM against `api.anthropic.com`, using only the placeholder credential, gets real responses.
  - `apt-get update` succeeds from inside the VM (validates port 80 handling).

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
7. **Windows hosts only:** in an **Administrator** PowerShell, `powershell -File scripts/host-allow-vm-inbound.ps1` — Windows Firewall blocks inbound connections by default, which silently breaks the VM's DNAT'd traffic to Envoy even though everything else is configured correctly. This opens inbound TCP 80/443 (Envoy) and UDP 53 (the DNS stub, step 8) from the VM's host-only network adapter, and prints the host IP to use in VM-side step 4 and host-side step 8. It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
   - (Mac/Linux hosts: not yet scripted — allow inbound tcp/80, tcp/443, and udp/53 from the VM through your host firewall equivalent (`pfctl`/`ufw`) and determine the host-only interface's IP yourself.)
8. `node scripts/host-dns-stub.js <host-ip>` (leave running in its own terminal) — when the VM is on a host-only network it has no route to the internet at all, but its DHCP-assigned DNS server is still the host's own IP (see `vmnetdhcp.conf`), and nothing normally answers there. This isn't a real resolver: since the VM's iptables rules (VM-side step 4) redirect tcp/80 and tcp/443 to Envoy regardless of destination IP, and Envoy resolves the real hostname itself, the actual IP returned to the VM never matters for the connections that count — the stub just answers every A-record query with a fixed placeholder IP so the VM's own DNS lookups stop timing out and its tools proceed to attempt the (redirected) connection at all. `<host-ip>` is the same address as step 7.

## VM-side setup

1. Copy vm folder into the VM.
2. Copy `vm/credentials.json.template` into the VM, to wherever the Claude Code CLI expects `credentials.json`.
3. `sudo bash vm/vm-trust-ca.sh <path-to-cert.pem>` (inside the VM).
4. `sudo bash vm/vm-setup-iptables.sh <host-ip>` (inside the VM) — `<host-ip>` is printed by host-side step 7.

## Verification

- Automated: `pnpm test` (runs the full pipeline, including `test:integration`, which brings up and tears down a transient copy of the Envoy stack against a mock upstream — no VM or real credential required).
- Manual (requires the VM — see the design spec's Testing / Verification Plan for the full list):
  - `curl` an allow-listed domain from inside the VM succeeds; a non-allow-listed domain fails/resets.
  - Running the coding agent inside the VM against `api.anthropic.com`, using only the placeholder credential, gets real responses.
  - `apt-get update` succeeds from inside the VM (validates port 80 handling).

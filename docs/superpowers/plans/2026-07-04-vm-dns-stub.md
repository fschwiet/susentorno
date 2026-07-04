# VM-Resident DNS Stub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move DNS answering for the sandbox VM off the host (a manually-run `node scripts/host-dns-stub.js`) and into the VM itself, running as a systemd service that starts automatically on boot — and while touching boot-time persistence, also fix the VM's iptables DNAT rules so they no longer need to be re-run by hand after every reboot.

**Architecture:** A Node script (`vm/dns-stub.js`) binds `127.0.0.1:53` inside the VM and answers every A-record query with a fixed placeholder IP, same logic as today's host-side stub. A netplan drop-in points the VM's resolver (systemd-resolved) at `127.0.0.1` instead of the host's IP. Two systemd units — a simple service for the DNS stub and a templated oneshot for the existing `vm-setup-iptables.sh` — are installed and enabled via `systemctl enable --now` by a new orchestration script, `vm/vm-setup-persistence.sh`, so the same invocation both applies the change immediately and persists it across reboots.

**Tech Stack:** Bash, systemd (unit files, netplan/systemd-networkd), Node.js (`node:dgram`), PowerShell (host-side firewall script).

**Design doc:** `docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md`

## Global Constraints

- The `vm/` folder is copied from a Windows host and does not preserve the POSIX executable bit — every new systemd `ExecStart` must name the interpreter explicitly (`/usr/bin/node ...` / `/usr/bin/bash ...`), never execute a script file directly.
- `systemctl enable --now` is the *only* activation path for both new units — no separate one-off invocation of `vm-setup-iptables.sh` or `dns-stub.js` outside of systemd, so "apply now" and "apply on reboot" can never drift apart.
- `vm/vm-setup-iptables.sh` is reused unmodified — do not edit it.
- The DNS override is applied via a netplan drop-in (declarative, survives reboots, doesn't fight systemd-resolved's management of `/etc/resolv.conf`) — never edit `/etc/resolv.conf` directly.
- `scripts/host-allow-vm-inbound.ps1` keeps its `Remove-NetFirewallRule` line for the old DNS rule name (so re-running it cleans up stale state) but drops the corresponding `New-NetFirewallRule` call.
- None of this can be exercised end-to-end outside the real Ubuntu VM. Each task below verifies what it can locally (syntax checks); a final manual checklist (matching the design doc's Testing / Verification Plan) covers the rest.

---

### Task 1: `vm/dns-stub.js`

**Files:**
- Create: `vm/dns-stub.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: an executable-by-node script at `vm/dns-stub.js` that, when run as `node dns-stub.js [placeholder-ip]`, binds UDP `127.0.0.1:53` and answers A-record queries with `placeholder-ip` (default `203.0.113.1`). Task 2's `dns-stub.service` invokes this via `node @@VM_DIR@@/dns-stub.js`.

- [ ] **Step 1: Create `vm/dns-stub.js`**

```javascript
#!/usr/bin/env node
// Static DNS responder for the sandbox VM's own resolver.
//
// The VM's systemd-resolved forwards upstream queries to 127.0.0.1 (see the
// netplan override installed by vm-setup-persistence.sh), where this stub
// answers. This isn't a real resolver: the actual destination IP for
// tcp/80 and tcp/443 is discarded by the VM's iptables DNAT rules (which
// redirect by port only, to Envoy) and Envoy re-resolves the real hostname
// itself before connecting upstream. So every A-record query just gets
// back the same fixed placeholder address - its only job is to let the
// querying process's DNS lookup succeed so it proceeds to attempt the
// (redirected) connection at all.
//
// Usage: node dns-stub.js [placeholder-ip]

import dgram from "node:dgram";

const bindIp = "127.0.0.1";
const placeholderIp = process.argv[2] || "203.0.113.1";

const placeholderBytes = placeholderIp.split(".").map((n) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 255) {
    throw new Error(`invalid placeholder IP: ${placeholderIp}`);
  }
  return v;
});

function parseQuestion(msg) {
  let offset = 12;
  const labels = [];
  while (true) {
    const len = msg[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    labels.push(msg.toString("ascii", offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  const qtype = msg.readUInt16BE(offset);
  const qclass = msg.readUInt16BE(offset + 2);
  const questionEnd = offset + 4;
  return {
    name: labels.join("."),
    qtype,
    qclass,
    questionBytes: msg.subarray(12, questionEnd),
  };
}

function buildResponse(msg, question) {
  const isA = question.qtype === 1 && question.qclass === 1;
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // echo the query ID
  header.writeUInt16BE(0x8180, 2); // standard response, no error
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(isA ? 1 : 0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  if (!isA) {
    return Buffer.concat([header, question.questionBytes]);
  }

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // pointer to question name at offset 12
  answer.writeUInt16BE(1, 2); // TYPE A
  answer.writeUInt16BE(1, 4); // CLASS IN
  answer.writeUInt32BE(300, 6); // TTL
  answer.writeUInt16BE(4, 10); // RDLENGTH
  Buffer.from(placeholderBytes).copy(answer, 12);

  return Buffer.concat([header, question.questionBytes, answer]);
}

const socket = dgram.createSocket("udp4");

socket.on("message", (msg, rinfo) => {
  let question;
  try {
    question = parseQuestion(msg);
  } catch (err) {
    console.error(`dns-stub: failed to parse query from ${rinfo.address}:${rinfo.port}: ${err.message}`);
    return;
  }
  console.log(`dns-stub: ${rinfo.address} asked for ${question.name} (type ${question.qtype}) -> ${question.qtype === 1 ? placeholderIp : "empty"}`);
  socket.send(buildResponse(msg, question), rinfo.port, rinfo.address);
});

socket.on("error", (err) => {
  console.error(`dns-stub: socket error: ${err.message}`);
  process.exit(1);
});

socket.bind(53, bindIp, () => {
  console.log(`dns-stub: listening on ${bindIp}:53, answering A queries with ${placeholderIp}`);
});
```

- [ ] **Step 2: Syntax-check it**

Run: `node --check vm/dns-stub.js`
Expected: no output, exit code 0.

Binding to port 53 requires root and only makes sense on the actual VM (once the netplan override in Task 4 is live), so functional verification is deferred to the manual checklist at the end of this plan.

- [ ] **Step 3: Commit**

```bash
git add vm/dns-stub.js
git commit -m "Add in-VM DNS stub, adapted from the host-side script"
```

---

### Task 2: `vm/dns-stub.service`

**Files:**
- Create: `vm/dns-stub.service`

**Interfaces:**
- Consumes: `vm/dns-stub.js` (Task 1), invoked at the literal token `@@VM_DIR@@` which Task 5's `vm-setup-persistence.sh` substitutes with the absolute path to the `vm/` folder at install time.
- Produces: a systemd unit template installed by Task 5 as `/etc/systemd/system/dns-stub.service`.

- [ ] **Step 1: Create `vm/dns-stub.service`**

```ini
[Unit]
Description=Sandbox VM DNS stub (answers all A queries with a placeholder)
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/node @@VM_DIR@@/dns-stub.js
Restart=on-failure
RestartSec=1

[Install]
WantedBy=multi-user.target
```

`After=local-fs.target` (rather than any network target) is deliberate: the stub only binds loopback, so it doesn't need to wait on network interface configuration, and starting it early minimizes the window where systemd-resolved might try forwarding to `127.0.0.1` before the stub is listening.

- [ ] **Step 2: Verify it's well-formed**

There's no `systemd-analyze` on this dev machine (Windows, no systemd), so this can only be structurally reviewed here — confirm the file has exactly one `[Unit]`, `[Service]`, and `[Install]` section and no tabs (systemd unit files require plain spaces or no indentation). Full validation (`systemd-analyze verify /etc/systemd/system/dns-stub.service`) happens on the VM as part of the manual checklist.

- [ ] **Step 3: Commit**

```bash
git add vm/dns-stub.service
git commit -m "Add systemd unit for the in-VM DNS stub"
```

---

### Task 3: `vm/iptables-rules@.service`

**Files:**
- Create: `vm/iptables-rules@.service`

**Interfaces:**
- Consumes: `vm/vm-setup-iptables.sh` (existing, unmodified), invoked with the systemd instance specifier `%i` as its `<host-ip>` argument. `@@VM_DIR@@` substituted the same way as Task 2.
- Produces: a systemd template unit installed by Task 5 as `/etc/systemd/system/iptables-rules@.service`, enabled as `iptables-rules@<host-ip>.service`.

- [ ] **Step 1: Create `vm/iptables-rules@.service`**

```ini
[Unit]
Description=Sandbox VM iptables DNAT rules (host IP: %i)
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/bash @@VM_DIR@@/vm-setup-iptables.sh %i

[Install]
WantedBy=multi-user.target
```

`vm-setup-iptables.sh` appends rules (`iptables -A`) without checking for existing ones, so this unit must only ever be started once per boot (via `enable --now` at install time, then automatically at every subsequent boot) — never manually `restart`ed while already running, or the DNAT rules would be duplicated. This is pre-existing behavior of the script, unchanged here.

- [ ] **Step 2: Verify it's well-formed**

Same structural review as Task 2, Step 2 — full validation deferred to the VM.

- [ ] **Step 3: Commit**

```bash
git add "vm/iptables-rules@.service"
git commit -m "Add systemd template unit to persist the VM's iptables DNAT rules"
```

---

### Task 4: `vm/60-dns-override.yaml`

**Files:**
- Create: `vm/60-dns-override.yaml`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a netplan config fragment installed by Task 5 to `/etc/netplan/60-dns-override.yaml`.

- [ ] **Step 1: Create `vm/60-dns-override.yaml`**

```yaml
network:
  version: 2
  ethernets:
    dns-override:
      match:
        name: "en*"
      nameservers:
        addresses: [127.0.0.1]
```

The VM has a single network adapter (per `vm-setup.md`), so matching by the common Ubuntu predictable-name prefix (`en*`) avoids needing to discover the exact interface name at install time. This only sets `nameservers` — it doesn't touch addressing, so it merges with whatever netplan config already manages DHCP/addressing for that interface.

- [ ] **Step 2: Validate YAML syntax**

Run: `node -e "require('node:fs').readFileSync('vm/60-dns-override.yaml','utf8')"` is not a YAML validator — instead, since no YAML tool is installed on this dev machine, visually confirm 2-space indentation and no tabs. Full validation (`netplan generate` / `netplan apply` and confirming no conflicting device definition in other `/etc/netplan/*.yaml` files on the actual VM) happens in the manual checklist.

- [ ] **Step 3: Commit**

```bash
git add vm/60-dns-override.yaml
git commit -m "Add netplan override pointing the VM's resolver at the local DNS stub"
```

---

### Task 5: `vm/vm-setup-persistence.sh`

**Files:**
- Create: `vm/vm-setup-persistence.sh`

**Interfaces:**
- Consumes: `vm/dns-stub.service` and `vm/iptables-rules@.service` (Tasks 2–3, via the `@@VM_DIR@@` token), `vm/60-dns-override.yaml` (Task 4). Takes one positional argument, `<host-ip>`.
- Produces: the fully-configured, boot-persistent VM side of this feature. Invoked as `sudo bash vm/vm-setup-persistence.sh <host-ip>` per Task 7's doc update.

- [ ] **Step 1: Create `vm/vm-setup-persistence.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: vm-setup-persistence.sh <host-ip>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sed "s|@@VM_DIR@@|${script_dir}|g" "${script_dir}/dns-stub.service" > /etc/systemd/system/dns-stub.service
sed "s|@@VM_DIR@@|${script_dir}|g" "${script_dir}/iptables-rules@.service" > "/etc/systemd/system/iptables-rules@.service"

cp "${script_dir}/60-dns-override.yaml" /etc/netplan/60-dns-override.yaml
netplan apply

systemctl daemon-reload
systemctl enable --now dns-stub.service
systemctl enable --now "iptables-rules@${host_ip}.service"

echo "vm-setup-persistence: dns-stub.service and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
```

This assumes it is invoked with `sudo` already (matching `vm-trust-ca.sh` and `vm-setup-iptables.sh`'s existing convention), so it doesn't prefix its own commands with `sudo`.

- [ ] **Step 2: Syntax-check it**

Run: `bash -n vm/vm-setup-persistence.sh`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add vm/vm-setup-persistence.sh
git commit -m "Add VM-side script to install and enable the DNS stub and iptables persistence units"
```

---

### Task 6: Remove the host-side DNS stub and its firewall rule

**Files:**
- Delete: `scripts/host-dns-stub.js`
- Modify: `scripts/host-allow-vm-inbound.ps1`

**Interfaces:**
- Consumes: nothing.
- Produces: `scripts/host-allow-vm-inbound.ps1` continuing to manage only the TCP 80/443 firewall rule, plus one-time cleanup of the old DNS rule by name.

- [ ] **Step 1: Delete the host-side stub**

```bash
git rm scripts/host-dns-stub.js
```

- [ ] **Step 2: Update `scripts/host-allow-vm-inbound.ps1`**

Replace the full file content with:

```powershell
#requires -Modules NetSecurity, NetTCPIP
<#
Opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter,
and prints the host IP to pass to vm/vm-setup-persistence.sh.

Also removes the stale UDP/53 DNS-stub firewall rule created by versions of
this script before DNS answering moved into the VM (see
docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md) - safe to re-run
even if that rule was never created on this machine.

Scoped by -InterfaceAlias rather than a hardcoded subnet CIDR, since
VMware assigns the host-only network's subnet per-machine (e.g.
192.168.241.0/24 on one machine, something else on another) - this rule
keeps working whatever that subnet turns out to be.

Safe to re-run: replaces any existing rules with the same names.
#>
[CmdletBinding()]
param(
    [string]$AdapterAlias = "VMware Network Adapter VMnet1"
)

$ErrorActionPreference = "Stop"

$config = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias
$hostIp = ($config.IPv4Address | Select-Object -First 1).IPAddress

if (-not $hostIp) {
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM's network mode is Host-only and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
}

$tcpRuleName = "Envoy Sandbox Proxy (VM inbound)"
$staleDnsRuleName = "Envoy Sandbox Proxy DNS stub (VM inbound)"

Get-NetFirewallRule -DisplayName $tcpRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $staleDnsRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

Write-Host "Firewall rules created, scoped to interface '$AdapterAlias'."
Write-Host "Host IP for this network: $hostIp"
Write-Host "Use this as <host-ip> in:"
Write-Host "  bash vm/vm-setup-persistence.sh $hostIp"
```

- [ ] **Step 3: Verify PowerShell syntax**

Run: `pwsh -NoProfile -Command "[System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw scripts/host-allow-vm-inbound.ps1), [ref]$null) | Out-Null; Write-Output 'OK'"`
Expected: `OK` with no errors. This only checks the script parses; it doesn't run it (running it requires an actual VMware host-only adapter and admin rights).

- [ ] **Step 4: Commit**

```bash
git add scripts/host-allow-vm-inbound.ps1
git commit -m "Drop the host-side DNS stub and its firewall rule, keep stale-rule cleanup"
```

---

### Task 7: Update `envoy-proxy.md`

**Files:**
- Modify: `envoy-proxy.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: setup instructions that match Tasks 1–6.

- [ ] **Step 1: Update host-side step 7 and remove step 8**

In the `## Host-side setup` section, replace:

```markdown
7. **Windows hosts only:** in an **Administrator** PowerShell, `powershell -File scripts/host-allow-vm-inbound.ps1` — Windows Firewall blocks inbound connections by default, which silently breaks the VM's DNAT'd traffic to Envoy even though everything else is configured correctly. This opens inbound TCP 80/443 (Envoy) and UDP 53 (the DNS stub, step 8) from the VM's host-only network adapter, and prints the host IP to use in VM-side step 4 and host-side step 8. It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
   - (Mac/Linux hosts: not yet scripted — allow inbound tcp/80, tcp/443, and udp/53 from the VM through your host firewall equivalent (`pfctl`/`ufw`) and determine the host-only interface's IP yourself.)
8. `node scripts/host-dns-stub.js <host-ip>` (leave running in its own terminal) — when the VM is on a host-only network it has no route to the internet at all, but its DHCP-assigned DNS server is still the host's own IP (see `vmnetdhcp.conf`), and nothing normally answers there. This isn't a real resolver: since the VM's iptables rules (VM-side step 4) redirect tcp/80 and tcp/443 to Envoy regardless of destination IP, and Envoy resolves the real hostname itself, the actual IP returned to the VM never matters for the connections that count — the stub just answers every A-record query with a fixed placeholder IP so the VM's own DNS lookups stop timing out and its tools proceed to attempt the (redirected) connection at all. `<host-ip>` is the same address as step 7.
```

with:

```markdown
7. **Windows hosts only:** in an **Administrator** PowerShell, `powershell -File scripts/host-allow-vm-inbound.ps1` — Windows Firewall blocks inbound connections by default, which silently breaks the VM's DNAT'd traffic to Envoy even though everything else is configured correctly. This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter, and prints the host IP to use in VM-side setup. It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
   - (Mac/Linux hosts: not yet scripted — allow inbound tcp/80 and tcp/443 from the VM through your host firewall equivalent (`pfctl`/`ufw`) and determine the host-only interface's IP yourself.)
```

- [ ] **Step 2: Update VM-side setup step 4**

In the `## VM-side setup` section, replace:

```markdown
4. `sudo bash vm/vm-setup-iptables.sh <host-ip>` (inside the VM) — `<host-ip>` is printed by host-side step 7.
```

with:

```markdown
4. `sudo bash vm/vm-setup-persistence.sh <host-ip>` (inside the VM) — `<host-ip>` is printed by host-side step 7. Installs and starts `dns-stub.service` (answers the VM's own DNS queries locally — see `docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md`) and `iptables-rules@<host-ip>.service` (the DNAT rules previously applied by a standalone `vm-setup-iptables.sh` run), and points the VM's resolver at the local stub via a netplan override. Both units are enabled to start automatically on every future VM boot — no manual re-run needed after this.
```

- [ ] **Step 3: Commit**

```bash
git add envoy-proxy.md
git commit -m "Update envoy-proxy.md for the in-VM DNS stub and boot persistence"
```

---

### Task 8: Manual VM verification

**Files:** none (verification only).

**Interfaces:** none.

This task can only be carried out on the real Ubuntu VM described in `vm-setup.md` / `envoy-proxy.md`, using a copy of the `vm/` folder that includes Tasks 1–5's new files. Not automatable from this repo's dev environment.

- [ ] **Step 1: Copy the updated `vm/` folder to the VM and run setup**

Follow `envoy-proxy.md`'s VM-side setup steps 1–4 (using the updated step 4, `sudo bash vm/vm-setup-persistence.sh <host-ip>`).

- [ ] **Step 2: Confirm both units are active**

Run inside the VM: `systemctl status dns-stub.service iptables-rules@<host-ip>.service`
Expected: both show `active (running)` / `active (exited)` respectively, with no host-side script or UDP/53 firewall rule present.

- [ ] **Step 3: Confirm the resolver override took effect**

Run inside the VM: `resolvectl status`
Expected: the relevant interface's "DNS Servers" line shows `127.0.0.1`.

- [ ] **Step 4: Confirm DNS answers and connectivity work**

Run inside the VM:
- `getent hosts example.com` (or `dig` if installed) — expect the placeholder IP (`203.0.113.1` by default).
- `curl` an allow-listed domain — expect success.
- `apt-get update` — expect success.

- [ ] **Step 5: Confirm boot persistence**

Reboot the VM. Without re-running any script by hand, repeat Steps 2–4 and confirm they still pass.

- [ ] **Step 6: Confirm stale host firewall rule cleanup**

On the host (Windows), re-run `scripts/host-allow-vm-inbound.ps1` (as Administrator) and confirm any pre-existing `Envoy Sandbox Proxy DNS stub (VM inbound)` rule is removed and not recreated (e.g. via `Get-NetFirewallRule -DisplayName "Envoy Sandbox Proxy DNS stub (VM inbound)"` returning nothing afterward).

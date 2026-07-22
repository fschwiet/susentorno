# Remove VMware Support (Hyper-V only) Implementation Plan

**Goal:** Purge VMware from the living documentation and the implementation so Hyper-V is the single, first-class path, changing no guest-networking or test-harness behavior.

**Architecture:** A cleanup pass across three code/template files, four template/test files, and five docs. The only runtime-affecting change is swapping three adapter defaults from the VMware NIC to the Hyper-V Internal-switch adapter (`vEthernet (configamatron-internal)`); everything else is comment/help-text/label rewording, a doc rewrite, one file rename, and one file deletion. A final grep + full test pipeline proves no VMware/`host-only` terms survive outside history docs and that behavior is unchanged.

**Tech Stack:** TypeScript (Node ≥18, tsup, Vitest), PowerShell templates, Bash templates, Markdown docs, pnpm.

## Global Constraints

- **Hyper-V only.** No VMware concepts in living docs, `src/`, `templates/`, or `tests/`.
- **New default adapter alias (verbatim):** `vEthernet (configamatron-internal)`.
- **Renamed constant (verbatim):** `DEFAULT_VMNET_ADAPTER` → `DEFAULT_INTERNAL_SWITCH_ADAPTER`.
- **Terminology map:** VMware "host-only" network → Hyper-V "Internal switch" (the NIC is the "Internal-switch adapter"; the isolated mode is "gateway-less"). VMware "VMnet host IP" → "the Hyper-V Default Switch's DHCP".
- **Behavior unchanged:** guest networking, the forwarder/verify/firewall runtime logic, and the VM test harness must behave exactly as before. Only which adapter the defaults *name* changes.
- **Out of scope (do NOT edit):** `docs/superpowers/**`, `docs/honist-v/**` (except this plan/its spec), `legacy/**`. These are point-in-time history. `docs/investigations/**` is edited only for a broken filename reference, never terminology.
- **Verification grep terms:** `vmware`, `vmnet`, `hgfs`, `vmrun`, `vmx`, `open-vm-tools`, `vmware-host`, `host-only` (case-insensitive). Note `hostonly` (no hyphen) is an internal harness mode token and is intentionally left alone — it does not match `host-only`.
- **Full gate:** `pnpm test` (includes `test:integration`, needs Docker) plus `pnpm test:vm` (WSL2/QEMU) must pass.
- **Commits:** follow repo convention — commit directly to `main` (recent history shows feature commits land on `main`).

---

### Task 1: Forwarder adapter default + run-proxy CLI wording

Swap the forwarder's default adapter to the Hyper-V Internal switch, rename its exported constant, and reword the CLI help/comments/error. This is the only runtime-affecting change and it has a unit test.

**Files:**

- Modify: `src/runProxy/forwarder.ts`
- Test: `tests/unit/runProxy/forwarder.test.ts`
- Modify: `src/commands/runProxy.ts:79-133`

**Interfaces:**

- Produces: `export const DEFAULT_INTERNAL_SWITCH_ADAPTER = 'vEthernet (configamatron-internal)'` and unchanged `resolveForwardListenAddress(adapterName?: string, interfaces?): string | null` in `src/runProxy/forwarder.ts`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Rewrite the failing test**

Replace the entire contents of `tests/unit/runProxy/forwarder.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
  resolveForwardListenAddress,
} from '../../../src/runProxy/forwarder';

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('resolveForwardListenAddress', () => {
  it('returns the non-internal IPv4 of the named adapter', () => {
    const interfaces = {
      'vEthernet (configamatron-internal)': [ipv4('192.168.67.1')],
      'Wi-Fi': [ipv4('10.0.0.5')],
    };
    expect(resolveForwardListenAddress(DEFAULT_INTERNAL_SWITCH_ADAPTER, interfaces)).toBe(
      '192.168.67.1',
    );
  });

  it('returns null when the adapter is absent', () => {
    expect(
      resolveForwardListenAddress(DEFAULT_INTERNAL_SWITCH_ADAPTER, { 'Wi-Fi': [ipv4('10.0.0.5')] }),
    ).toBeNull();
  });

  it('skips internal and IPv6 addresses', () => {
    const interfaces = {
      'vEthernet (configamatron-internal)': [
        { ...ipv4('127.0.0.1', true) },
        {
          address: 'fe80::1',
          netmask: 'ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 0,
        } as NetworkInterfaceInfo,
        ipv4('192.168.67.1'),
      ],
    };
    expect(resolveForwardListenAddress(DEFAULT_INTERNAL_SWITCH_ADAPTER, interfaces)).toBe(
      '192.168.67.1',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/forwarder.test.ts`
Expected: FAIL — `DEFAULT_INTERNAL_SWITCH_ADAPTER` is not exported (still named `DEFAULT_VMNET_ADAPTER`).

- [ ] **Step 3: Update the forwarder source**

In `src/runProxy/forwarder.ts`, replace lines 3–7:

```typescript
export const DEFAULT_VMNET_ADAPTER = 'VMware Network Adapter VMnet1';

/**
 * IPv4 address of the VMware host-only adapter to forward from, or null if the
 * adapter is not present. `interfaces` is injectable for testing.
 */
```

with:

```typescript
export const DEFAULT_INTERNAL_SWITCH_ADAPTER = 'vEthernet (configamatron-internal)';

/**
 * IPv4 address of the Hyper-V Internal-switch host adapter to forward from, or
 * null if the adapter is not present. `interfaces` is injectable for testing.
 */
```

Then update the default parameter on the next function (currently `adapterName: string = DEFAULT_VMNET_ADAPTER`) to `adapterName: string = DEFAULT_INTERNAL_SWITCH_ADAPTER`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/forwarder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Reword the run-proxy CLI surface**

In `src/commands/runProxy.ts`, make these exact replacements:

Line 79:
```typescript
    .option('--no-forward', 'do not forward the VMware host-only interface to loopback')
```
→
```typescript
    .option('--no-forward', 'do not forward the Hyper-V Internal-switch interface to loopback')
```

Lines 80–83:
```typescript
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the VMware host-only adapter IP)',
    )
```
→
```typescript
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the Hyper-V Internal-switch adapter IP)',
    )
```

Lines 118–133 (comment reword AND rename the local `vmnet` variable — note `vmnet` matches the verification grep, so it must be renamed):
```typescript
      // The gateway always owns the public ports on loopback; when forwarding is
      // enabled it also listens on the VMware host-only adapter. Both point at the
      // active color's backend ports.
      const listenAddresses = ['127.0.0.1'];
      if (options.forward) {
        const vmnet = options.forwardListen ?? resolveForwardListenAddress();
        if (!vmnet) {
          console.error(
            'run-proxy: could not find the VMware host-only adapter IP to forward from. ' +
              'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
          );
          process.exitCode = 1;
          return;
        }
        listenAddresses.push(vmnet);
      }
```
→
```typescript
      // The gateway always owns the public ports on loopback; when forwarding is
      // enabled it also listens on the Hyper-V Internal-switch adapter. Both point
      // at the active color's backend ports.
      const listenAddresses = ['127.0.0.1'];
      if (options.forward) {
        const forwardIp = options.forwardListen ?? resolveForwardListenAddress();
        if (!forwardIp) {
          console.error(
            'run-proxy: could not find the Hyper-V Internal-switch adapter IP to forward from. ' +
              'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
          );
          process.exitCode = 1;
          return;
        }
        listenAddresses.push(forwardIp);
      }
```

- [ ] **Step 6: Verify types, lint, format, unit tests, build**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:unit && pnpm build`
Expected: all PASS. (Confirms the `vmnet`→`forwardIp` rename compiles and nothing else imported the old constant name.)

- [ ] **Step 7: Confirm no residue in the touched code files**

Run: `git grep -niE '(vmware|vmnet|host-only)' -- src/runProxy/forwarder.ts src/commands/runProxy.ts tests/unit/runProxy/forwarder.test.ts`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/runProxy/forwarder.ts src/commands/runProxy.ts tests/unit/runProxy/forwarder.test.ts
git commit -m "refactor: default forwarder to Hyper-V Internal-switch adapter"
```

---

### Task 2: Proxy PowerShell templates

Swap the `-AdapterAlias` defaults and reword all VMware/`host-only` strings in the two host-side PowerShell scripts. These are template files with no unit-test coverage and are not linted by the pipeline, so validation is a targeted grep plus review.

**Files:**

- Modify: `templates/proxy/host-allow-vm-inbound.ps1`
- Modify: `templates/proxy/verify-proxy.ps1`

**Interfaces:** none (standalone scripts).

- [ ] **Step 1: Edit `host-allow-vm-inbound.ps1`**

Replace line 3:
```
Opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter,
```
→
```
Opens inbound TCP 80/443 (Envoy) from the VM's Hyper-V Internal-switch adapter,
```

Replace lines 11–14:
```
Scoped by -InterfaceAlias rather than a hardcoded subnet CIDR, since
VMware assigns the host-only network's subnet per-machine (e.g.
192.168.241.0/24 on one machine, something else on another) - this rule
keeps working whatever that subnet turns out to be.
```
→
```
Scoped by -InterfaceAlias rather than a hardcoded subnet CIDR, since
the Internal switch's subnet is assigned per-machine (e.g.
192.168.67.0/24 on one machine, something else on another) - this rule
keeps working whatever that subnet turns out to be.
```

Replace line 20:
```
    [string]$AdapterAlias = "VMware Network Adapter VMnet1"
```
→
```
    [string]$AdapterAlias = "vEthernet (configamatron-internal)"
```

Replace line 29:
```
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM's network mode is Host-only and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
```
→
```
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM is on the Internal switch and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
```

- [ ] **Step 2: Edit `verify-proxy.ps1`**

Replace lines 16–20:
```
The VM-path checks probe the host-only adapter the forwarder listens on.
-AdapterAlias defaults to the VMware host-only NIC; on a Hyper-V host pass the
Internal-switch adapter instead, matching host-allow-vm-inbound.ps1, e.g.:

    ... -File .configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (configamatron-internal)"
```
→
```
The VM-path checks probe the Internal-switch adapter the forwarder listens on.
-AdapterAlias defaults to the Hyper-V Internal-switch NIC "vEthernet
(configamatron-internal)"; pass a different alias if your switch is named
differently, matching host-allow-vm-inbound.ps1, e.g.:

    ... -File .configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (my-switch)"
```

Replace line 25:
```
    [string]$AdapterAlias = 'VMware Network Adapter VMnet1'
```
→
```
    [string]$AdapterAlias = 'vEthernet (configamatron-internal)'
```

Replace line 146:
```
    Add-Warn 'VM-path checks' "no IPv4 on '$AdapterAlias' -- skipping (is the host-only adapter up?)"
```
→
```
    Add-Warn 'VM-path checks' "no IPv4 on '$AdapterAlias' -- skipping (is the Internal-switch adapter up?)"
```

Replace lines 167–168:
```
if ($rule) { Add-Pass 'host-only inbound firewall rule present' }
else { Add-Warn 'host-only inbound firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin) once the VM is host-only" }
```
→
```
if ($rule) { Add-Pass 'Internal-switch inbound firewall rule present' }
else { Add-Warn 'Internal-switch inbound firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin) once the VM is on the Internal switch" }
```

Replace line 173:
```
else { Add-Warn 'host-only adapter IP' "no IPv4 on '$AdapterAlias' -- is the host-only adapter up?" }
```
→
```
else { Add-Warn 'Internal-switch adapter IP' "no IPv4 on '$AdapterAlias' -- is the Internal-switch adapter up?" }
```

- [ ] **Step 3: Verify no residue**

Run: `git grep -niE '(vmware|vmnet|host-only)' -- templates/proxy/host-allow-vm-inbound.ps1 templates/proxy/verify-proxy.ps1`
Expected: no output.

- [ ] **Step 4: Sanity-check PowerShell parses**

Run: `pwsh -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('templates/proxy/verify-proxy.ps1',[ref]$null,[ref]$null); $null = [System.Management.Automation.Language.Parser]::ParseFile('templates/proxy/host-allow-vm-inbound.ps1',[ref]$null,[ref]$null); 'parse-ok'"`
Expected: prints `parse-ok` (both files parse). If `pwsh` is unavailable, skip and rely on review.

- [ ] **Step 5: Commit**

```bash
git add templates/proxy/host-allow-vm-inbound.ps1 templates/proxy/verify-proxy.ps1
git commit -m "docs: reword proxy PowerShell scripts to Hyper-V Internal switch"
```

---

### Task 3: Ubuntu guest templates + unit-test comment

Reword the VMware/`host-only` comments and user-facing strings in the Ubuntu guest templates and the one unit-test comment that references them. No behavior changes; the `templates.test.ts` assertions are unchanged and still pass.

**Files:**

- Modify: `templates/vm-shared/pre-scripts/60-dns-override.yaml:15-22`
- Modify: `templates/vm-shared/pre-scripts/configamatron-egress.service:2`
- Modify: `templates/vm-shared/verify-config.sh:161,165`
- Modify: `tests/unit/templates.test.ts:76-78`

**Interfaces:** none.

- [ ] **Step 1: Edit `60-dns-override.yaml`**

Replace lines 15–18:
```
      # DHCP-supplied DNS must be suppressed, not just supplemented: VMware's
      # host-only DHCP hands out the VMnet host IP as a DNS server, nothing on
      # the host answers DNS there, and systemd-resolved rotates onto the dead
      # server causing intermittent multi-second lookup stalls (curl exit 28
```
→
```
      # DHCP-supplied DNS must be suppressed, not just supplemented: during
      # setup the Hyper-V Default Switch's DHCP hands out a DNS server that
      # nothing on the host answers, and systemd-resolved rotates onto the dead
      # server causing intermittent multi-second lookup stalls (curl exit 28
```

- [ ] **Step 2: Edit `configamatron-egress.service`**

Replace line 2:
```
Description=Configamatron egress: DNAT 80/443 to host proxy + host-only default route (host IP: __HOST_IP__)
```
→
```
Description=Configamatron egress: DNAT 80/443 to host proxy + gateway-less Internal-switch default route (host IP: __HOST_IP__)
```

- [ ] **Step 3: Edit `verify-config.sh`**

Replace line 161:
```
  bad 'default route present' 'no default route (host-only mode needs the unit-installed route)'
```
→
```
  bad 'default route present' 'no default route (the isolated Internal-switch network needs the unit-installed route)'
```

Replace line 165:
```
  ok "host-only default route via $host_ip"
```
→
```
  ok "Internal-switch default route via $host_ip"
```

- [ ] **Step 4: Edit the unit-test comment in `templates.test.ts`**

Replace lines 76–78:
```
    // networkd honors use-dns; NetworkManager needs the keyfile passthrough.
    // Without both, VMware's host-only DHCP adds the (dead) VMnet host IP as a
    // second resolver and lookups stall intermittently.
```
→
```
    // networkd honors use-dns; NetworkManager needs the keyfile passthrough.
    // Without both, the Hyper-V Default Switch's DHCP adds a dead resolver as a
    // second nameserver and lookups stall intermittently.
```

- [ ] **Step 5: Verify the unit test still passes (assertions unchanged)**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS (the `use-dns: false` / `ipv4.ignore-auto-dns: "true"` assertions are untouched).

- [ ] **Step 6: Sanity-check the shell script parses**

Run: `bash -n templates/vm-shared/verify-config.sh`
Expected: no output, exit 0.

- [ ] **Step 7: Verify no residue**

Run: `git grep -niE '(vmware|vmnet|host-only)' -- templates/vm-shared/pre-scripts/60-dns-override.yaml templates/vm-shared/pre-scripts/configamatron-egress.service templates/vm-shared/verify-config.sh tests/unit/templates.test.ts`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add templates/vm-shared/pre-scripts/60-dns-override.yaml templates/vm-shared/pre-scripts/configamatron-egress.service templates/vm-shared/verify-config.sh tests/unit/templates.test.ts
git commit -m "docs: reword Ubuntu guest templates to Hyper-V terminology"
```

---

### Task 4: VM test harness wording

Reword the VMware/`host-only`/`hgfs` comments and `describe`/`it` names in the VM e2e harness. Test logic and the internal `hostonly` mode token are unchanged. The full `pnpm test:vm` run is deferred to Task 9 (it boots a QEMU guest and takes ~10–20 min); per-task validation is a typecheck + bash parse + grep.

**Files:**

- Modify: `tests/vm/harness/net.sh:36,42`
- Modify: `tests/vm/vm.test.ts:83,118,193,194,204,386`

**Interfaces:** none. Do NOT change the `net.sh` mode argument `hostonly` (passed at `vm.test.ts:195` as `harness('net.sh', 'dhcp', 'hostonly')`) — it is an internal token, has no hyphen, and does not match the `host-only` grep.

- [ ] **Step 1: Edit `net.sh`**

Replace line 36:
```bash
        # Mimic VMware NAT: the lease carries a router and DNS (this host),
```
→
```bash
        # Gateway mode: the lease carries a router and DNS (this host),
```

Replace line 42:
```bash
        # Mimic VMware host-only: DHCP answers but the lease carries no
```
→
```bash
        # Gateway-less mode: DHCP answers but the lease carries no
```

- [ ] **Step 2: Edit `vm.test.ts` comments and test names**

Replace lines 82–83:
```typescript
  // Stage the environment's real vm-shared folder (numbered scripts + the
  // generate-ca cert.pem) as the guest's read-only share, mimicking hgfs.
```
→
```typescript
  // Stage the environment's real vm-shared folder (numbered scripts + the
  // generate-ca cert.pem) as the guest's read-only share, mimicking the SMB mount.
```

Replace lines 117–118:
```typescript
    // In gateway mode the DHCP DNS is still present too, so assert
    // containment; host-only S2 asserts the stub is the effective resolver.
```
→
```typescript
    // In gateway mode the DHCP DNS is still present too, so assert
    // containment; the gateway-less S2 asserts the stub is the effective resolver.
```

Replace line 193:
```typescript
describe('S2: switch to host-only and reboot', () => {
```
→
```typescript
describe('S2: switch to gateway-less and reboot', () => {
```

Replace line 194:
```typescript
  it('reboots into host-only mode with both units active', async () => {
```
→
```typescript
  it('reboots into gateway-less mode with both units active', async () => {
```

Replace line 204:
```typescript
  it('installed the guarded host-only default route', async () => {
```
→
```typescript
  it('installed the guarded gateway-less default route', async () => {
```

Replace lines 385–386:
```typescript
    // DHCP is still in host-only mode (S2), so g2 boots gateway-less: the
    // interface-discovery fallback branch in 05 is the only path that works.
```
→
```typescript
    // DHCP is still in gateway-less mode (S2), so g2 boots gateway-less: the
    // interface-discovery fallback branch in 05 is the only path that works.
```

- [ ] **Step 3: Verify types and shell parse**

Run: `pnpm typecheck && bash -n tests/vm/harness/net.sh`
Expected: both PASS / exit 0.

- [ ] **Step 4: Verify no residue (and confirm the `hostonly` token is intentionally kept)**

Run: `git grep -niE '(vmware|host-only|hgfs)' -- tests/vm/harness/net.sh tests/vm/vm.test.ts`
Expected: no output.
Run: `git grep -n 'hostonly' -- tests/vm/vm.test.ts tests/vm/harness/net.sh`
Expected: still shows the mode argument/branch usage (intentionally kept).

- [ ] **Step 5: Commit**

```bash
git add tests/vm/harness/net.sh tests/vm/vm.test.ts
git commit -m "test: reword VM harness comments to Hyper-V/gateway-less terminology"
```

---

### Task 5: Rename and rewrite the Hyper-V hosting guide

Rename `usage-hyper-v-host.md` → `usage-hyper-v.md` and rewrite it from a "diff against VMware" into a self-contained primary guide. Fix the one filename reference this rename breaks in the investigation doc.

**Files:**

- Rename: `usage-hyper-v-host.md` → `usage-hyper-v.md`
- Modify (post-rename): `usage-hyper-v.md` (intro, the "Why this is different from VMware" section, `/mnt/hgfs` phrasings, the run-scripts table, the isolate step, the verify step)
- Modify: `docs/investigations/2026-07-22-host-side-dns-consolidation.md` (one filename reference)

**Interfaces:** other docs (Tasks 6, 7) link to `usage-hyper-v.md` by this new name.

- [ ] **Step 1: Rename the file (preserves history)**

Run: `git mv usage-hyper-v-host.md usage-hyper-v.md`

- [ ] **Step 2: Rewrite the intro**

In `usage-hyper-v.md`, replace lines 1–10:
```
# Hosting with Hyper-V

Run a Windows or Ubuntu guest under **Hyper-V Manager** instead of VMware, isolated behind the host proxy. This doc covers only what Hyper-V does differently — creating the VM, virtual switches, static IPs, sharing the environment folder, and isolating the network. Once the shared folder is mounted, the guest follows the existing numbered-script flow unchanged:

- **Ubuntu guest:** the numbered scripts and verification in `README.md` ("VM setup" onward).
- **Windows guest:** the numbered scripts in `usage-windows-vm.md`.

The host side needs no code changes. `configamatron run-proxy` and `host-allow-vm-inbound.ps1` both take parameters that point them at the Hyper-V adapter instead of the VMware one; those substitutions are called out below.

Complete the host "Proxy setup" (`README.md`) first, so the environment's `vm-shared/` and `vm-shared-windows/` folders contain `cert.pem`, `github-config.txt`, and `credentials.json`.
```
→
```
# Hosting with Hyper-V

Run a Windows or Ubuntu guest under **Hyper-V Manager**, isolated behind the host proxy. This doc covers the full host + VM setup — creating the VM, the virtual switch, static IPs, sharing the environment folder, and isolating the network. Once the shared folder is mounted, the guest follows the numbered-script flow:

- **Ubuntu guest:** the numbered scripts and verification in `README.md` ("VM setup" onward).
- **Windows guest:** the numbered scripts in `usage-windows-vm.md`.

The host side needs no code changes: both `configamatron run-proxy` and `host-allow-vm-inbound.ps1` default to the `vEthernet (configamatron-internal)` adapter, so no overrides are needed when you name the switch `configamatron-internal` as below.

Complete the host "Proxy setup" (`README.md`) first, so the environment's `vm-shared/` and `vm-shared-windows/` folders contain `cert.pem`, `github-config.txt`, and `credentials.json`.
```

- [ ] **Step 3: Rewrite the "Why this is different from VMware" section**

Replace lines 12–18:
```
## Why this is different from VMware

Hyper-V has no transparent Shared Folders mechanism (`/mnt/hgfs`, `\\vmware-host\Shared Folders`). The only way to keep a host folder **live** in the guest — which we need, because the guest's `~/.claude/.credentials.json` is symlinked to the shared `credentials.json` and the proxy rotates that file — is a network file share (SMB). A one-time copy-in (ISO, `Copy-VMFile`) would freeze the credential and is not an option. Note that these credential files sync'd to the VM do not contain the actual credentials but rather a placeholder- the proxy injects the real credentials. What is being sync'd is the rest of the information in ~/.claude/.credentials.json.

Hyper-V's analog of VMware's host-only network is an **Internal virtual switch** (host + VMs, no internet). Unlike VMware host-only, an Internal switch runs **no DHCP**, so the host adapter and the guest both get **static IPs**. That host IP is stable, and it is the one value that threads through the entire setup:
```
→
```
## Networking and file sharing

Hyper-V has no transparent shared-folder mechanism, so we keep the host's environment folder **live** in the guest over a network file share (SMB). This matters because the guest's `~/.claude/.credentials.json` is symlinked to the shared `credentials.json` and the proxy rotates that file; a one-time copy-in (ISO, `Copy-VMFile`) would freeze the credential and is not an option. Note that these credential files sync'd to the VM do not contain the actual credentials but rather a placeholder — the proxy injects the real credentials. What is being sync'd is the rest of the information in ~/.claude/.credentials.json.

The isolated network is an **Internal virtual switch** (host + VMs, no internet). An Internal switch runs **no DHCP**, so the host adapter and the guest both get **static IPs**. That host IP is stable, and it is the one value that threads through the entire setup:
```

- [ ] **Step 4: Fix the `/mnt/hgfs` substitute phrasings**

Replace line 155:
```
The share now lives at `/mnt/vm-shared` — this is the Hyper-V substitute for `/mnt/hgfs/vm-shared` used with the VMWare setup.
```
→
```
The share now lives at `/mnt/vm-shared` — the numbered scripts run from there.
```

Replace line 164:
```
The share is then reachable at `\\192.168.67.1\vm-shared-windows` — this is the Hyper-V substitute for `/mnt/hgfs/vm-shared-windows` used with the VMWare setup.
```
→
```
The share is then reachable at `\\192.168.67.1\vm-shared-windows` — the numbered scripts run from there.
```

- [ ] **Step 5: Rewrite the run-scripts table**

Replace lines 178–181:
```
| Guest | Existing doc | Run scripts from |
| --- | --- | --- |
| Ubuntu | `README.md` ("Run the numbered scripts from the VM") | `/mnt/vm-shared` instead of `/mnt/hgfs/vm-shared` |
| Windows | `usage-windows-vm.md` ("Run the numbered scripts") | `\\192.168.67.1\vm-shared-windows` instead of `\\vmware-host\Shared Folders\vm-shared-windows` |
```
→
```
| Guest | Existing doc | Run scripts from |
| --- | --- | --- |
| Ubuntu | `README.md` ("Run the numbered scripts from the VM") | `/mnt/vm-shared` |
| Windows | `usage-windows-vm.md` ("Run the numbered scripts") | `\\192.168.67.1\vm-shared-windows` |
```

- [ ] **Step 6: Simplify the isolate step (defaults now match, no overrides needed)**

Replace lines 186–197 (outer wrapper shown with four backticks because the content contains a ```powershell fence):

````
On the **host**, point the proxy's networking at the Hyper-V adapter (the auto-detection defaults to the VMware adapter):

```powershell
# Firewall for Envoy 80/443, scoped to the Internal adapter; prints the host IP:
powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1 -AdapterAlias "vEthernet (configamatron-internal)"

# Forward that adapter's :80/:443 to Envoy on loopback:
configamatron run-proxy --forward-listen 192.168.67.1
```

Then isolate the VM: in VM → Settings, **remove the temporary Default Switch adapter**, leaving only the Internal-switch adapter. Reboot the VM so the boot-time DNS/DNAT rules take effect. The VM can now reach only the host.
````
→
````
On the **host**, open the firewall and start forwarding. Both default to the `vEthernet (configamatron-internal)` adapter, so no overrides are needed when the switch is named `configamatron-internal`:

```powershell
# Firewall for Envoy 80/443, scoped to the Internal adapter; prints the host IP:
powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1

# Forward that adapter's :80/:443 to Envoy on loopback:
configamatron run-proxy
```

(If your switch has a different name, pass `-AdapterAlias "vEthernet (<SwitchName>)"` to the firewall script and `--forward-listen <host-ip>` to `run-proxy`.)

Then isolate the VM: in VM → Settings, **remove the temporary Default Switch adapter**, leaving only the Internal-switch adapter. Reboot the VM so the boot-time DNS/DNAT rules take effect. The VM can now reach only the host.
````

- [ ] **Step 7: Simplify the verify step**

Replace lines 199–205 (the "## 8. Verify" body up to the bullet list):
```
## 8. Verify

Unchanged from the VMware flow, just from the new mount path — except the host check needs `-AdapterAlias` so its VM-path probes hit the Internal-switch adapter instead of the (still-present, unused) VMware one:

- **Host (proxy):** with the proxy up, run `.configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (configamatron-internal)"`.
- **Ubuntu guest:** `/mnt/vm-shared/verify-config.sh 192.168.67.1`.
- **Windows guest:** `.\verify-config.ps1 192.168.67.1` from the mounted `vm-shared-windows` share.
```
→
```
## 8. Verify

Run the read-only checks (`-AdapterAlias` defaults to the Internal-switch adapter, so no override is needed when the switch is named `configamatron-internal`):

- **Host (proxy):** with the proxy up, run `.configamatron\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** `/mnt/vm-shared/verify-config.sh 192.168.67.1`.
- **Windows guest:** `.\verify-config.ps1 192.168.67.1` from the mounted `vm-shared-windows` share.
```

- [ ] **Step 8: Fix the broken filename reference in the investigation doc**

In `docs/investigations/2026-07-22-host-side-dns-consolidation.md`, replace the token `usage-hyper-v-host.md` with `usage-hyper-v.md` (it appears once, in the "Scope / impact" docs list).

Run to confirm: `git grep -n 'usage-hyper-v-host.md' -- docs/investigations/2026-07-22-host-side-dns-consolidation.md`
Expected after edit: no output.

- [ ] **Step 9: Verify no residue and the old filename is gone**

Run: `git grep -niE '(vmware|vmnet|hgfs|host-only)' -- usage-hyper-v.md`
Expected: no output.
Run: `test ! -e usage-hyper-v-host.md && echo "renamed-ok"`
Expected: prints `renamed-ok`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "docs: rewrite usage-hyper-v-host.md as standalone usage-hyper-v.md"
```

---

### Task 6: Rewrite README.md VM setup and prerequisites

Drop VMware from prerequisites, the `run-proxy`/`host-allow` bullets, and replace the VMware VM-setup section with a pointer to `usage-hyper-v.md` plus a generalized numbered-script flow.

**Files:**

- Modify: `README.md` (lines 9–16, 33–36, 38–92, 108–109)

**Interfaces:** links to `usage-hyper-v.md` (created in Task 5).

- [ ] **Step 1: Rewrite host prerequisites**

Replace lines 9–16:
```
- Running on platforms besides Windows and/or VM hosts besides VMWare may work fine. In those cases though you'll need to open http/https ports 80/443 for the proxy host to your VM.

- Windows
- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- Tested with a Windows host and VMWare Workstation for the isolated VM.
  - Host's firewall's ports 80 and 443 for VMWare's network adapter will be opened by a supplied script. Using another OS or VM platform will require the same ports be available for the VM to reach the host.
```
→
```
- Windows host with **Hyper-V** for the isolated VM (see `usage-hyper-v.md`).
- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- The host firewall's ports 80 and 443 for the VM's Internal-switch adapter are opened by a supplied script. Running on other platforms may work but is untested; you would need those same ports reachable from the host to the VM.
```

- [ ] **Step 2: Reword the run-proxy and host-allow bullets**

Replace line 33's phrase:
```
It also streams the proxy's access log inline (see "Watching proxy traffic" below) and forwards the VMware host-only interface's `:80`/`:443` to Envoy on loopback,
```
→
```
It also streams the proxy's access log inline (see "Watching proxy traffic" below) and forwards the Hyper-V Internal-switch interface's `:80`/`:443` to Envoy on loopback,
```

Replace line 34's phrase:
```
This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter, and _prints the host IP you need to use in VM-side setup_.
```
→
```
This opens inbound TCP 80/443 (Envoy) from the VM's Internal-switch adapter, and _prints the host IP you need to use in VM-side setup_.
```

Replace line 36:
```
- It defaults to the `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
```
→
```
- It defaults to the `vEthernet (configamatron-internal)` adapter; pass `-AdapterAlias` if your Internal switch uses a different name (`Get-NetIPConfiguration` lists them). Safe to re-run if the host's IP on that network changes.
```

- [ ] **Step 3: Replace the entire VMware VM-setup section**

Replace lines 38–92 (from `## VM setup` through the end of "### Run the numbered scripts from the VM", i.e. up to and including the line `3. \`cd\` into \`vm-shared/post-scripts/\` ...`):
````
## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

> For a **Windows** guest instead of Ubuntu, follow `usage-windows-vm.md` and share the `.configamatron\vm-shared-windows` folder. The steps below cover the Ubuntu guest.
>
> To run either guest under **Hyper-V** instead of VMware, follow `usage-hyper-v.md` — it covers the switch, static-IP, and SMB-share differences, then hands back to the numbered scripts here (Ubuntu) or in `usage-windows-vm.md` (Windows).

### Create the VM and install the OS

- In VMware Workstation, create a new virtual machine:
  - Set a recent Ubuntu release as the installer image (ubuntu-26.04-desktop-amd64.iso is known to work).
  - 120 GB of dynamic disk space (or ask google for values for your intended use cases).
  - Select "Customize Hardware" before finishing: 12288 MB of static memory (or no more than half of the host machine's memory), 1 processor with 6 cores (or ask google for values for your specific processor). Leave the network as NAT for initial setup, pre-isolation.
- Start the VM and install the OS. Pick the defaults, except:
  - Uncheck "Require my password to log in" — anyone with access to the VM already has access to the host, and it is easier this way. Your password is still required for sudo.
  - Do not select "Install third-party apps for graphics and wi-fi hardware"; it may stall OS installation.
  - Do not enable Shared Folders before the OS is installed; it may stall OS installation.

### Enable open-vm-tools and share the environment folder

Run in the VM's terminal ('-desktop' helps with screen resolution on top of open-vm-tools' shared folders and copy'n'paste integration).

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Shut the VM down, then in VM -> Settings -> Options:

- "Shared Folders": enable only the environment's `.configamatron\vm-shared` folder, read-only.
- "Guest Isolation": consider disabling drag'n'drop and copy'n'paste sharing.

### Fix Shared Folders

#### The Inevitable Fix

Add the following line to '/etc/fstab' and restart the VM.

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

#### Not Sure The Inevitable Fix Is Right For You?

Maybe someday the fix above won't make sense. Is today that day? Start the VM and verify the share appears under `/mnt/hgfs/`. If there is no `/mnt/hgfs`, stop and restart folder sharing. If `/mnt/hgfs` doesn't contain your shared drive then do The Inevitable Fix above.

### Run the numbered scripts from the VM

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

Run without `sudo`; each script elevates internally where needed. The exact count may vary when custom steps are present.

1. `cd` into `vm-shared/pre-scripts/` and run every script in number order. The last step is `05-configure-network.sh <host-ip>` when there are no custom scripts.
2. Switch the VM network from NAT to host-only, then reboot.
3. `cd` into `vm-shared/post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.
````
→
````
## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

VM creation, the Internal virtual switch, static IPs, and the SMB share are covered in **`usage-hyper-v.md`** — for both guests:

- **Ubuntu guest:** follow `usage-hyper-v.md` to create the VM and mount the share at `/mnt/vm-shared`, then run the numbered scripts below.
- **Windows guest:** follow `usage-hyper-v.md` for the VM and share, then `usage-windows-vm.md` for the guest-side scripts.

### Run the numbered scripts from the VM

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

Run without `sudo`; each script elevates internally where needed. The exact count may vary when custom steps are present.

1. `cd` into `vm-shared/pre-scripts/` and run every script in number order. The last step is `05-configure-network.sh <host-ip>` when there are no custom scripts.
2. Isolate the VM's network — remove the temporary Default Switch adapter (see `usage-hyper-v.md`), then reboot.
3. `cd` into `vm-shared/post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.
````

- [ ] **Step 4: Fix the `/mnt/hgfs` path in "Verifying an environment"**

Replace line 109's path:
```
- **VM (configuration):** inside the VM, run `./mnt/hgfs/vm-shared/verify-config.sh [host-ip]`. Pass the `<host-ip>` from proxy setup to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.
```
→
```
- **VM (configuration):** inside the VM, run `/mnt/vm-shared/verify-config.sh [host-ip]`. Pass the `<host-ip>` from proxy setup to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.
```

- [ ] **Step 5: Verify no residue and the link resolves**

Run: `git grep -niE '(vmware|vmnet|hgfs|host-only|open-vm-tools)' -- README.md`
Expected: no output.
Run: `grep -q 'usage-hyper-v.md' README.md && test -e usage-hyper-v.md && echo "link-ok"`
Expected: prints `link-ok`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: make README VM setup Hyper-V only"
```

---

### Task 7: Rewrite usage-windows-vm.md

Replace VMware VM-creation, VMware Tools, `\\vmware-host\Shared Folders`, and the NAT→host-only step with Hyper-V, deferring host/network/share setup to `usage-hyper-v.md`.

**Files:**

- Modify: `usage-windows-vm.md` (lines 5–26)

**Interfaces:** links to `usage-hyper-v.md`.

- [ ] **Step 1: Replace the create/share/run sections**

Replace lines 5–26:
```
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
```
→
```
## Create the VM and share the folder

VM creation, the Internal switch, the guest's static IP, and the SMB share are covered in **`usage-hyper-v.md`** (Windows guest sections). Follow it first; it mounts the environment's `vm-shared-windows` folder at `\\<host-ip>\vm-shared-windows`. Return here for the guest-side scripts.

## Run the numbered scripts

Open an **elevated (Administrator) PowerShell**. The exact script count may vary when custom steps are present.

> cd "\\<host-ip>\vm-shared-windows\"

> Set-ExecutionPolicy RemoteSigned

1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\05-configure-network.ps1 -HostIp <ip>`.
2. Isolate the VM — remove the temporary Default Switch adapter (see `usage-hyper-v.md`), then reboot.
3. `cd ..\post-scripts` and run every script in order: normally `.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`.
```

- [ ] **Step 2: Verify no residue and the link resolves**

Run: `git grep -niE '(vmware|vmnet|hgfs|host-only)' -- usage-windows-vm.md`
Expected: no output.
Run: `grep -q 'usage-hyper-v.md' usage-windows-vm.md && echo "link-ok"`
Expected: prints `link-ok`.

- [ ] **Step 3: Commit**

```bash
git add usage-windows-vm.md
git commit -m "docs: make Windows guest guide Hyper-V only"
```

---

### Task 8: Rewrite technical-notes.md and delete the VMware display doc

Reword the VMware references in `technical-notes.md`, fix its broken `usage.md` link, and delete the VMware-only display-settings doc.

**Files:**

- Modify: `technical-notes.md` (lines 3, 41, 51, 55)
- Delete: `vmware-ubuntu-display-settings.md`

**Interfaces:** cross-references `docs/investigations/2026-07-22-host-side-dns-consolidation.md`.

- [ ] **Step 1: Fix the broken header link**

Replace line 3:
```
Maintainer and background material. Day-to-day setup lives in [usage.md](usage.md).
```
→
```
Maintainer and background material. Day-to-day setup lives in [README.md](README.md).
```

- [ ] **Step 2: Reword the VM-networking bullet (prose only; leave the historical spec-path citations)**

In line 41, change the two prose phrases (the `docs/superpowers/...` filename citations on the same line stay verbatim — they name real history files):
- `installs a guarded host-only default route at boot (host-only networking hands out no DHCP gateway)` → `installs a guarded default route at boot (the isolated Internal-switch network hands out no DHCP gateway)`

Leave the rest of line 41 (including `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md` and the other citation) unchanged.

- [ ] **Step 3: Reword the fidelity-gaps paragraph**

Replace line 51:
```
Residual fidelity gaps vs. a real VMware VM: the guest is an Ubuntu _cloud_ image with NetworkManager installed as the netplan renderer (approximating, not equaling, the Desktop installer's profile); the NAT→host-only switch keeps one subnet (production changes subnets); and open-vm-tools/hgfs sharing remains manual-only. To match Desktop's NetworkManager-only networking, the golden image **masks systemd-networkd** — the cloud image ships it enabled with a match-all dracut `.network`, and it would otherwise own the NIC and block 07's `127.0.0.1` DNS override at the systemd-resolved layer (`LinkBusy`). For the same reason `60-dns-override.yaml` sets `dhcp4: true` explicitly: on a renderer-only base netplan the override is the sole definition of the interface, so without it NetworkManager renders a dead `link-local` profile and never applies the stub nameserver.
```
→
```
Residual fidelity gaps vs. a real Hyper-V VM: the guest is an Ubuntu _cloud_ image with NetworkManager installed as the netplan renderer (approximating, not equaling, the Desktop installer's profile); the NAT→gateway-less switch keeps one subnet (production changes subnets); and the harness models a DHCP network rather than Hyper-V's static Internal switch (re-modeling it is deferred — see `docs/investigations/2026-07-22-host-side-dns-consolidation.md`). To match Desktop's NetworkManager-only networking, the golden image **masks systemd-networkd** — the cloud image ships it enabled with a match-all dracut `.network`, and it would otherwise own the NIC and block 07's `127.0.0.1` DNS override at the systemd-resolved layer (`LinkBusy`). For the same reason `60-dns-override.yaml` sets `dhcp4: true` explicitly: on a renderer-only base netplan the override is the sole definition of the interface, so without it NetworkManager renders a dead `link-local` profile and never applies the stub nameserver.
```

- [ ] **Step 4: Reword the host-forwarder note**

Replace line 55:
```
Docker Desktop's published-port relay (WSL2 backend) accepts connections arriving on the VMware host-only interface slowly and unreliably, while loopback connections to the same Envoy ports are instant. So `docker-compose` publishes Envoy on `127.0.0.1` only, and `run-proxy` runs a byte-transparent TCP forwarder on the host-only adapter IP that pipes `:80`/`:443` to `127.0.0.1`. Forwarding is active only while `run-proxy` runs (which is required anyway for token freshness). Disable it with `--no-forward`; override the bind IP with `--forward-listen <ip>`. See docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md.
```
→
```
Docker Desktop's published-port relay (WSL2 backend) accepts connections arriving on the Hyper-V Internal-switch interface slowly and unreliably, while loopback connections to the same Envoy ports are instant. So `docker-compose` publishes Envoy on `127.0.0.1` only, and `run-proxy` runs a byte-transparent TCP forwarder on the Internal-switch adapter IP that pipes `:80`/`:443` to `127.0.0.1`. Forwarding is active only while `run-proxy` runs (which is required anyway for token freshness). Disable it with `--no-forward`; override the bind IP with `--forward-listen <ip>`. See docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md.
```

- [ ] **Step 5: Delete the VMware display doc**

Run: `git rm vmware-ubuntu-display-settings.md`

- [ ] **Step 6: Verify no residual VMware terms (allowing only historical spec-path citations)**

Run: `git grep -niE '(vmware|vmnet|hgfs|host-only|open-vm-tools)' -- technical-notes.md | grep -viE 'docs/(superpowers|honist-v)/' || echo "CLEAN"`
Expected: prints `CLEAN` (the only remaining matches are `docs/superpowers/...` history-file citations, which are filtered out).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: reword technical-notes to Hyper-V; drop VMware display doc"
```

---

### Task 9: Whole-repo verification gate

Prove no VMware/`host-only` terms survive outside history docs and that all behavior is unchanged. This task has no source edits — it is the final gate. If any check fails, return to the relevant task, fix, and re-run.

**Files:** none (verification only).

- [ ] **Step 1: Repo-wide terminology grep**

Run:
```bash
git grep -niE '(vmware|vmnet|hgfs|vmrun|\bvmx\b|open-vm-tools|host-only)' \
  -- . ':!docs/superpowers/' ':!docs/honist-v/' ':!legacy/' ':!docs/investigations/' \
  | grep -viE 'docs/(superpowers|honist-v)/' || echo "CLEAN"
```
Expected: prints `CLEAN`. (The pathspec excludes the history/planning trees; the trailing filter drops any remaining line that merely *cites* a history-file path, e.g. the spec citations in `technical-notes.md`.)

- [ ] **Step 2: Full test pipeline (Docker required)**

Run: `pnpm test`
Expected: PASS through `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration`. (Docker must be running for the integration stage.)

- [ ] **Step 3: VM e2e harness (WSL2/QEMU)**

Run: `pnpm test:vm`
Expected: PASS. Confirms the reworded harness comments/names did not disturb the S1/S2/S3 flow. This is the slow gate (builds/boots a QEMU guest); if the WSL harness is not provisioned on this machine, note that it was skipped and why, and run it before merge.

- [ ] **Step 4: Confirm the deferred work is preserved and the renamed file is consistent**

Run:
```bash
test -e docs/investigations/2026-07-22-host-side-dns-consolidation.md \
  && test -e usage-hyper-v.md \
  && test ! -e usage-hyper-v-host.md \
  && test ! -e vmware-ubuntu-display-settings.md \
  && echo "structure-ok"
```
Expected: prints `structure-ok`.

- [ ] **Step 5: Final status**

Run: `git status && git log --oneline -9`
Expected: clean working tree; the nine cleanup commits (Tasks 1–8 plus this plan's own commit) present. No further commit is needed for this gate task.

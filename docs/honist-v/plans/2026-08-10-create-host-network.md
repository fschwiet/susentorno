# Create/Delete Host Network Implementation Plan

**Goal:** Replace `setup-machine.md`'s manual Internal-switch creation and `templates/proxy/host-allow-vm-inbound.ps1` with two CLI commands, `susentorno create-host-network` and `susentorno delete-host-network`, per [docs/honist-v/specs/2026-08-10-create-host-network-design.md](../specs/2026-08-10-create-host-network-design.md).

**Architecture:** Pure PowerShell command-string builders and parsers under `src/hostNetwork/` (unit tested directly), orchestration functions composed from them (unit tested with fakes), thin CLI glue in `src/commands/` (elevation gate, prompting, printing) — mirroring the existing `src/guestSetup/`/`src/commands/setupGuestUnix.ts` split. A new `host-network` test tier runs the real commands against real Hyper-V/Windows Firewall, admin-gated.

**Tech Stack:** TypeScript, Commander, `execa` (via the existing `PowerShellExec` wrapper — no new dependency), Vitest, Node's `node:os` for local interface/subnet detection.

## Global Constraints

- Every value interpolated into a PowerShell `-Command` string is quoted via the existing `quoteForPowerShell` (`src/guestSetup/quoteForPowerShell.ts`) — same rule this codebase already applies throughout `src/guestSetup/`.
- Every mutating PowerShell command (`New-VMSwitch`, `New-NetIPAddress`, `New-NetFirewallRule`, `Remove-VMSwitch`) passes `-ErrorAction Stop` and is wrapped in `try { ... } catch { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }`, because the shared `PowerShellExec` wrapper (`src/guestSetup/powerShellExec.ts`) captures only `stdout`/`exitCode`, never `stderr`.
- Query and cleanup/sweep commands use `-ErrorAction SilentlyContinue` and are read by parsing `stdout`, never by exit code — empty/non-matching output means "not found," not failure.
- `--isolation-name` is restricted to letters, digits, and hyphens (validated in `hostNetworkNames.ts`) before it's used to build any PowerShell command — this is what makes reusing the existing wildcard-tolerant `Get-VMSwitch -Name`/`Get-NetFirewallRule -DisplayName` queries safe without extra exact-match filtering.
- Elevation (`isElevated`) is checked once, in the CLI glue layer (`src/commands/createHostNetwork.ts`/`deleteHostNetwork.ts`), before any prompting. The orchestration modules under `src/hostNetwork/` assume an elevated context and never re-check it.
- Follow this repo's existing conventions: `node:`-prefixed core imports, flat `tests/unit/hostNetwork/*.test.ts` layout, Prettier/ESLint conventions already configured (`pnpm format`, `pnpm lint` must pass before every commit in this plan).
- Run `pnpm typecheck` before every commit that touches `.ts` files — this codebase has no implicit `any` tolerance in its existing code.

---

## Task 1: Verify elevated PowerShell session

This entire feature only makes sense to build and manually verify from an elevated terminal — every later task's manual verification step (running the real commands against Hyper-V, running the `host-network` test tier) requires it. Confirm this first, before writing any code, so a mid-implementation discovery of a non-elevated shell doesn't waste work.

- [ ] **Step 1: Confirm the current PowerShell session is elevated**

Run in your PowerShell terminal:

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

Expected: `True`. If it prints `False`, close this terminal and reopen PowerShell (or Windows Terminal) via "Run as Administrator" before continuing — every later manual-verification step in this plan assumes this.

- [ ] **Step 2: Confirm Hyper-V's PowerShell module is available**

```powershell
Get-Command Get-VMSwitch -ErrorAction Stop | Out-Null; Write-Host "Hyper-V module OK"
```

Expected: `Hyper-V module OK`, no error. If this fails, Hyper-V's Windows feature isn't enabled on this machine — required for both writing and manually verifying this feature.

No commit for this task — it's a precondition check, not a code change.

---

## Task 2: `HostNetworkError` and `runMutation` shared helper

**Files:**

- Create: `src/hostNetwork/hostNetworkError.ts`
- Test: `tests/unit/hostNetwork/hostNetworkError.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export class HostNetworkError extends Error {}
  export function runMutation(exec: PowerShellExec, command: string): Promise<void>;
  ```

Every later task in `src/hostNetwork/` throws `HostNetworkError` for a domain failure, and the two CLI-glue command files (Task 9, Task 10) catch exactly this one type to print a clean `create-host-network: <message>` / `delete-host-network: <message>` and set `process.exitCode = 1`. `runMutation` is the single chokepoint that turns a mutating PowerShell command's result into either success or a thrown `HostNetworkError`, per the Global Constraints' error-propagation rule (the shared `PowerShellExec` wrapper never captures `stderr`, so every mutating command's builder embeds its own `try/catch` that writes `"ERROR: <message>"` to stdout on failure).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/hostNetworkError.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { HostNetworkError, runMutation } from '../../../src/hostNetwork/hostNetworkError';

function fakeExec(result: { exitCode: number; stdout: string }): PowerShellExec {
  return { async run() { return result; } };
}

describe('runMutation', () => {
  it('resolves when the command exits 0 with no ERROR: line', async () => {
    await expect(runMutation(fakeExec({ exitCode: 0, stdout: '' }), 'Some-Command')).resolves.toBeUndefined();
  });

  it('throws HostNetworkError with the message after "ERROR: " when present', async () => {
    const exec = fakeExec({ exitCode: 1, stdout: 'ERROR: switch already in use\r\n' });
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow(HostNetworkError);
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow('switch already in use');
  });

  it('throws a generic HostNetworkError when exit code is non-zero with no ERROR: line', async () => {
    const exec = fakeExec({ exitCode: 1, stdout: '' });
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow(HostNetworkError);
    await expect(runMutation(exec, 'Some-Command')).rejects.toThrow('exit code 1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkError.test.ts`
Expected: FAIL — `Cannot find module '../../../src/hostNetwork/hostNetworkError'`

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/hostNetworkError.ts`:

```typescript
import type { PowerShellExec } from '../guestSetup/powerShellExec';

/**
 * Thrown by every module under src/hostNetwork/ for a domain failure. The two
 * command-glue files (createHostNetwork.ts, deleteHostNetwork.ts commands)
 * catch exactly this type to print a clean, prefixed message.
 */
export class HostNetworkError extends Error {}

const ERROR_PREFIX = 'ERROR: ';

/**
 * Runs a mutating PowerShell command built with the project's
 * `-ErrorAction Stop` + try/catch convention (see Global Constraints) and
 * turns its result into either success or a thrown HostNetworkError. The
 * shared PowerShellExec wrapper never captures stderr, so a failing
 * mutation's message travels through stdout as "ERROR: <message>" instead.
 */
export async function runMutation(exec: PowerShellExec, command: string): Promise<void> {
  const result = await exec.run(command);
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith(ERROR_PREFIX)) {
    throw new HostNetworkError(trimmed.slice(ERROR_PREFIX.length));
  }
  if (result.exitCode !== 0) {
    throw new HostNetworkError(`PowerShell command failed with exit code ${result.exitCode}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkError.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/hostNetworkError.ts tests/unit/hostNetwork/hostNetworkError.test.ts
git commit -m "feat(hostNetwork): add HostNetworkError and runMutation"
```

---

## Task 3: `hostNetworkNames.ts` — isolation-name validation and name derivation

**Files:**

- Create: `src/hostNetwork/hostNetworkNames.ts`
- Test: `tests/unit/hostNetwork/hostNetworkNames.test.ts`

**Interfaces:**

- Consumes: `deriveSwitchName` (`src/guestSetup/switchName.ts`), `DEFAULT_INTERNAL_SWITCH_ADAPTER` (`src/runHosting/forwarder.ts`), `HostNetworkError` (Task 2).
- Produces:
  ```typescript
  export interface HostNetworkNames {
    switchName: string;
    adapterAlias: string;
    envoyRuleName: string;
    dnsRuleName: string;
    dhcpRuleName: string;
    smbRuleName: string;
  }
  export function resolveHostNetworkNames(isolationName?: string): HostNetworkNames;
  ```
  Every later task that needs the switch name, adapter alias, or a rule `DisplayName` calls this — it is the single chokepoint that validates `isolationName` (throwing `HostNetworkError` if invalid) before any name derived from it is used to build a PowerShell command.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/hostNetworkNames.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import { resolveHostNetworkNames } from '../../../src/hostNetwork/hostNetworkNames';

describe('resolveHostNetworkNames', () => {
  it('uses the fixed default names when no isolation name is given', () => {
    expect(resolveHostNetworkNames()).toEqual({
      switchName: 'susentorno-internal',
      adapterAlias: 'vEthernet (susentorno-internal)',
      envoyRuleName: 'susentorno Envoy Proxy (VM inbound)',
      dnsRuleName: 'susentorno DNS stub (VM inbound)',
      dhcpRuleName: 'susentorno DHCP (VM inbound)',
      smbRuleName: 'susentorno share (VM inbound)',
    });
  });

  it('splices the isolation name into every derived name', () => {
    expect(resolveHostNetworkNames('test')).toEqual({
      switchName: 'susentorno-test-internal',
      adapterAlias: 'vEthernet (susentorno-test-internal)',
      envoyRuleName: 'susentorno-test Envoy Proxy (VM inbound)',
      dnsRuleName: 'susentorno-test DNS stub (VM inbound)',
      dhcpRuleName: 'susentorno-test DHCP (VM inbound)',
      smbRuleName: 'susentorno-test share (VM inbound)',
    });
  });

  it('accepts letters, digits, and hyphens', () => {
    expect(() => resolveHostNetworkNames('ci-Run-42')).not.toThrow();
  });

  it.each(['*', '?', '[a]', 'a b', "a'b", 'a;b', ''])(
    'rejects an isolation name containing %j',
    (bad) => {
      expect(() => resolveHostNetworkNames(bad)).toThrow(HostNetworkError);
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkNames.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/hostNetworkNames.ts`:

```typescript
import { deriveSwitchName } from '../guestSetup/switchName';
import { DEFAULT_INTERNAL_SWITCH_ADAPTER } from '../runHosting/forwarder';
import { HostNetworkError } from './hostNetworkError';

const ISOLATION_NAME_RE = /^[A-Za-z0-9-]+$/;

export interface HostNetworkNames {
  switchName: string;
  adapterAlias: string;
  envoyRuleName: string;
  dnsRuleName: string;
  dhcpRuleName: string;
  smbRuleName: string;
}

/**
 * `--isolation-name` is derived directly into PowerShell -Name/-DisplayName
 * queries, both of which are wildcard-tolerant (Get-VMSwitch -Name,
 * Get-NetFirewallRule -DisplayName). Restricting it to a safe character set
 * up front — no `*`, `?`, `[`, `]`, spaces, quotes — is what makes reusing
 * those queries as-is safe, without needing separate exact-match filtering.
 */
export function resolveHostNetworkNames(isolationName?: string): HostNetworkNames {
  if (isolationName !== undefined && !ISOLATION_NAME_RE.test(isolationName)) {
    throw new HostNetworkError(
      `--isolation-name '${isolationName}' is invalid: only letters, digits, and hyphens are allowed.`,
    );
  }

  const baseSwitchName = deriveSwitchName(DEFAULT_INTERNAL_SWITCH_ADAPTER);
  if (!baseSwitchName) {
    throw new HostNetworkError(
      `DEFAULT_INTERNAL_SWITCH_ADAPTER '${DEFAULT_INTERNAL_SWITCH_ADAPTER}' is not a valid vEthernet adapter alias.`,
    );
  }

  const switchName = isolationName ? `susentorno-${isolationName}-internal` : baseSwitchName;
  const prefix = isolationName ? `susentorno-${isolationName}` : 'susentorno';

  return {
    switchName,
    adapterAlias: `vEthernet (${switchName})`,
    envoyRuleName: `${prefix} Envoy Proxy (VM inbound)`,
    dnsRuleName: `${prefix} DNS stub (VM inbound)`,
    dhcpRuleName: `${prefix} DHCP (VM inbound)`,
    smbRuleName: `${prefix} share (VM inbound)`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkNames.test.ts`
Expected: PASS (10 tests — 3 plus 7 from the `it.each` table)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/hostNetworkNames.ts tests/unit/hostNetwork/hostNetworkNames.test.ts
git commit -m "feat(hostNetwork): add isolation-name validation and name derivation"
```

---

## Task 4: `subnetSelection.ts` — netmask-aware subnet detection

**Files:**

- Create: `src/hostNetwork/subnetSelection.ts`
- Test: `tests/unit/hostNetwork/subnetSelection.test.ts`

**Interfaces:**

- Consumes: `HostNetworkError` (Task 2), `node:os`'s `NetworkInterfaceInfo`.
- Produces:
  ```typescript
  export interface TakenRange {
    network: number;
    prefixLength: number;
  }
  export function detectTakenRanges(
    interfaces?: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>,
  ): TakenRange[];
  export function isSubnetTaken(n: number, takenRanges: TakenRange[]): boolean;
  export function findFreeSubnet(takenRanges: TakenRange[]): number | null;
  export function validateSubnet(n: number, takenRanges: TakenRange[]): void;
  ```
  Task 7 (`createHostNetwork.ts`) and Task 9 (CLI glue's interactive prompt) both call these. `TakenRange` and the four functions are the only things Task 7/9 need from this module.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/subnetSelection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import {
  detectTakenRanges,
  isSubnetTaken,
  findFreeSubnet,
  validateSubnet,
} from '../../../src/hostNetwork/subnetSelection';

function ipv4(address: string, netmask: string): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
  } as NetworkInterfaceInfo;
}

describe('detectTakenRanges', () => {
  it('reads a /24 address into a network/prefixLength pair', () => {
    const ranges = detectTakenRanges({ Eth0: [ipv4('192.168.67.5', '255.255.255.0')] });
    expect(ranges).toEqual([{ network: ipToInt('192.168.67.0'), prefixLength: 24 }]);
  });

  it('ignores non-IPv4 entries', () => {
    const ranges = detectTakenRanges({
      Eth0: [{ ...ipv4('192.168.67.5', '255.255.255.0'), family: 'IPv6' } as NetworkInterfaceInfo],
    });
    expect(ranges).toEqual([]);
  });

  function ipToInt(ip: string): number {
    const [a, b, c, d] = ip.split('.').map(Number);
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }
});

describe('isSubnetTaken / findFreeSubnet', () => {
  it('reports a /24 taken only at its own third octet', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.67.5', '255.255.255.0')] });
    expect(isSubnetTaken(67, taken)).toBe(true);
    expect(isSubnetTaken(68, taken)).toBe(false);
  });

  it('reports every 192.168.n.0/24 taken when a /16 address is present (broader-prefix collision)', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.1.10', '255.255.0.0')] });
    expect(isSubnetTaken(0, taken)).toBe(true);
    expect(isSubnetTaken(200, taken)).toBe(true);
  });

  it('finds the lowest free n', () => {
    const taken = detectTakenRanges({
      Eth0: [ipv4('192.168.0.5', '255.255.255.0'), ipv4('192.168.1.5', '255.255.255.0')],
    });
    expect(findFreeSubnet(taken)).toBe(2);
  });

  it('returns null when every n is taken', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.1.10', '255.255.0.0')] });
    expect(findFreeSubnet(taken)).toBeNull();
  });
});

describe('validateSubnet', () => {
  it('accepts a free, in-range n', () => {
    expect(() => validateSubnet(67, [])).not.toThrow();
  });

  it('rejects a negative n', () => {
    expect(() => validateSubnet(-1, [])).toThrow(HostNetworkError);
  });

  it('rejects an n above 255', () => {
    expect(() => validateSubnet(256, [])).toThrow(HostNetworkError);
  });

  it('rejects a non-integer n', () => {
    expect(() => validateSubnet(1.5, [])).toThrow(HostNetworkError);
  });

  it('rejects a taken n', () => {
    const taken = detectTakenRanges({ Eth0: [ipv4('192.168.67.5', '255.255.255.0')] });
    expect(() => validateSubnet(67, taken)).toThrow(HostNetworkError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/subnetSelection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/subnetSelection.ts`:

```typescript
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { HostNetworkError } from './hostNetworkError';

export interface TakenRange {
  network: number;
  prefixLength: number;
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function prefixMask(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

function netmaskToPrefixLength(netmask: string): number {
  const bits = ipToInt(netmask).toString(2).padStart(32, '0');
  return bits.split('').filter((b) => b === '1').length;
}

/**
 * Every IPv4 address currently configured on any local adapter, reduced to
 * its network/prefix — read via os.networkInterfaces(), the same in-process
 * source resolveForwardListenAddress already uses, so no PowerShell
 * round-trip is needed for this.
 */
export function detectTakenRanges(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): TakenRange[] {
  const ranges: TakenRange[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4') continue;
      const prefixLength = netmaskToPrefixLength(info.netmask);
      const mask = prefixMask(prefixLength);
      ranges.push({ network: (ipToInt(info.address) & mask) >>> 0, prefixLength });
    }
  }
  return ranges;
}

function rangesOverlap(a: TakenRange, b: TakenRange): boolean {
  const mask = prefixMask(Math.min(a.prefixLength, b.prefixLength));
  return (a.network & mask) === (b.network & mask);
}

/**
 * True if 192.168.<n>.0/24 overlaps any detected range — not just an exact
 * third-octet match. A taken address with a broader prefix (e.g. a /16)
 * collides with every /24 inside it, not only the one matching its literal
 * third octet.
 */
export function isSubnetTaken(n: number, takenRanges: TakenRange[]): boolean {
  const candidate: TakenRange = { network: ipToInt(`192.168.${n}.0`), prefixLength: 24 };
  return takenRanges.some((range) => rangesOverlap(candidate, range));
}

/** Lowest free n in 0-255, or null if every 192.168.n.0/24 is taken. */
export function findFreeSubnet(takenRanges: TakenRange[]): number | null {
  for (let n = 0; n <= 255; n++) {
    if (!isSubnetTaken(n, takenRanges)) return n;
  }
  return null;
}

export function validateSubnet(n: number, takenRanges: TakenRange[]): void {
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new HostNetworkError(`Subnet value '${n}' is invalid (must be an integer 0-255).`);
  }
  if (isSubnetTaken(n, takenRanges)) {
    throw new HostNetworkError(`192.168.${n}.0/24 overlaps an address already in use on this host.`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/subnetSelection.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/subnetSelection.ts tests/unit/hostNetwork/subnetSelection.test.ts
git commit -m "feat(hostNetwork): add netmask-aware subnet detection"
```

---

## Task 5: `hostNetworkSwitchOps.ts` — switch, IP, and VM-attachment command builders

**Files:**

- Create: `src/hostNetwork/hostNetworkSwitchOps.ts`
- Test: `tests/unit/hostNetwork/hostNetworkSwitchOps.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` (`src/guestSetup/quoteForPowerShell.ts`).
- Produces:
  ```typescript
  export function buildNewVmSwitchCommand(switchName: string): string;
  export function buildNewNetIpAddressCommand(adapterAlias: string, ipAddress: string): string;
  export function buildRemoveVmSwitchCommand(switchName: string): string;
  export function buildGetVmNetworkAdaptersOnSwitchCommand(switchName: string): string;
  export interface AttachedVm { vmName: string }
  export function parseAttachedVms(stdout: string): AttachedVm[];
  ```
  Task 7 (`createHostNetwork.ts`) uses `buildNewVmSwitchCommand`/`buildNewNetIpAddressCommand`. Task 8 (`deleteHostNetwork.ts`) uses `buildRemoveVmSwitchCommand`, `buildGetVmNetworkAdaptersOnSwitchCommand`, `parseAttachedVms`. The existing `buildGetVmSwitchCommand`/`parseVmSwitchExists` (`src/guestSetup/hyperVQueries.ts`) are reused as-is by both — no new switch-existence query is added here.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/hostNetworkSwitchOps.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildNewVmSwitchCommand,
  buildNewNetIpAddressCommand,
  buildRemoveVmSwitchCommand,
  buildGetVmNetworkAdaptersOnSwitchCommand,
  parseAttachedVms,
} from '../../../src/hostNetwork/hostNetworkSwitchOps';

describe('buildNewVmSwitchCommand', () => {
  it('creates an Internal switch with the given name, quoted', () => {
    const command = buildNewVmSwitchCommand("susentorno's-internal");
    expect(command).toContain("New-VMSwitch -Name 'susentorno''s-internal' -SwitchType Internal");
    expect(command).toContain('-ErrorAction Stop');
    expect(command).toContain('catch { Write-Output "ERROR:');
  });
});

describe('buildNewNetIpAddressCommand', () => {
  it('assigns a /24 IPv4 address to the given interface, quoted', () => {
    const command = buildNewNetIpAddressCommand('vEthernet (susentorno-internal)', '192.168.67.1');
    expect(command).toContain(
      "New-NetIPAddress -InterfaceAlias 'vEthernet (susentorno-internal)' -IPAddress '192.168.67.1' -PrefixLength 24",
    );
    expect(command).toContain('-ErrorAction Stop');
  });
});

describe('buildRemoveVmSwitchCommand', () => {
  it('removes the switch by name, quoted, non-interactively', () => {
    const command = buildRemoveVmSwitchCommand('susentorno-test-internal');
    expect(command).toContain("Remove-VMSwitch -Name 'susentorno-test-internal'");
    expect(command).toContain('-Force');
    expect(command).toContain('-ErrorAction Stop');
  });
});

describe('buildGetVmNetworkAdaptersOnSwitchCommand', () => {
  it('filters VM network adapters by switch name, quoted', () => {
    const command = buildGetVmNetworkAdaptersOnSwitchCommand("susentorno's-internal");
    expect(command).toContain('Get-VMNetworkAdapter -All');
    expect(command).toContain("-eq 'susentorno''s-internal'");
    expect(command).toContain('ConvertTo-Json -Compress');
  });
});

describe('parseAttachedVms', () => {
  it('returns an empty array for empty stdout', () => {
    expect(parseAttachedVms('')).toEqual([]);
  });

  it('parses a single VM', () => {
    expect(parseAttachedVms('{"VMName":"my-vm"}')).toEqual([{ vmName: 'my-vm' }]);
  });

  it('parses multiple VMs', () => {
    const stdout = '[{"VMName":"vm-a"},{"VMName":"vm-b"}]';
    expect(parseAttachedVms(stdout)).toEqual([{ vmName: 'vm-a' }, { vmName: 'vm-b' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkSwitchOps.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/hostNetworkSwitchOps.ts`:

```typescript
import { quoteForPowerShell } from '../guestSetup/quoteForPowerShell';

const TRY_CATCH_SUFFIX = 'catch { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }';

export function buildNewVmSwitchCommand(switchName: string): string {
  return (
    `try { New-VMSwitch -Name ${quoteForPowerShell(switchName)} -SwitchType Internal -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

export function buildNewNetIpAddressCommand(adapterAlias: string, ipAddress: string): string {
  return (
    `try { New-NetIPAddress -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-IPAddress ${quoteForPowerShell(ipAddress)} -PrefixLength 24 -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

/**
 * -Force suppresses Remove-VMSwitch's interactive confirmation prompt, which
 * would otherwise hang under -NonInteractive. Safe here because
 * deleteHostNetwork.ts always checks for attached VMs first (see
 * hostNetworkSwitchOps.ts's buildGetVmNetworkAdaptersOnSwitchCommand below)
 * and refuses to proceed if any are found.
 */
export function buildRemoveVmSwitchCommand(switchName: string): string {
  return (
    `try { Remove-VMSwitch -Name ${quoteForPowerShell(switchName)} -Force -ErrorAction Stop } ` + TRY_CATCH_SUFFIX
  );
}

export function buildGetVmNetworkAdaptersOnSwitchCommand(switchName: string): string {
  return (
    `Get-VMNetworkAdapter -All -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.SwitchName -eq ${quoteForPowerShell(switchName)} } | ` +
    `ForEach-Object { [PSCustomObject]@{ VMName = $_.VMName } } | ConvertTo-Json -Compress`
  );
}

export interface AttachedVm {
  vmName: string;
}

interface RawAttachedVm {
  VMName?: unknown;
}

export function parseAttachedVms(stdout: string): AttachedVm[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawAttachedVm[];
  return list
    .filter((v): v is { VMName: string } => typeof v.VMName === 'string')
    .map((v) => ({ vmName: v.VMName }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkSwitchOps.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/hostNetworkSwitchOps.ts tests/unit/hostNetwork/hostNetworkSwitchOps.test.ts
git commit -m "feat(hostNetwork): add switch/IP/VM-attachment command builders"
```

---

## Task 6: `hostNetworkFirewallOps.ts` — firewall rule builders and sweeps

**Files:**

- Create: `src/hostNetwork/hostNetworkFirewallOps.ts`
- Test: `tests/unit/hostNetwork/hostNetworkFirewallOps.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` (`src/guestSetup/quoteForPowerShell.ts`).
- Produces:
  ```typescript
  export function buildCreateEnvoyRuleCommand(ruleName: string, adapterAlias: string, hostIp: string, nodePath: string): string;
  export function buildCreateDnsRuleCommand(ruleName: string, adapterAlias: string, hostIp: string, nodePath: string): string;
  export function buildCreateDhcpRuleCommand(ruleName: string, adapterAlias: string, nodePath: string): string;
  export function buildCreateSmbRuleCommand(ruleName: string, adapterAlias: string, localAddress: string): string;
  export function buildRemoveRulesByNameCommand(ruleNames: string[]): string;
  export function buildRemoveStaleQueryUserRulesCommand(nodePath: string): string;
  export function buildRemoveRulesByInterfaceCommand(adapterAlias: string): string;
  export function parseCount(stdout: string): number;
  ```
  Task 7 (`createHostNetwork.ts`) uses all four `buildCreate*` functions, `buildRemoveRulesByNameCommand` (stale-cleanup before recreate), and `buildRemoveStaleQueryUserRulesCommand`. Task 8 (`deleteHostNetwork.ts`) uses `buildRemoveRulesByInterfaceCommand`, `buildRemoveStaleQueryUserRulesCommand`, `buildRemoveRulesByNameCommand` (the named SMB sweep — same function, reused), and `parseCount` to read every sweep's removed-rule count from stdout.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/hostNetworkFirewallOps.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildCreateEnvoyRuleCommand,
  buildCreateDnsRuleCommand,
  buildCreateDhcpRuleCommand,
  buildCreateSmbRuleCommand,
  buildRemoveRulesByNameCommand,
  buildRemoveStaleQueryUserRulesCommand,
  buildRemoveRulesByInterfaceCommand,
  parseCount,
} from '../../../src/hostNetwork/hostNetworkFirewallOps';

const ADAPTER = 'vEthernet (susentorno-internal)';
const HOST_IP = '192.168.67.1';
const NODE_PATH = 'C:\\Users\\me\\.susentorno-host\\node-copy-with-custom-firewall-rules.exe';

describe('buildCreateEnvoyRuleCommand', () => {
  it('opens TCP 80/443 scoped to the adapter, address, and dedicated node.exe', () => {
    const command = buildCreateEnvoyRuleCommand('susentorno Envoy Proxy (VM inbound)', ADAPTER, HOST_IP, NODE_PATH);
    expect(command).toContain("-DisplayName 'susentorno Envoy Proxy (VM inbound)'");
    expect(command).toContain('-Protocol TCP');
    expect(command).toContain('-LocalPort 80,443');
    expect(command).toContain(`-Program '${NODE_PATH}'`);
    expect(command).toContain(`-InterfaceAlias '${ADAPTER}'`);
    expect(command).toContain(`-LocalAddress '${HOST_IP}'`);
    expect(command).toContain('-ErrorAction Stop');
  });
});

describe('buildCreateDnsRuleCommand', () => {
  it('opens UDP 53 scoped the same way', () => {
    const command = buildCreateDnsRuleCommand('susentorno DNS stub (VM inbound)', ADAPTER, HOST_IP, NODE_PATH);
    expect(command).toContain('-Protocol UDP');
    expect(command).toContain('-LocalPort 53');
    expect(command).toContain(`-Program '${NODE_PATH}'`);
    expect(command).toContain(`-LocalAddress '${HOST_IP}'`);
  });
});

describe('buildCreateDhcpRuleCommand', () => {
  it('opens UDP 67 scoped to the interface only, no -LocalAddress', () => {
    const command = buildCreateDhcpRuleCommand('susentorno DHCP (VM inbound)', ADAPTER, NODE_PATH);
    expect(command).toContain('-Protocol UDP');
    expect(command).toContain('-LocalPort 67');
    expect(command).toContain(`-InterfaceAlias '${ADAPTER}'`);
    expect(command).not.toContain('-LocalAddress');
  });
});

describe('buildCreateSmbRuleCommand', () => {
  it('opens TCP 445 scoped to whatever adapter/address it is given', () => {
    const command = buildCreateSmbRuleCommand('susentorno share (VM inbound)', 'vEthernet (Default Switch)', '10.0.0.5');
    expect(command).toContain('-Protocol TCP');
    expect(command).toContain('-LocalPort 445');
    expect(command).toContain("-InterfaceAlias 'vEthernet (Default Switch)'");
    expect(command).toContain("-LocalAddress '10.0.0.5'");
    expect(command).not.toContain('-Program');
  });
});

describe('buildRemoveRulesByNameCommand', () => {
  it('removes every named rule, quoted, and outputs the total removed count', () => {
    const command = buildRemoveRulesByNameCommand(["susentorno's rule", 'another rule']);
    expect(command).toContain("'susentorno''s rule'");
    expect(command).toContain("'another rule'");
    expect(command).toContain('Remove-NetFirewallRule -ErrorAction SilentlyContinue');
    expect(command).toContain('Write-Output $removed');
  });
});

describe('buildRemoveStaleQueryUserRulesCommand', () => {
  it('matches by Query User name pattern and program-path suffix, and outputs the count', () => {
    const command = buildRemoveStaleQueryUserRulesCommand(NODE_PATH);
    expect(command).toContain('*Query User*');
    expect(command).toContain(`EndsWith('${NODE_PATH}'`);
    expect(command).toContain('OrdinalIgnoreCase');
    expect(command).toContain('Write-Output $stale.Count');
  });
});

describe('buildRemoveRulesByInterfaceCommand', () => {
  it('matches rules by interface filter regardless of name, and outputs the count', () => {
    const command = buildRemoveRulesByInterfaceCommand(ADAPTER);
    expect(command).toContain('Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule');
    expect(command).toContain(`-eq '${ADAPTER}'`);
    expect(command).toContain('Remove-NetFirewallRule -ErrorAction SilentlyContinue');
    expect(command).toContain('Write-Output $matched.Count');
  });
});

describe('parseCount', () => {
  it('parses a plain integer', () => {
    expect(parseCount('3\r\n')).toBe(3);
  });

  it('parses zero', () => {
    expect(parseCount('0')).toBe(0);
  });

  it('defaults to 0 for empty or unexpected output', () => {
    expect(parseCount('')).toBe(0);
    expect(parseCount('not a number')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkFirewallOps.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/hostNetworkFirewallOps.ts`:

```typescript
import { quoteForPowerShell } from '../guestSetup/quoteForPowerShell';

const TRY_CATCH_SUFFIX = 'catch { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }';

export function buildCreateEnvoyRuleCommand(
  ruleName: string,
  adapterAlias: string,
  hostIp: string,
  nodePath: string,
): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol TCP ` +
    `-LocalPort 80,443 -Program ${quoteForPowerShell(nodePath)} -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-LocalAddress ${quoteForPowerShell(hostIp)} -Action Allow -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

export function buildCreateDnsRuleCommand(
  ruleName: string,
  adapterAlias: string,
  hostIp: string,
  nodePath: string,
): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol UDP ` +
    `-LocalPort 53 -Program ${quoteForPowerShell(nodePath)} -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-LocalAddress ${quoteForPowerShell(hostIp)} -Action Allow -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

/** DHCP has no fixed destination address to scope to (a client without an address broadcasts DISCOVER from 0.0.0.0), so -LocalAddress is never added here — the one deliberate exception among these four rule sets. */
export function buildCreateDhcpRuleCommand(ruleName: string, adapterAlias: string, nodePath: string): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol UDP ` +
    `-LocalPort 67 -Program ${quoteForPowerShell(nodePath)} -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-Action Allow -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

/** Called twice by createHostNetwork.ts — once for the Internal-switch adapter/host IP, once for the NAT adapter/NAT IP. */
export function buildCreateSmbRuleCommand(ruleName: string, adapterAlias: string, localAddress: string): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol TCP ` +
    `-LocalPort 445 -InterfaceAlias ${quoteForPowerShell(adapterAlias)} -LocalAddress ${quoteForPowerShell(localAddress)} ` +
    `-Action Allow -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

/**
 * Removes every rule matching any of the given DisplayNames, regardless of
 * adapter. Reused two ways: createHostNetwork.ts's stale-cleanup-before-
 * recreate (all four names at once, return value ignored) and
 * deleteHostNetwork.ts's named SMB sweep (just the SMB rule name, count
 * parsed via parseCount).
 */
export function buildRemoveRulesByNameCommand(ruleNames: string[]): string {
  const namesArray = ruleNames.map((n) => quoteForPowerShell(n)).join(', ');
  return (
    `$removed = 0; foreach ($name in @(${namesArray})) { ` +
    `$matches = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue); ` +
    `if ($matches) { $matches | Remove-NetFirewallRule -ErrorAction SilentlyContinue; $removed += $matches.Count } ` +
    `}; Write-Output $removed`
  );
}

/** Ported from host-allow-vm-inbound.ps1's stale prompt-generated rule cleanup. Not isolation-scoped: there is exactly one dedicated node.exe path host-wide. */
export function buildRemoveStaleQueryUserRulesCommand(nodePath: string): string {
  return (
    `$stale = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { ` +
    `$_.Name -like "*Query User*" -and $_.Name.EndsWith(${quoteForPowerShell(nodePath)}, [StringComparison]::OrdinalIgnoreCase) }); ` +
    `if ($stale) { $stale | Remove-NetFirewallRule -ErrorAction SilentlyContinue }; Write-Output $stale.Count`
  );
}

/**
 * Removes every rule whose interface filter matches the given adapter alias,
 * regardless of DisplayName — deleteHostNetwork.ts's "clean up a corrupted
 * network" sweep. Mirrors verify-proxy.ps1's existing
 * Get-NetFirewallInterfaceFilter/-eq pattern for reading a rule's interface
 * scoping.
 */
export function buildRemoveRulesByInterfaceCommand(adapterAlias: string): string {
  return (
    `$matched = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { ` +
    `(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $_ -ErrorAction SilentlyContinue).InterfaceAlias -eq ${quoteForPowerShell(adapterAlias)} ` +
    `}); if ($matched) { $matched | Remove-NetFirewallRule -ErrorAction SilentlyContinue }; Write-Output $matched.Count`
  );
}

/** Reads the trailing integer count every sweep command above writes via Write-Output. Defaults to 0 for unexpected output rather than throwing — this feeds a summary message, not a correctness-critical decision. */
export function parseCount(stdout: string): number {
  const trimmed = stdout.trim();
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/hostNetworkFirewallOps.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/hostNetworkFirewallOps.ts tests/unit/hostNetwork/hostNetworkFirewallOps.test.ts
git commit -m "feat(hostNetwork): add firewall rule builders and cleanup sweeps"
```

---

## Task 7: `createHostNetwork.ts` — create orchestration

**Files:**

- Create: `src/hostNetwork/createHostNetwork.ts`
- Test: `tests/unit/hostNetwork/createHostNetwork.test.ts`

**Interfaces:**

- Consumes: `resolveHostNetworkNames` (Task 3), `detectTakenRanges`/`validateSubnet` (Task 4), `buildNewVmSwitchCommand`/`buildNewNetIpAddressCommand` (Task 5), `buildGetVmSwitchCommand`/`parseVmSwitchExists` (`src/guestSetup/hyperVQueries.ts`), the four `buildCreate*RuleCommand` functions/`buildRemoveRulesByNameCommand`/`buildRemoveStaleQueryUserRulesCommand` (Task 6), `HostNetworkError`/`runMutation` (Task 2), `resolveForwardListenAddress` (`src/runHosting/forwarder.ts`), `getDedicatedNodePath` (`src/runHosting/relaunchViaDedicatedNode.ts`), `PowerShellExec` (`src/guestSetup/powerShellExec.ts`).
- Produces:
  ```typescript
  export interface CreateHostNetworkOptions {
    exec: PowerShellExec;
    isolationName?: string;
    subnet?: number;
    natAdapterAlias: string;
    homedir: string;
    networkInterfaces?: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
    promptSubnet: (taken: import('./subnetSelection').TakenRange[], defaultN: number) => Promise<number>;
  }
  export interface CreateHostNetworkResult {
    hostIp: string;
    refreshedOnly: boolean;
  }
  export async function createHostNetwork(opts: CreateHostNetworkOptions): Promise<CreateHostNetworkResult>;
  ```
  Task 9 (`src/commands/createHostNetwork.ts`) is the only caller. It supplies `promptSubnet` as an interactive, retry-on-invalid prompt (using `validateSubnet` internally) and reads `refreshedOnly` to decide which message to print.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/createHostNetwork.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import { createHostNetwork } from '../../../src/hostNetwork/createHostNetwork';

const NAT_ALIAS = 'vEthernet (Default Switch)';
const HOMEDIR = 'C:\\Users\\me';

function queuedExec(responses: Array<{ exitCode: number; stdout: string }>): {
  exec: PowerShellExec;
  calls: string[];
} {
  const calls: string[] = [];
  const queue = [...responses];
  return {
    exec: {
      async run(command: string) {
        calls.push(command);
        return queue.shift() ?? { exitCode: 0, stdout: '' };
      },
    },
    calls,
  };
}

const natInterfaces = {
  Eth0: [
    {
      address: '10.0.75.1',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: null,
    },
  ],
} as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

describe('createHostNetwork', () => {
  it('creates a fresh switch, IP, and rules when the switch does not exist, using the prompted subnet', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // Get-VMSwitch: not found
      { exitCode: 0, stdout: '' }, // New-VMSwitch
      { exitCode: 0, stdout: '' }, // New-NetIPAddress
      { exitCode: 0, stdout: '0' }, // stale-name cleanup
      { exitCode: 0, stdout: '0' }, // stale Query User cleanup
      { exitCode: 0, stdout: '' }, // create Envoy rule
      { exitCode: 0, stdout: '' }, // create DNS rule
      { exitCode: 0, stdout: '' }, // create DHCP rule
      { exitCode: 0, stdout: '' }, // create SMB rule (internal)
      { exitCode: 0, stdout: '' }, // create SMB rule (NAT)
    ]);
    const promptSubnet = vi.fn().mockResolvedValue(67);

    const result = await createHostNetwork({
      exec,
      natAdapterAlias: NAT_ALIAS,
      homedir: HOMEDIR,
      networkInterfaces: natInterfaces,
      promptSubnet,
    });

    expect(result).toEqual({ hostIp: '192.168.67.1', refreshedOnly: false });
    expect(promptSubnet).toHaveBeenCalledWith(expect.any(Array), 0);
    expect(calls[1]).toContain('New-VMSwitch');
    expect(calls[2]).toContain("New-NetIPAddress -InterfaceAlias 'vEthernet (susentorno-internal)' -IPAddress '192.168.67.1'");
  });

  it('uses --subnet directly, skipping the prompt', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '' },
    ]);
    const promptSubnet = vi.fn();

    const result = await createHostNetwork({
      exec,
      subnet: 80,
      natAdapterAlias: NAT_ALIAS,
      homedir: HOMEDIR,
      networkInterfaces: natInterfaces,
      promptSubnet,
    });

    expect(result.hostIp).toBe('192.168.80.1');
    expect(promptSubnet).not.toHaveBeenCalled();
  });

  it('rejects a taken --subnet without touching Hyper-V', async () => {
    const { exec, calls } = queuedExec([{ exitCode: 0, stdout: '' }]);
    const takenInterfaces = {
      Eth0: [
        { address: '192.168.80.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'x', internal: false, cidr: null },
        ...natInterfaces.Eth0!,
      ],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

    await expect(
      createHostNetwork({
        exec,
        subnet: 80,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: takenInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    expect(calls.some((c) => c.includes('New-VMSwitch'))).toBe(false);
  });

  it('refreshes firewall rules only when the switch already exists, skipping switch/IP creation and the prompt', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }, // Get-VMSwitch: found
      { exitCode: 0, stdout: '0' }, // stale-name cleanup
      { exitCode: 0, stdout: '0' }, // stale Query User cleanup
      { exitCode: 0, stdout: '' }, // create Envoy rule
      { exitCode: 0, stdout: '' }, // create DNS rule
      { exitCode: 0, stdout: '' }, // create DHCP rule
      { exitCode: 0, stdout: '' }, // create SMB rule (internal)
      { exitCode: 0, stdout: '' }, // create SMB rule (NAT)
    ]);
    const promptSubnet = vi.fn();
    const existingInterfaces = {
      Eth0: [
        { address: '192.168.67.1', netmask: '255.255.255.0', family: 'IPv4', mac: 'x', internal: false, cidr: null },
        ...natInterfaces.Eth0!,
      ],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

    const result = await createHostNetwork({
      exec,
      natAdapterAlias: NAT_ALIAS,
      homedir: HOMEDIR,
      networkInterfaces: existingInterfaces,
      promptSubnet,
    });

    expect(result).toEqual({ hostIp: '192.168.67.1', refreshedOnly: true });
    expect(promptSubnet).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('New-VMSwitch'))).toBe(false);
    expect(calls.some((c) => c.includes('New-NetIPAddress'))).toBe(false);
  });

  it('fails if the existing switch has no resolvable IPv4', async () => {
    const { exec } = queuedExec([{ exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }]);

    await expect(
      createHostNetwork({
        exec,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces, // no susentorno-internal adapter present
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
  });

  it('fails before touching Hyper-V if the NAT adapter has no resolvable IPv4', async () => {
    const { exec, calls } = queuedExec([]);

    await expect(
      createHostNetwork({
        exec,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: {},
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid isolation name before doing anything', async () => {
    const { exec, calls } = queuedExec([]);

    await expect(
      createHostNetwork({
        exec,
        isolationName: '*',
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow(HostNetworkError);
    expect(calls).toHaveLength(0);
  });

  it('propagates a mutation failure as HostNetworkError', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' },
      { exitCode: 1, stdout: 'ERROR: switch already exists on the underlying vSwitch layer' },
    ]);

    await expect(
      createHostNetwork({
        exec,
        subnet: 67,
        natAdapterAlias: NAT_ALIAS,
        homedir: HOMEDIR,
        networkInterfaces: natInterfaces,
        promptSubnet: vi.fn(),
      }),
    ).rejects.toThrow('switch already exists on the underlying vSwitch layer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/createHostNetwork.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/createHostNetwork.ts`:

```typescript
import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { PowerShellExec } from '../guestSetup/powerShellExec';
import { buildGetVmSwitchCommand, parseVmSwitchExists } from '../guestSetup/hyperVQueries';
import { resolveForwardListenAddress } from '../runHosting/forwarder';
import { getDedicatedNodePath } from '../runHosting/relaunchViaDedicatedNode';
import { HostNetworkError, runMutation } from './hostNetworkError';
import { resolveHostNetworkNames } from './hostNetworkNames';
import { detectTakenRanges, validateSubnet, findFreeSubnet, type TakenRange } from './subnetSelection';
import {
  buildNewVmSwitchCommand,
  buildNewNetIpAddressCommand,
} from './hostNetworkSwitchOps';
import {
  buildCreateEnvoyRuleCommand,
  buildCreateDnsRuleCommand,
  buildCreateDhcpRuleCommand,
  buildCreateSmbRuleCommand,
  buildRemoveRulesByNameCommand,
  buildRemoveStaleQueryUserRulesCommand,
} from './hostNetworkFirewallOps';

export interface CreateHostNetworkOptions {
  exec: PowerShellExec;
  isolationName?: string;
  /** 0-255. If omitted, promptSubnet is called to resolve it interactively. */
  subnet?: number;
  natAdapterAlias: string;
  homedir: string;
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Resolves an already-validated subnet octet, e.g. via an interactive retry-on-invalid prompt. Not called when `subnet` or an existing switch make prompting unnecessary. */
  promptSubnet: (taken: TakenRange[], defaultN: number) => Promise<number>;
}

export interface CreateHostNetworkResult {
  hostIp: string;
  /** True when an existing switch's firewall rules were refreshed rather than a new switch/IP being created. */
  refreshedOnly: boolean;
}

export async function createHostNetwork(opts: CreateHostNetworkOptions): Promise<CreateHostNetworkResult> {
  const names = resolveHostNetworkNames(opts.isolationName);
  const interfaces = opts.networkInterfaces ?? osNetworkInterfaces();

  const switchResult = await opts.exec.run(buildGetVmSwitchCommand(names.switchName));
  const switchExists = parseVmSwitchExists(switchResult.stdout);

  const natIp = resolveForwardListenAddress(opts.natAdapterAlias, interfaces);
  if (!natIp) {
    throw new HostNetworkError(`No IPv4 address found on NAT adapter '${opts.natAdapterAlias}'.`);
  }

  const nodePath = getDedicatedNodePath(opts.homedir);

  let hostIp: string;
  let refreshedOnly: boolean;

  if (switchExists) {
    const existingIp = resolveForwardListenAddress(names.adapterAlias, interfaces);
    if (!existingIp) {
      throw new HostNetworkError(
        `Switch '${names.switchName}' exists but has no IPv4 address assigned. ` +
          `Run 'susentorno delete-host-network' and retry.`,
      );
    }
    hostIp = existingIp;
    refreshedOnly = true;
  } else {
    const takenRanges = detectTakenRanges(interfaces);
    let n: number;
    if (opts.subnet !== undefined) {
      validateSubnet(opts.subnet, takenRanges);
      n = opts.subnet;
    } else {
      const freeDefault = findFreeSubnet(takenRanges);
      if (freeDefault === null) {
        throw new HostNetworkError('No free 192.168.n.0/24 subnet was found on this host.');
      }
      n = await opts.promptSubnet(takenRanges, freeDefault);
    }
    hostIp = `192.168.${n}.1`;

    await runMutation(opts.exec, buildNewVmSwitchCommand(names.switchName));
    await runMutation(opts.exec, buildNewNetIpAddressCommand(names.adapterAlias, hostIp));
    refreshedOnly = false;
  }

  await opts.exec.run(
    buildRemoveRulesByNameCommand([names.envoyRuleName, names.dnsRuleName, names.dhcpRuleName, names.smbRuleName]),
  );
  await opts.exec.run(buildRemoveStaleQueryUserRulesCommand(nodePath));

  await runMutation(opts.exec, buildCreateEnvoyRuleCommand(names.envoyRuleName, names.adapterAlias, hostIp, nodePath));
  await runMutation(opts.exec, buildCreateDnsRuleCommand(names.dnsRuleName, names.adapterAlias, hostIp, nodePath));
  await runMutation(opts.exec, buildCreateDhcpRuleCommand(names.dhcpRuleName, names.adapterAlias, nodePath));
  await runMutation(opts.exec, buildCreateSmbRuleCommand(names.smbRuleName, names.adapterAlias, hostIp));
  await runMutation(opts.exec, buildCreateSmbRuleCommand(names.smbRuleName, opts.natAdapterAlias, natIp));

  return { hostIp, refreshedOnly };
}
```

`findFreeSubnet` is called here (not left to Task 9's `promptSubnet`) so the suggested default is always the real lowest-free `n`, and so the "every `n` is taken" failure is caught before any prompt happens at all — `promptSubnet` (Task 9) only ever receives a real, valid default to offer.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/createHostNetwork.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/createHostNetwork.ts tests/unit/hostNetwork/createHostNetwork.test.ts
git commit -m "feat(hostNetwork): add createHostNetwork orchestration"
```

---

## Task 8: `deleteHostNetwork.ts` — delete orchestration

**Files:**

- Create: `src/hostNetwork/deleteHostNetwork.ts`
- Test: `tests/unit/hostNetwork/deleteHostNetwork.test.ts`

**Interfaces:**

- Consumes: `resolveHostNetworkNames` (Task 3), `buildGetVmNetworkAdaptersOnSwitchCommand`/`parseAttachedVms`/`buildRemoveVmSwitchCommand` (Task 5), `buildGetVmSwitchCommand`/`parseVmSwitchExists` (`src/guestSetup/hyperVQueries.ts`), `buildRemoveRulesByInterfaceCommand`/`buildRemoveStaleQueryUserRulesCommand`/`buildRemoveRulesByNameCommand`/`parseCount` (Task 6), `HostNetworkError`/`runMutation` (Task 2), `getDedicatedNodePath` (`src/runHosting/relaunchViaDedicatedNode.ts`).
- Produces:
  ```typescript
  export interface DeleteHostNetworkOptions {
    exec: PowerShellExec;
    isolationName?: string;
    homedir: string;
  }
  export interface DeleteHostNetworkResult {
    interfaceSweepCount: number;
    queryUserSweepCount: number;
    namedSweepCount: number;
    switchRemoved: boolean;
  }
  export async function deleteHostNetwork(opts: DeleteHostNetworkOptions): Promise<DeleteHostNetworkResult>;
  ```
  Task 10 (`src/commands/deleteHostNetwork.ts`) is the only caller. It formats `DeleteHostNetworkResult` into the printed summary line.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/hostNetwork/deleteHostNetwork.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkError';
import { deleteHostNetwork } from '../../../src/hostNetwork/deleteHostNetwork';

const HOMEDIR = 'C:\\Users\\me';

function queuedExec(responses: Array<{ exitCode: number; stdout: string }>): {
  exec: PowerShellExec;
  calls: string[];
} {
  const calls: string[] = [];
  const queue = [...responses];
  return {
    exec: {
      async run(command: string) {
        calls.push(command);
        return queue.shift() ?? { exitCode: 0, stdout: '' };
      },
    },
    calls,
  };
}

describe('deleteHostNetwork', () => {
  it('sweeps rules and removes the switch when everything is present', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' }, // attached-VM check: none
      { exitCode: 0, stdout: '2' }, // interface sweep: 2 removed
      { exitCode: 0, stdout: '1' }, // Query User sweep: 1 removed
      { exitCode: 0, stdout: '1' }, // named SMB sweep: 1 removed
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' }, // Get-VMSwitch: found
      { exitCode: 0, stdout: '' }, // Remove-VMSwitch
    ]);

    const result = await deleteHostNetwork({ exec, homedir: HOMEDIR });

    expect(result).toEqual({
      interfaceSweepCount: 2,
      queryUserSweepCount: 1,
      namedSweepCount: 1,
      switchRemoved: true,
    });
    expect(calls[calls.length - 1]).toContain('Remove-VMSwitch');
  });

  it('is a clean no-op on an already-clean host — switch not found is not an error', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' }, // attached-VM check: none
      { exitCode: 0, stdout: '0' }, // interface sweep: nothing found
      { exitCode: 0, stdout: '0' }, // Query User sweep: nothing found
      { exitCode: 0, stdout: '0' }, // named SMB sweep: nothing found
      { exitCode: 0, stdout: '' }, // Get-VMSwitch: not found
    ]);

    const result = await deleteHostNetwork({ exec, homedir: HOMEDIR });

    expect(result).toEqual({
      interfaceSweepCount: 0,
      queryUserSweepCount: 0,
      namedSweepCount: 0,
      switchRemoved: false,
    });
  });

  it('refuses to proceed when a VM is attached to the switch, naming it', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '{"VMName":"my-guest-vm"}' }, // attached-VM check: one VM
    ]);

    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR })).rejects.toThrow('my-guest-vm');
    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR })).rejects.toThrow(HostNetworkError);
    expect(calls.some((c) => c.includes('Remove-NetFirewallRule') || c.includes('Remove-VMSwitch'))).toBe(false);
  });

  it('propagates a Remove-VMSwitch failure as HostNetworkError', async () => {
    const { exec } = queuedExec([
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '{"Name":"susentorno-internal"}' },
      { exitCode: 1, stdout: 'ERROR: switch is in a bad state' },
    ]);

    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR })).rejects.toThrow('switch is in a bad state');
  });

  it('rejects an invalid isolation name before doing anything', async () => {
    const { exec, calls } = queuedExec([]);

    await expect(deleteHostNetwork({ exec, homedir: HOMEDIR, isolationName: '*' })).rejects.toThrow(
      HostNetworkError,
    );
    expect(calls).toHaveLength(0);
  });

  it('derives names for the given isolation name', async () => {
    const { exec, calls } = queuedExec([
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '0' },
      { exitCode: 0, stdout: '' },
    ]);

    await deleteHostNetwork({ exec, homedir: HOMEDIR, isolationName: 'test' });

    expect(calls[0]).toContain("susentorno-test-internal");
    expect(calls[3]).toContain('susentorno-test share (VM inbound)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/hostNetwork/deleteHostNetwork.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/hostNetwork/deleteHostNetwork.ts`:

```typescript
import type { PowerShellExec } from '../guestSetup/powerShellExec';
import { buildGetVmSwitchCommand, parseVmSwitchExists } from '../guestSetup/hyperVQueries';
import { getDedicatedNodePath } from '../runHosting/relaunchViaDedicatedNode';
import { HostNetworkError, runMutation } from './hostNetworkError';
import { resolveHostNetworkNames } from './hostNetworkNames';
import {
  buildGetVmNetworkAdaptersOnSwitchCommand,
  parseAttachedVms,
  buildRemoveVmSwitchCommand,
} from './hostNetworkSwitchOps';
import {
  buildRemoveRulesByInterfaceCommand,
  buildRemoveStaleQueryUserRulesCommand,
  buildRemoveRulesByNameCommand,
  parseCount,
} from './hostNetworkFirewallOps';

export interface DeleteHostNetworkOptions {
  exec: PowerShellExec;
  isolationName?: string;
  homedir: string;
}

export interface DeleteHostNetworkResult {
  interfaceSweepCount: number;
  queryUserSweepCount: number;
  namedSweepCount: number;
  switchRemoved: boolean;
}

export async function deleteHostNetwork(opts: DeleteHostNetworkOptions): Promise<DeleteHostNetworkResult> {
  const names = resolveHostNetworkNames(opts.isolationName);

  const attachedResult = await opts.exec.run(buildGetVmNetworkAdaptersOnSwitchCommand(names.switchName));
  const attached = parseAttachedVms(attachedResult.stdout);
  if (attached.length > 0) {
    const vmNames = attached.map((a) => a.vmName).join(', ');
    throw new HostNetworkError(
      `Switch '${names.switchName}' has VM(s) attached: ${vmNames}. Detach or stop them before deleting.`,
    );
  }

  const nodePath = getDedicatedNodePath(opts.homedir);

  const interfaceSweepResult = await opts.exec.run(buildRemoveRulesByInterfaceCommand(names.adapterAlias));
  const interfaceSweepCount = parseCount(interfaceSweepResult.stdout);

  const queryUserResult = await opts.exec.run(buildRemoveStaleQueryUserRulesCommand(nodePath));
  const queryUserSweepCount = parseCount(queryUserResult.stdout);

  const namedSweepResult = await opts.exec.run(buildRemoveRulesByNameCommand([names.smbRuleName]));
  const namedSweepCount = parseCount(namedSweepResult.stdout);

  const switchResult = await opts.exec.run(buildGetVmSwitchCommand(names.switchName));
  const switchExists = parseVmSwitchExists(switchResult.stdout);
  let switchRemoved = false;
  if (switchExists) {
    await runMutation(opts.exec, buildRemoveVmSwitchCommand(names.switchName));
    switchRemoved = true;
  }

  return { interfaceSweepCount, queryUserSweepCount, namedSweepCount, switchRemoved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/hostNetwork/deleteHostNetwork.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add src/hostNetwork/deleteHostNetwork.ts tests/unit/hostNetwork/deleteHostNetwork.test.ts
git commit -m "feat(hostNetwork): add deleteHostNetwork orchestration"
```

---

## Task 9: `src/commands/createHostNetwork.ts` — CLI glue

**Files:**

- Modify: `src/runHosting/forwarder.ts` (promote `DEFAULT_NAT_ADAPTER` to a shared, exported constant)
- Modify: `src/commands/setupGuestUnix.ts:30` (use the promoted constant instead of its own local copy)
- Create: `src/commands/createHostNetwork.ts`
- Modify: `src/cli.ts` (register the new command)
- Test: `tests/unit/commands/createHostNetwork.test.ts` (the `promptSubnet` retry-loop helper only — the rest is thin `commander` glue, consistent with how `setupGuestUnix.ts` itself has no dedicated unit test)

**Interfaces:**

- Consumes: `isElevated` (`src/guestSetup/elevationCheck.ts`), `createRealPowerShellExec` (`src/guestSetup/powerShellExec.ts`), `promptText` (`src/cliPrompt.ts`), `validateSubnet`/`TakenRange` (Task 4), `createHostNetwork`/`CreateHostNetworkResult` (Task 7), `HostNetworkError` (Task 2), `DEFAULT_NAT_ADAPTER` (promoted in this task).
- Produces: `registerCreateHostNetwork(program: Command): void`, called from `src/cli.ts`.

Today, `DEFAULT_NAT_ADAPTER = 'vEthernet (Default Switch)'` is a local, unexported constant inside `src/commands/setupGuestUnix.ts:30`. This command needs the same default, so this task promotes it to `src/runHosting/forwarder.ts` (alongside the existing `DEFAULT_INTERNAL_SWITCH_ADAPTER`) and updates `setupGuestUnix.ts` to import it from there instead of defining its own copy — a single source of truth for both adapter-alias defaults, matching how `DEFAULT_INTERNAL_SWITCH_ADAPTER` already lives there.

- [ ] **Step 1: Promote `DEFAULT_NAT_ADAPTER`**

In `src/runHosting/forwarder.ts`, add the export right after the existing `DEFAULT_INTERNAL_SWITCH_ADAPTER`:

```typescript
export const DEFAULT_INTERNAL_SWITCH_ADAPTER = 'vEthernet (susentorno-internal)';
export const DEFAULT_NAT_ADAPTER = 'vEthernet (Default Switch)';
```

In `src/commands/setupGuestUnix.ts`, remove the local constant and import the shared one instead:

```typescript
// Remove this line:
// const DEFAULT_NAT_ADAPTER = 'vEthernet (Default Switch)';

// Add DEFAULT_NAT_ADAPTER to the existing forwarder import:
import {
  resolveForwardListenAddress,
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
  DEFAULT_NAT_ADAPTER,
} from '../runHosting/forwarder';
```

- [ ] **Step 2: Run the existing suite to confirm nothing broke**

Run: `pnpm vitest run tests/unit/`
Expected: PASS (unchanged count — this is a pure rename/relocation)

- [ ] **Step 3: Write the failing test for the prompt retry loop**

Create `tests/unit/commands/createHostNetwork.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promptSubnetForCreateHostNetwork } from '../../../src/commands/createHostNetwork';

vi.mock('../../../src/cliPrompt', () => ({
  promptText: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('promptSubnetForCreateHostNetwork', () => {
  it('returns the first valid answer', async () => {
    const { promptText } = await import('../../../src/cliPrompt');
    vi.mocked(promptText).mockResolvedValueOnce('67');

    const n = await promptSubnetForCreateHostNetwork([], 0);

    expect(n).toBe(67);
    expect(promptText).toHaveBeenCalledWith('Subnet (192.168.<n>.x)', '0');
  });

  it('re-prompts after an invalid answer, printing why', async () => {
    const { promptText } = await import('../../../src/cliPrompt');
    vi.mocked(promptText).mockResolvedValueOnce('300').mockResolvedValueOnce('67');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const n = await promptSubnetForCreateHostNetwork([], 0);

    expect(n).toBe(67);
    expect(promptText).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('create-host-network:'));
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/commands/createHostNetwork.test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Write the implementation**

Create `src/commands/createHostNetwork.ts`:

```typescript
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import { isElevated } from '../guestSetup/elevationCheck';
import { promptText } from '../cliPrompt';
import { DEFAULT_NAT_ADAPTER } from '../runHosting/forwarder';
import { validateSubnet, type TakenRange } from '../hostNetwork/subnetSelection';
import { createHostNetwork } from '../hostNetwork/createHostNetwork';
import { HostNetworkError } from '../hostNetwork/hostNetworkError';

interface CreateHostNetworkCommandOptions {
  isolationName?: string;
  subnet?: number;
  natAdapterAlias: string;
}

/** Retries until a valid, free subnet octet is given — exported for its own unit test. */
export async function promptSubnetForCreateHostNetwork(taken: TakenRange[], defaultN: number): Promise<number> {
  for (;;) {
    const answer = await promptText('Subnet (192.168.<n>.x)', String(defaultN));
    const n = Number(answer);
    try {
      validateSubnet(n, taken);
      return n;
    } catch (error) {
      console.error(`create-host-network: ${(error as Error).message}`);
    }
  }
}

export function registerCreateHostNetwork(program: Command): void {
  program
    .command('create-host-network')
    .description(
      'Create the Hyper-V Internal switch, assign it a static host IP, and open the host firewall for VM ' +
        'traffic. Requires an elevated (Administrator) PowerShell/terminal. Safe to rerun against an existing ' +
        "switch — refreshes its firewall rules only, without recreating the switch or weakening any rule's scoping.",
    )
    .option(
      '--isolation-name <name>',
      'Suffix distinguishing this host network from the default (letters, digits, hyphens only) — for test sandboxing',
    )
    .option(
      '--subnet <n>',
      'Third octet of the 192.168.<n>.x subnet to use, skipping the interactive prompt',
      (v: string) => Number(v),
    )
    .option(
      '--nat-adapter-alias <alias>',
      "Default-Switch (NAT) adapter, needed for the SMB rule's NAT-side half",
      DEFAULT_NAT_ADAPTER,
    )
    .action(async (options: CreateHostNetworkCommandOptions) => {
      const exec = createRealPowerShellExec();
      if (!(await isElevated(exec))) {
        console.error(
          'create-host-network: this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
        );
        process.exitCode = 1;
        return;
      }

      if (options.subnet !== undefined && !Number.isInteger(options.subnet)) {
        console.error(`create-host-network: --subnet '${String(options.subnet)}' is not a valid integer.`);
        process.exitCode = 1;
        return;
      }

      try {
        const result = await createHostNetwork({
          exec,
          isolationName: options.isolationName,
          subnet: options.subnet,
          natAdapterAlias: options.natAdapterAlias,
          homedir: homedir(),
          promptSubnet: promptSubnetForCreateHostNetwork,
        });

        if (result.refreshedOnly) {
          if (options.subnet !== undefined) {
            console.log(
              'create-host-network: switch already exists — the --subnet value was ignored (it only applies when creating a new switch).',
            );
          }
          console.log(
            `create-host-network: switch already existed at ${result.hostIp} — refreshed its firewall rules only.`,
          );
        } else {
          console.log(`create-host-network: created the host network at ${result.hostIp}.`);
          console.log(`  Use ${result.hostIp} as the host IP in guest setup (see setup-guest.md).`);
        }
      } catch (error) {
        if (error instanceof HostNetworkError) {
          console.error(`create-host-network: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}
```

- [ ] **Step 6: Register the command**

In `src/cli.ts`, add the import and registration call alongside the existing ones:

```typescript
import { registerCreateHostNetwork } from './commands/createHostNetwork';
// ... existing imports unchanged

registerCreateHostNetwork(program);
// ... existing registrations unchanged
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/commands/createHostNetwork.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Typecheck, lint, format, build, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format && pnpm build
git add src/runHosting/forwarder.ts src/commands/setupGuestUnix.ts src/commands/createHostNetwork.ts src/cli.ts tests/unit/commands/createHostNetwork.test.ts
git commit -m "feat(cli): add create-host-network command"
```

- [ ] **Step 9: Manual verification against real Hyper-V**

From your elevated terminal (Task 1):

```powershell
node dist/cli.js create-host-network --isolation-name plancheck --subnet 250
```

Expected: prints `create-host-network: created the host network at 192.168.250.1.` Confirm with:

```powershell
Get-VMSwitch -Name 'susentorno-plancheck-internal'
Get-NetFirewallRule -DisplayName 'susentorno-plancheck*' | Select-Object DisplayName, Enabled
```

Expected: the switch exists, and four enabled rules are listed. Rerun the same command:

```powershell
node dist/cli.js create-host-network --isolation-name plancheck --subnet 250
```

Expected: prints `create-host-network: switch already existed at 192.168.250.1 — refreshed its firewall rules only.` — no error, no duplicate rules (`(Get-NetFirewallRule -DisplayName 'susentorno-plancheck*').Count` should still be 4). Leave this switch in place — Task 10's manual verification cleans it up via `delete-host-network`.

---

## Task 10: `src/commands/deleteHostNetwork.ts` — CLI glue

**Files:**

- Create: `src/commands/deleteHostNetwork.ts`
- Modify: `src/cli.ts` (register the new command)

**Interfaces:**

- Consumes: `isElevated` (`src/guestSetup/elevationCheck.ts`), `createRealPowerShellExec` (`src/guestSetup/powerShellExec.ts`), `deleteHostNetwork`/`DeleteHostNetworkResult` (Task 8), `HostNetworkError` (Task 2).
- Produces: `registerDeleteHostNetwork(program: Command): void`, called from `src/cli.ts`.

No dedicated unit test for this file — it is thin `commander` glue with no branching logic of its own to unit-test in isolation, the same as `deleteHostNetwork`'s sibling command files (`registerInit`, `registerRunHosting` etc.) have none. Its correctness is exercised by Task 12's real `host-network` integration test and the manual verification below.

- [ ] **Step 1: Write the implementation**

Create `src/commands/deleteHostNetwork.ts`:

```typescript
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import { isElevated } from '../guestSetup/elevationCheck';
import { deleteHostNetwork } from '../hostNetwork/deleteHostNetwork';
import { HostNetworkError } from '../hostNetwork/hostNetworkError';

interface DeleteHostNetworkCommandOptions {
  isolationName?: string;
}

export function registerDeleteHostNetwork(program: Command): void {
  program
    .command('delete-host-network')
    .description(
      "Return the host network to a pristine state: remove every firewall rule scoped to the Internal switch's " +
        "adapter (regardless of who created it), remove the SMB rule's Default-Switch/NAT-adapter half, and " +
        'remove the switch itself. Requires an elevated (Administrator) PowerShell/terminal. Safe to rerun ' +
        'against an already-clean or partially-broken host.',
    )
    .option(
      '--isolation-name <name>',
      'Suffix identifying which host network to delete (letters, digits, hyphens only) — for test sandboxing',
    )
    .action(async (options: DeleteHostNetworkCommandOptions) => {
      const exec = createRealPowerShellExec();
      if (!(await isElevated(exec))) {
        console.error(
          'delete-host-network: this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
        );
        process.exitCode = 1;
        return;
      }

      try {
        const result = await deleteHostNetwork({
          exec,
          isolationName: options.isolationName,
          homedir: homedir(),
        });

        const ruleTotal = result.interfaceSweepCount + result.queryUserSweepCount + result.namedSweepCount;
        console.log(
          `delete-host-network: removed ${ruleTotal} firewall rule(s) ` +
            `(${result.interfaceSweepCount} interface-scoped, ${result.queryUserSweepCount} stale Query User, ` +
            `${result.namedSweepCount} named SMB); switch ${result.switchRemoved ? 'removed' : 'not found'}.`,
        );
      } catch (error) {
        if (error instanceof HostNetworkError) {
          console.error(`delete-host-network: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}
```

- [ ] **Step 2: Register the command**

In `src/cli.ts`, add the import and registration call:

```typescript
import { registerDeleteHostNetwork } from './commands/deleteHostNetwork';
// ... existing imports unchanged

registerDeleteHostNetwork(program);
// ... existing registrations unchanged
```

- [ ] **Step 3: Typecheck, lint, format, build, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format && pnpm build
git add src/commands/deleteHostNetwork.ts src/cli.ts
git commit -m "feat(cli): add delete-host-network command"
```

- [ ] **Step 4: Manual verification against real Hyper-V**

Using the `susentorno-plancheck-internal` switch left over from Task 9:

```powershell
node dist/cli.js delete-host-network --isolation-name plancheck
```

Expected: prints a summary like `delete-host-network: removed 5 firewall rule(s) (4 interface-scoped, 0 stale Query User, 1 named SMB); switch removed.` Confirm cleanup:

```powershell
Get-VMSwitch -Name 'susentorno-plancheck-internal' -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'susentorno-plancheck*' -ErrorAction SilentlyContinue
```

Expected: both return nothing. Rerun the same `delete-host-network` command again:

```powershell
node dist/cli.js delete-host-network --isolation-name plancheck
```

Expected: prints `delete-host-network: removed 0 firewall rule(s) (0 interface-scoped, 0 stale Query User, 0 named SMB); switch not found.` — exits 0, not an error.

---

## Task 11: New `host-network` test tier scaffolding

**Files:**

- Create: `tests/host-network/checkElevated.ts`
- Create: `tests/host-network/globalSetup.ts`
- Create: `vitest.host-network.config.ts`
- Modify: `package.json` (add `test:host-network`, wire it into the `test` pipeline)
- Modify: `testing.md` (new tier row, prerequisites row, exception note)
- Modify: `development.md` (new pipeline step)

**Interfaces:**

- Consumes: `isElevated`/`buildElevationCheckCommand` (`src/guestSetup/elevationCheck.ts`), `createRealPowerShellExec` (`src/guestSetup/powerShellExec.ts`).
- Produces: `checkElevated(): Promise<void>` (throws with a clear message if not elevated) — consumed by `globalSetup.ts`, and reusable by Task 12's test file if it wants an explicit assertion.

This task only scaffolds the tier (config, fail-fast gate, pipeline wiring, docs); Task 12 adds the actual test file.

- [ ] **Step 1: Write `checkElevated.ts`**

Create `tests/host-network/checkElevated.ts`, mirroring `tests/checkDockerRunning.ts`'s "fail fast with a message that names the fix" shape:

```typescript
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { isElevated } from '../../src/guestSetup/elevationCheck';

/**
 * Guard: every test in this tier creates/deletes real Hyper-V switches and
 * firewall rules, which requires an elevated process token. Check up front
 * and fail fast with a message that names the fix, rather than letting the
 * first `create-host-network` call fail deep inside a test.
 */
export async function checkElevated(): Promise<void> {
  const exec = createRealPowerShellExec();
  if (!(await isElevated(exec))) {
    throw new Error(
      'This terminal is not elevated (Administrator). The host-network tier creates and deletes real Hyper-V ' +
        'switches and firewall rules, which requires it. Re-run from an Administrator PowerShell/terminal.',
    );
  }
}
```

- [ ] **Step 2: Write `globalSetup.ts`**

Create `tests/host-network/globalSetup.ts`:

```typescript
import { checkElevated } from './checkElevated';

export default async function setup() {
  await checkElevated();
}
```

- [ ] **Step 3: Write the vitest config**

Create `vitest.host-network.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/host-network/**/*.test.ts'],
    globalSetup: ['tests/host-network/globalSetup.ts'],
    testTimeout: 30000,
    // Every test in this tier creates/deletes the same fixed
    // susentorno-test-internal switch and its firewall rules — shared,
    // non-namespaced host state, so files must not run concurrently.
    // Matches vitest.proxy-stack.config.ts/vitest.guest.config.ts's existing
    // precedent for tiers with the same constraint.
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Wire the new tier into `package.json`**

In `package.json`'s `scripts`, add `test:host-network` and insert it into the `test` pipeline right after `test:cli` (matching `development.md`'s existing step order — `host-network` needs the same `pnpm build` step 5 already ran, and running it before `test:proxy-stack`/`test:guest` keeps the fastest live-prerequisite check earliest):

```json
"test:cli": "vitest run --config vitest.cli.config.ts",
"test:host-network": "vitest run --config vitest.host-network.config.ts",
"test:proxy-stack": "vitest run --config vitest.proxy-stack.config.ts",
"test:guest": "pnpm build && vitest run --config vitest.guest.config.ts",
"test": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli && pnpm test:host-network && pnpm test:proxy-stack && pnpm test:guest",
```

- [ ] **Step 5: Update `testing.md`**

In the tier table near the top, add a row after `cli`:

```markdown
| `host-network` | `pnpm test:host-network` | `tests/host-network/` | `vitest.host-network.config.ts` | Real Hyper-V switch/firewall state created and torn down by `create-host-network`/`delete-host-network` |
```

In "What each tier exercises," add a paragraph after the `cli` one:

```markdown
- **`host-network`** tests run `create-host-network`/`delete-host-network` against real Hyper-V and real Windows Firewall state — not mocked — always scoped to `--isolation-name test` so they never touch a developer's real `susentorno-internal` switch. This is a deliberate, narrow exception to the "avoid creating new tiers" guidance below and to [ADR-0010](docs/adr/0010-vm-tests-via-qemu-in-wsl2.md)'s "Hyper-V is not the test runtime" stance — see [ADR-0023](docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md) for why this specific surface is safe to test for real where guest-boot behavior isn't.
```

In the "Prerequisites per tier" table, add a row:

```markdown
| `host-network` | An elevated (Administrator) PowerShell/terminal. No Docker/WSL2 required. |
```

- [ ] **Step 6: Update `development.md`**

In the Verification pipeline table, insert a new row 6 (renumbering the rest) right after `test:cli`:

```markdown
| 6 | `pnpm test:host-network` | Real Hyper-V/firewall state created and torn down by `create-host-network`/`delete-host-network` (requires an elevated terminal) |
```

- [ ] **Step 7: Run the new tier to confirm it starts cleanly**

Run: `pnpm test:host-network`
Expected: passes with 0 tests found (Task 12 adds the first real test) — confirms the elevation gate and config wiring work. If you get "This terminal is not elevated," your terminal for this session isn't the Administrator one from Task 1 — reopen an elevated terminal and retry from here.

- [ ] **Step 8: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/host-network/checkElevated.ts tests/host-network/globalSetup.ts vitest.host-network.config.ts package.json testing.md development.md
git commit -m "test(host-network): scaffold the new real-Hyper-V test tier"
```

---

## Task 12: Real `host-network` integration test

**Files:**

- Create: `tests/host-network/queryFirewallRuleFilters.ts`
- Create: `tests/host-network/createDeleteHostNetwork.test.ts`

**Interfaces:**

- Consumes: `createHostNetwork` (Task 7), `deleteHostNetwork` (Task 8), `detectTakenRanges`/`findFreeSubnet` (Task 4), `buildGetVmSwitchCommand`/`parseVmSwitchExists` (`src/guestSetup/hyperVQueries.ts`), `createRealPowerShellExec` (`src/guestSetup/powerShellExec.ts`), `quoteForPowerShell` (`src/guestSetup/quoteForPowerShell.ts`).
- Produces: `queryRuleFilters(exec, displayNamePattern): Promise<RuleFilterSnapshot[]>` — used only by this test file; no other task depends on it.

This is the one test file in this plan that exercises real Hyper-V/Windows Firewall state, per [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md). Its filter-level assertions mirror `templates/proxy/verify-proxy.ps1`'s existing `Test-RuleTuple` pattern (protocol, port, interface, address, program, enabled/direction/action) — a shallower "the rule exists" check would not actually substantiate that ADR's coverage claim.

- [ ] **Step 1: Write the rule-filter query helper**

Create `tests/host-network/queryFirewallRuleFilters.ts`:

```typescript
import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';

export interface RuleFilterSnapshot {
  displayName: string;
  protocol: string;
  localPort: string;
  interfaceAlias: string;
  localAddress: string;
  program: string;
  enabled: boolean;
  direction: string;
  action: string;
}

/**
 * Mirrors templates/proxy/verify-proxy.ps1's Test-RuleTuple: a rule's
 * DisplayName alone says nothing about its actual port/address/interface/
 * program scoping, so this reads every filter object a real assertion needs.
 */
export function buildQueryRuleFiltersCommand(displayNamePattern: string): string {
  return (
    `Get-NetFirewallRule -DisplayName ${quoteForPowerShell(displayNamePattern)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { ` +
    `$portFilter = $_ | Get-NetFirewallPortFilter; $addrFilter = $_ | Get-NetFirewallAddressFilter; ` +
    `$ifFilter = $_ | Get-NetFirewallInterfaceFilter; $appFilter = $_ | Get-NetFirewallApplicationFilter; ` +
    `[PSCustomObject]@{ DisplayName = $_.DisplayName; Protocol = $portFilter.Protocol; ` +
    `LocalPort = ($portFilter.LocalPort -join ','); InterfaceAlias = $ifFilter.InterfaceAlias; ` +
    `LocalAddress = $addrFilter.LocalAddress; Program = $appFilter.Program; ` +
    `Enabled = $_.Enabled.ToString(); Direction = $_.Direction.ToString(); Action = $_.Action.ToString() ` +
    `} } | ConvertTo-Json -Compress`
  );
}

interface RawFilterSnapshot {
  DisplayName?: unknown;
  Protocol?: unknown;
  LocalPort?: unknown;
  InterfaceAlias?: unknown;
  LocalAddress?: unknown;
  Program?: unknown;
  Enabled?: unknown;
  Direction?: unknown;
  Action?: unknown;
}

export function parseRuleFilterSnapshots(stdout: string): RuleFilterSnapshot[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawFilterSnapshot[];
  return list.map((r) => ({
    displayName: String(r.DisplayName ?? ''),
    protocol: String(r.Protocol ?? ''),
    localPort: String(r.LocalPort ?? ''),
    interfaceAlias: String(r.InterfaceAlias ?? ''),
    localAddress: String(r.LocalAddress ?? ''),
    program: String(r.Program ?? ''),
    enabled: String(r.Enabled ?? '') === 'True',
    direction: String(r.Direction ?? ''),
    action: String(r.Action ?? ''),
  }));
}

export async function queryRuleFilters(
  exec: PowerShellExec,
  displayNamePattern: string,
): Promise<RuleFilterSnapshot[]> {
  const result = await exec.run(buildQueryRuleFiltersCommand(displayNamePattern));
  return parseRuleFilterSnapshots(result.stdout);
}
```

- [ ] **Step 2: Write the real integration test**

Create `tests/host-network/createDeleteHostNetwork.test.ts`:

```typescript
import { homedir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { createHostNetwork } from '../../src/hostNetwork/createHostNetwork';
import { deleteHostNetwork } from '../../src/hostNetwork/deleteHostNetwork';
import { detectTakenRanges, findFreeSubnet } from '../../src/hostNetwork/subnetSelection';
import { buildGetVmSwitchCommand, parseVmSwitchExists } from '../../src/guestSetup/hyperVQueries';
import { queryRuleFilters } from './queryFirewallRuleFilters';

const ISOLATION_NAME = 'test';
const NAT_ADAPTER_ALIAS = 'vEthernet (Default Switch)';
const exec = createRealPowerShellExec();

function failIfPrompted(): Promise<never> {
  return Promise.reject(new Error('should not be prompted on the refresh path'));
}

async function cleanUp(): Promise<void> {
  await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() });
}

beforeEach(cleanUp);
afterEach(cleanUp);

describe('create-host-network / delete-host-network against real Hyper-V', () => {
  it('creates a switch, IP, and correctly-scoped firewall rules', async () => {
    const subnet = findFreeSubnet(detectTakenRanges());
    expect(subnet).not.toBeNull();

    const result = await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet: subnet!,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet!,
    });

    expect(result).toEqual({ hostIp: `192.168.${subnet}.1`, refreshedOnly: false });

    const switchResult = await exec.run(buildGetVmSwitchCommand('susentorno-test-internal'));
    expect(parseVmSwitchExists(switchResult.stdout)).toBe(true);

    const envoyRules = await queryRuleFilters(exec, 'susentorno-test Envoy Proxy (VM inbound)');
    expect(envoyRules).toHaveLength(1);
    expect(envoyRules[0]).toMatchObject({
      protocol: 'TCP',
      localPort: '80,443',
      interfaceAlias: 'vEthernet (susentorno-test-internal)',
      localAddress: result.hostIp,
      enabled: true,
      direction: 'Inbound',
      action: 'Allow',
    });
    expect(envoyRules[0].program).toContain('node-copy-with-custom-firewall-rules.exe');

    const dhcpRules = await queryRuleFilters(exec, 'susentorno-test DHCP (VM inbound)');
    expect(dhcpRules).toHaveLength(1);
    expect(dhcpRules[0].localAddress).toBe('Any');

    const smbRules = await queryRuleFilters(exec, 'susentorno-test share (VM inbound)');
    expect(smbRules).toHaveLength(2);
    expect(smbRules.map((r) => r.interfaceAlias).sort()).toEqual(
      [NAT_ADAPTER_ALIAS, 'vEthernet (susentorno-test-internal)'].sort(),
    );
  });

  it('refreshes rules without recreating the switch or duplicating rules on a rerun', async () => {
    const subnet = findFreeSubnet(detectTakenRanges())!;
    const first = await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet,
    });
    expect(first.refreshedOnly).toBe(false);

    const second = await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: failIfPrompted,
    });

    expect(second).toEqual({ hostIp: first.hostIp, refreshedOnly: true });
    const envoyRules = await queryRuleFilters(exec, 'susentorno-test Envoy Proxy (VM inbound)');
    expect(envoyRules).toHaveLength(1);
  });

  it('delete removes the switch and every associated rule, and is idempotent on rerun', async () => {
    const subnet = findFreeSubnet(detectTakenRanges())!;
    await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet,
    });

    const result = await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() });
    expect(result.switchRemoved).toBe(true);
    expect(result.interfaceSweepCount).toBeGreaterThan(0);
    expect(result.namedSweepCount).toBeGreaterThan(0);

    const switchResult = await exec.run(buildGetVmSwitchCommand('susentorno-test-internal'));
    expect(parseVmSwitchExists(switchResult.stdout)).toBe(false);
    expect(await queryRuleFilters(exec, 'susentorno-test Envoy Proxy (VM inbound)')).toHaveLength(0);
    expect(await queryRuleFilters(exec, 'susentorno-test share (VM inbound)')).toHaveLength(0);

    const rerun = await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() });
    expect(rerun).toEqual({
      interfaceSweepCount: 0,
      queryUserSweepCount: 0,
      namedSweepCount: 0,
      switchRemoved: false,
    });
  });
});
```

- [ ] **Step 3: Run the real tier**

From your elevated terminal:

```bash
pnpm test:host-network
```

Expected: PASS (3 tests). This makes real calls to `New-VMSwitch`/`New-NetIPAddress`/`New-NetFirewallRule`/`Remove-VMSwitch` against `susentorno-test-internal` — if it fails partway through, rerun `node dist/cli.js delete-host-network --isolation-name test` manually to clean up before investigating (the `beforeEach`/`afterEach` cleanup only runs between tests within a passing suite).

- [ ] **Step 4: Typecheck, lint, format, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/host-network/queryFirewallRuleFilters.ts tests/host-network/createDeleteHostNetwork.test.ts
git commit -m "test(host-network): add real create/delete integration test"
```

---

## Task 13: Remove `host-allow-vm-inbound.ps1` and its references

**Files:**

- Delete: `templates/proxy/host-allow-vm-inbound.ps1`
- Modify: `tests/unit/templates.test.ts:19-44,96-111`
- Modify: `tests/unit/initEnv.test.ts:48-68`
- Modify: `src/commands/init.ts`

No separate code change is needed to stop shipping this file: `initEnvironment()` (`src/initEnv.ts`) copies the entire `templates/proxy` directory in one `cpSync` call, not file-by-file, so deleting the template is sufficient on its own.

- [ ] **Step 1: Delete the template**

```bash
rm templates/proxy/host-allow-vm-inbound.ps1
```

- [ ] **Step 2: Update `tests/unit/templates.test.ts`**

Remove line 30 (`'proxy/host-allow-vm-inbound.ps1',`) from the `expectedTemplateFiles` array.

Remove the entire first test inside the `describe('host firewall templates', ...)` block (lines 97-111 — `it('host-allow-vm-inbound scopes rules by LocalAddress, splits SMB/node.exe, and drops node discovery', ...)`), keeping the `verify-proxy checks the host network model...` test that follows it unchanged, since `verify-proxy.ps1` still ships.

- [ ] **Step 3: Update `tests/unit/initEnv.test.ts`**

Remove line 56 (`'proxy/host-allow-vm-inbound.ps1',`) from the list of files asserted present after `initEnvironment()`.

- [ ] **Step 4: Update `src/commands/init.ts`**

Remove this `console.log` call (immediately after the `susentorno run-hosting` next-step line):

```typescript
console.log(
  `  (Windows) admin PowerShell: powershell -File ${ENV_DIR_NAME}/proxy/host-allow-vm-inbound.ps1`,
);
```

The step numbering above it (`1. susentorno generate-ca`, `2. susentorno write-github-config`, `3. susentorno run-hosting`) is unchanged — this printed line was never a numbered step, so nothing needs renumbering.

- [ ] **Step 5: Run the unit tier to confirm**

Run: `pnpm vitest run tests/unit/templates.test.ts tests/unit/initEnv.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck, lint, format, build, commit**

```bash
pnpm typecheck && pnpm lint && pnpm format && pnpm build
git add templates/proxy/host-allow-vm-inbound.ps1 tests/unit/templates.test.ts tests/unit/initEnv.test.ts src/commands/init.ts
git commit -m "chore: remove host-allow-vm-inbound.ps1, superseded by create-host-network"
```

---

## Task 14: Update `verify-proxy.ps1` references

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1`

Four spots name `host-allow-vm-inbound.ps1` directly; each becomes `susentorno create-host-network`. The rule-matching logic itself (exact `DisplayName`s) is unchanged, since `create-host-network` preserves them by default.

- [ ] **Step 1: Update the header comment block (around lines 17-25)**

Change:

```
-AdapterAlias defaults to the Hyper-V Internal-switch NIC "vEthernet
(susentorno-internal)"; pass a different alias if your switch is named
differently, matching host-allow-vm-inbound.ps1, e.g.:
```

to:

```
-AdapterAlias defaults to the Hyper-V Internal-switch NIC "vEthernet
(susentorno-internal)"; pass a different alias if your switch is named
differently, matching susentorno create-host-network, e.g.:
```

and change:

```
-NatAdapterAlias defaults to "vEthernet (Default Switch)", matching
host-allow-vm-inbound.ps1 - it's used only to check the second half of the
SMB share rule.
```

to:

```
-NatAdapterAlias defaults to "vEthernet (Default Switch)", matching
susentorno create-host-network - it's used only to check the second half of
the SMB share rule.
```

- [ ] **Step 2: Update the missing-rule-set warning (around line 127)**

Change:

```powershell
Add-Warn "$Label rule(s) present" "not found -- run host-allow-vm-inbound.ps1 (as admin)"
```

to:

```powershell
Add-Warn "$Label rule(s) present" "not found -- run 'susentorno create-host-network' (as admin)"
```

- [ ] **Step 3: Update the stale Query User rule message (around line 364)**

Change:

```powershell
else { Add-Fail 'no stale Query User rule for the dedicated node-copy-with-custom-firewall-rules.exe' "$($rule.Action) rule '$($rule.Name)' -- rerun host-allow-vm-inbound.ps1, or investigate why Windows re-prompted" }
```

to:

```powershell
else { Add-Fail 'no stale Query User rule for the dedicated node-copy-with-custom-firewall-rules.exe' "$($rule.Action) rule '$($rule.Name)' -- rerun 'susentorno create-host-network', or investigate why Windows re-prompted" }
```

- [ ] **Step 4: Confirm the unit test covering this file still passes**

Run: `pnpm vitest run tests/unit/templates.test.ts -t "verify-proxy checks"`
Expected: PASS — this test only asserts on `Get-NetIPInterface`/`WeakHostReceive`/`Forwarding`/`EndsWith($dedicatedNodePath` substrings, none of which this task touches.

- [ ] **Step 5: Lint (PowerShell) and commit**

```bash
pnpm lint:ps1
git add templates/proxy/verify-proxy.ps1
git commit -m "docs(verify-proxy): point at create-host-network instead of the removed script"
```

---

## Task 15: Final documentation sweep

**Files:**

- Modify: `setup-machine.md`
- Modify: `setup-environment.md`
- Modify: `setup-guest.md:207-214`
- Modify: `src/guestSetup/powerShellExec.ts` (comment only)

- [ ] **Step 1: Collapse `setup-machine.md` §1-2 into one step**

Replace the entire content from `## 1. Create the Internal switch and assign the host IP` through the end of `## 2. Open the host firewall for the proxy` (everything between the top intro paragraph and the next `##` heading, if any — this doc currently ends after §2) with:

```markdown
## 1. Create the host network

The isolated network for guests is a Hyper-V **Internal virtual switch** (host + VMs, no internet). `susentorno run-hosting` supplies DHCP and DNS on it. The host IP is the one value that threads through the entire setup:

> **One host IP, used everywhere:** the static IPv4 assigned to the host's `vEthernet (susentorno-internal)` adapter is simultaneously the SMB server address, the `run-hosting --forward-listen` target, and the `<host-ip>` argument to the guest's `05-*` network scripts. This stays the same during guest setup (when network access is direct to the internet) and after the guest is isolated (when traffic must go through the proxy).

> **Two host addresses, only one stable.** The Default Switch address used during a guest's NAT phase is regenerated across host reboots. Look it up with `Get-NetIPAddress -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4` when needed.

In an **Administrator** PowerShell on the host:

```powershell
susentorno create-host-network
```

This creates the Internal switch, assigns it a static host IP, and opens the host firewall (inbound Envoy `80`/`443`, DNS `53`, DHCP `67`, and SMB `445`) for the VM's Internal-switch adapter — replacing what used to be a manual `New-VMSwitch`/`New-NetIPAddress` step plus a separate firewall script. You'll be prompted for the subnet's third octet (`192.168.<n>.x`, with a free default suggested — this doc set's examples assume `192.168.67.x` was chosen, giving a host IP of `192.168.67.1`); pass `--subnet <n>` to skip the prompt. It prints the host IP you need for guest-side setup.

- **Safe to rerun**: against an already-created switch, it refreshes the firewall rules only (useful if the Default Switch's IP ever changes) — it never recreates the switch or weakens any rule's scoping.
- Run `susentorno delete-host-network` first if you want to recreate the network from a clean state (a different subnet, for example) — it also removes any leftover firewall rules on the adapter regardless of who created them, so it doubles as a way to recover from a corrupted setup.
- It runs `run-hosting` from a dedicated private copy of `node.exe` so the firewall's program-scoped rule can't be inherited by any other use of a shared interpreter (see [ADR-0003](docs/adr/0003-transparent-interception-and-network-isolation-boundary.md)).
- This is a one-time, per-host step, done before setting up any environment — later environments don't need to repeat it.
```

- [ ] **Step 2: Remove `setup-environment.md`'s per-environment firewall callout**

Remove this paragraph entirely from the `## Initialize the environment's directory` section:

```markdown
If this is the first environment you've set up on this machine, also open the host firewall now — see [setup-machine.md](setup-machine.md#2-open-the-host-firewall-for-the-proxy). It's generated by step 1 above, but its effect is scoped to the machine's adapter, so later environments don't need to repeat it.
```

- [ ] **Step 3: Remove `setup-environment.md`'s redundant manual SMB firewall block**

In the `## Share the environment folders (read-only)` section, replace:

```markdown
`host-allow-vm-inbound.ps1` (see [setup-machine.md](setup-machine.md)) scopes SMB (TCP 445) to the Internal-switch and Default Switch adapters. It is never exposed on the external NIC.

```powershell
New-NetFirewallRule -DisplayName "susentorno VM share (SMB inbound)" `
    -Direction Inbound -Protocol TCP -LocalPort 445 `
    -InterfaceAlias "vEthernet (susentorno-internal)" -Profile Any -Action Allow
```
```

with:

```markdown
`susentorno create-host-network` (see [setup-machine.md](setup-machine.md)) already scoped SMB (TCP 445) to the Internal-switch and Default Switch adapters when you ran it — no separate firewall rule is needed here. It is never exposed on the external NIC.
```

- [ ] **Step 4: Update `setup-guest.md`'s isolate step**

Change:

```powershell
powershell -File .susentorno\proxy\host-allow-vm-inbound.ps1
susentorno run-hosting
```

to:

```powershell
susentorno create-host-network
susentorno run-hosting
```

- [ ] **Step 5: Update the stale comment in `src/guestSetup/powerShellExec.ts`**

Find the comment on the `createRealPowerShellExec` function (currently: `"Thin execa wrapper, no dedicated unit test (no execa-mocking precedent in this codebase, same as createSshRemoteExec) — exercised only by manual verification against a real Hyper-V host."`) and update the last clause:

```typescript
/**
 * Thin execa wrapper, no dedicated unit test (no execa-mocking precedent in
 * this codebase, same as createSshRemoteExec) — exercised by the
 * `host-network` tier's real Hyper-V/firewall calls and by manual
 * verification against a real Hyper-V host.
 */
```

- [ ] **Step 6: Proofread the changed docs**

Read through `setup-machine.md`, `setup-environment.md`, and the changed section of `setup-guest.md` once more end to end — confirm no other paragraph still references `host-allow-vm-inbound.ps1`, `New-VMSwitch`, or `New-NetIPAddress` as manual steps:

```bash
grep -rn "host-allow-vm-inbound" *.md
```

Expected: no output.

- [ ] **Step 7: Format and commit**

```bash
pnpm format
git add setup-machine.md setup-environment.md setup-guest.md src/guestSetup/powerShellExec.ts
git commit -m "docs: replace manual host-network setup steps with create-host-network"
```

---

## Final check: full pipeline

- [ ] Run the complete verification pipeline from your elevated terminal:

```bash
pnpm test
```

Expected: PASS end to end (formatting, lint, typecheck, `unit`, build, `cli`, `host-network`, `proxy-stack`, `guest`). This is the first time all nine tasks' changes run together as a whole.


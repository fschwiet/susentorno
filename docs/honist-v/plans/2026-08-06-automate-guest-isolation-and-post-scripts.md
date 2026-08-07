# Automate Guest Isolation and Post-Scripts Implementation Plan

**Goal:** Extend `susentorno setup-guest-unix` so it covers the entire remaining Ubuntu guest flow — network isolation, the post-isolation mount fix, and `post-scripts/` — so the command alone takes a guest from "SSH is reachable" through "fully set up," with nothing manual left except VM creation and the one-time host firewall setup.

**Architecture:** A dozen small, pure, independently-testable modules land under `src/guestSetup/`, mirroring the existing `quoteForRemoteShell`/`remoteExec`/`mountShare` split: PowerShell command-string builders and their result parsers are pure functions (unit tested directly); the actual `execa`-backed PowerShell invocation is a thin, untested wrapper (`PowerShellExec`, the local-process counterpart to `RemoteExec`) exercised only by manual verification against a real Hyper-V host. Orchestration functions (VM state reconciliation, the reachability poll, pre-flight validation) are written once against these injectable seams and unit tested with fakes. `src/commands/setupGuestUnix.ts` stays thin glue: elevation gate, prompts, pre-flight, then the fixed 8-step sequence the spec defines, wiring the new modules together with the existing `mountShare`/`runPreScripts`.

**Tech Stack:** TypeScript, Commander, `execa` (already a dependency — no new SSH or PowerShell library), Vitest, Node's `node:net` for the raw TCP reachability check.

## Global Constraints

- No new dependency — every Hyper-V/PowerShell operation shells out to `powershell.exe` via `execa`, the same pattern `src/runHosting/abnormalExitAlert.ts` already uses (`-NoProfile -NonInteractive -Command '<script>'`), following the pattern already established by `remoteExec.ts` for SSH: pure command-string builders are unit tested; the actual `execa` invocation is a thin, untested wrapper.
- Every value interpolated into a PowerShell `-Command` string (VM name, both derived switch names, both adapter aliases, any IP address) is PowerShell-quoted via a new `quoteForPowerShell` helper — doubling embedded `'`, PowerShell's own single-quote escaping rule, distinct from POSIX's `'\''` that `quoteForRemoteShell` already uses for the SSH/guest-shell side.
- `setup-guest-unix` now requires an already-elevated (Administrator) terminal, checked first via an `IsInRole` PowerShell one-liner, before any prompting.
- `Stop-VM` is graceful only, bounded by a 60-second `execa` timeout, and never falls back to `-Force` automatically — a VM that doesn't reach `Off` afterward is a **failure**, not an auto-forced power-off.
- The prompted guest address is used for exactly one thing: racing against Hyper-V-discovered candidates in the very first reachability wait (and only when that wait actually runs — see Task 12's note on the reconciliation no-op branch). Every address needed after that — post-reboot within step 1, and all of step 5 — comes from Hyper-V discovery (`(Get-VMNetworkAdapter -VMName <name>).IPAddresses`), never the prompt.
- The mount step (`mountShare`) is reused for both the Default-Switch and Internal-switch host IPs, so its host-IP option is generic (`hostIp`, not `defaultSwitchHostIp`) — see Task 9.
- Every `onStep` call that precedes an SSH invocation (mount steps, the KVP-daemon install, every pre-/post-script) gets a leading and trailing blank line around the existing `setup-guest-unix: ${message}...` text. Hyper-V/PowerShell-side status reporting (VM state changes, the reachability wait's progress) is separate, plain `console.log` — never routed through this `onStep`.
- A rerun of an already-set-up guest re-executes all 8 steps unconditionally, including a full round-trip through the Default Switch and back — no phase-detection/resume logic. Every built-in step must converge (an already-`Off` VM starts cleanly, an already-correct `/etc/fstab` line is a no-op); a woven-in custom pre-/post-script's idempotency remains the user's own responsibility, unchanged from today.
- Follow this repo's existing patterns: `node:`-prefixed core imports, flat `tests/unit/guestSetup/*.test.ts` layout, Prettier/ESLint conventions already configured (`pnpm format`, `pnpm lint` must pass — run them before every commit in this plan).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/guestSetup/quoteForPowerShell.ts` | PowerShell single-quote escaping for values interpolated into a `-Command` string. |
| `src/guestSetup/switchName.ts` | Derives a Hyper-V switch name from its `vEthernet (<name>)` host-adapter alias. |
| `src/guestSetup/powerShellExec.ts` | The `PowerShellExec` interface, `buildPowerShellArgv`, and the production `createRealPowerShellExec()` factory — the local-process counterpart to `remoteExec.ts`. |
| `src/guestSetup/elevationCheck.ts` | Builds and interprets the `IsInRole` elevation check. |
| `src/guestSetup/hyperVQueries.ts` | Command builders + parsers for `Get-VM`, `Get-VMNetworkAdapter`, `Get-VMSwitch`, plus `getVmIpAddresses`. |
| `src/guestSetup/hyperVOperations.ts` | Command builders for `Stop-VM`/`Connect-VMNetworkAdapter`/`Start-VM`, plus the pure `planVmReconciliation` state table. |
| `src/guestSetup/vmReconcile.ts` | Orchestrates step 1's reconciliation (including the 60s-bounded graceful stop + `Off`-confirmation poll) and step 5's unconditional isolate sequence. |
| `src/guestSetup/runHostingReadiness.ts` | `Get-NetUDPEndpoint`-based check that `run-hosting`'s DHCP/DNS ports are bound. |
| `src/guestSetup/tcpConnect.ts` | Real raw-TCP connector (untested thin wrapper, like `createSshRemoteExec`). |
| `src/guestSetup/reachabilityWait.ts` | Address-discovery-plus-TCP-reachability poll, injectable clock/connector. |
| `src/guestSetup/preflightChecks.ts` | Composes switch derivation, VM/adapter validation, and `run-hosting` readiness into step 0. |
| `src/guestSetup/mountShare.ts` | Modified: `defaultSwitchHostIp` → generic `hostIp`; last step fixed to unmount-then-remount instead of blindly `mount -a`. |
| `src/guestSetup/fstabLine.ts` | Modified: same `hostIp` rename. |
| `src/guestSetup/kvpDaemon.ts` | `ensureKvpDaemon` — installs the guest's Hyper-V KVP daemon package (one-time, idempotent). |
| `src/guestSetup/listScripts.ts` | Renamed from `listPreScripts.ts`: directory-agnostic `listScripts(dir)` / `GuestScript`, used by both pre- and post-scripts. |
| `src/guestSetup/runPreScripts.ts` | Modified: imports `GuestScript`/`listScripts` instead of `PreScript`/`listPreScripts`; behavior unchanged. |
| `src/guestSetup/runPostScripts.ts` | New: structurally identical to `runPreScripts`, minus the `configure-network` argument special case. |
| `src/commands/setupGuestUnix.ts` | Rewritten: elevation gate, VM-name prompt, pre-flight, then the full 8-step idempotent flow. |
| `setup-guest.md` | Modified: Ubuntu path collapses to "install `openssh-server`, run `setup-guest-unix`"; manual fallback and new callouts. |
| `setup-guest-unix-isolation-checklist.md` | New: checked-in manual-verification checklist for the Hyper-V-specific behavior `tests/guest/` cannot exercise. |
| `testing.md` | Modified: one-line pointer to the new checklist from the `guest` tier's known-gaps discussion. |
| `tests/unit/guestSetup/*.test.ts` | New/modified/renamed unit tests for each module above. |

---

## Task 1: `quoteForPowerShell` and `deriveSwitchName`

**Files:**

- Create: `src/guestSetup/quoteForPowerShell.ts`
- Create: `src/guestSetup/switchName.ts`
- Test: `tests/unit/guestSetup/quoteForPowerShell.test.ts`
- Test: `tests/unit/guestSetup/switchName.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export function quoteForPowerShell(value: string): string;
  export function deriveSwitchName(adapterAlias: string): string | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guestSetup/quoteForPowerShell.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

describe('quoteForPowerShell', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteForPowerShell('temp-vm')).toBe("'temp-vm'");
  });

  it('doubles an embedded single quote', () => {
    expect(quoteForPowerShell("O'Brien")).toBe("'O''Brien'");
  });

  it('doubles multiple embedded single quotes', () => {
    expect(quoteForPowerShell("a'b'c")).toBe("'a''b''c'");
  });

  it('leaves other PowerShell-significant characters untouched, since single-quoting neutralizes them', () => {
    expect(quoteForPowerShell('a; Remove-Item x $var `id` & | > <')).toBe(
      "'a; Remove-Item x $var `id` & | > <'",
    );
  });

  it('handles an empty string', () => {
    expect(quoteForPowerShell('')).toBe("''");
  });
});
```

Create `tests/unit/guestSetup/switchName.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveSwitchName } from '../../../src/guestSetup/switchName';

describe('deriveSwitchName', () => {
  it('strips the vEthernet ( ) wrapper', () => {
    expect(deriveSwitchName('vEthernet (susentorno-internal)')).toBe('susentorno-internal');
  });

  it('handles a switch name containing spaces', () => {
    expect(deriveSwitchName('vEthernet (Default Switch)')).toBe('Default Switch');
  });

  it('returns null for an alias that is not a vEthernet adapter alias', () => {
    expect(deriveSwitchName('Ethernet')).toBeNull();
  });

  it('returns null for an unclosed alias', () => {
    expect(deriveSwitchName('vEthernet (susentorno-internal')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/quoteForPowerShell.test.ts tests/unit/guestSetup/switchName.test.ts`
Expected: FAIL — both modules don't exist yet.

- [ ] **Step 3: Write the implementations**

Create `src/guestSetup/quoteForPowerShell.ts`:

```typescript
/**
 * PowerShell single-quote a value for interpolation into a `-Command` script
 * string. Every embedded `'` becomes `''` — PowerShell's own escaping rule
 * for single-quoted strings (distinct from POSIX's `'\''`, which is what
 * quoteForRemoteShell uses for the SSH/guest-shell side).
 */
export function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
```

Create `src/guestSetup/switchName.ts`:

```typescript
const VETHERNET_ALIAS_RE = /^vEthernet \((.+)\)$/;

/**
 * Derives a Hyper-V switch name from its host-side adapter alias: Windows
 * names that adapter `vEthernet (<switch name>)` by construction. Returns
 * null when the alias doesn't have that shape, so the caller can surface a
 * clear pre-flight error rather than deriving a nonsense switch name.
 */
export function deriveSwitchName(adapterAlias: string): string | null {
  const match = VETHERNET_ALIAS_RE.exec(adapterAlias);
  return match ? match[1] : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/quoteForPowerShell.test.ts tests/unit/guestSetup/switchName.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/quoteForPowerShell.ts src/guestSetup/switchName.ts tests/unit/guestSetup/quoteForPowerShell.test.ts tests/unit/guestSetup/switchName.test.ts
git commit -m "feat(guest-setup): add quoteForPowerShell and deriveSwitchName"
```

---

## Task 2: `powerShellExec` and `elevationCheck`

**Files:**

- Create: `src/guestSetup/powerShellExec.ts`
- Create: `src/guestSetup/elevationCheck.ts`
- Test: `tests/unit/guestSetup/powerShellExec.test.ts`
- Test: `tests/unit/guestSetup/elevationCheck.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export interface PowerShellExecResult {
    exitCode: number;
    stdout: string;
  }
  export interface PowerShellExec {
    run(command: string, opts?: { timeoutMs?: number }): Promise<PowerShellExecResult>;
  }
  export function buildPowerShellArgv(command: string): string[];
  export function createRealPowerShellExec(): PowerShellExec;

  export function buildElevationCheckCommand(): string;
  export function isElevated(exec: PowerShellExec): Promise<boolean>;
  ```

Only `buildPowerShellArgv` is unit tested for `powerShellExec.ts` — `createRealPowerShellExec` is a thin `execa` wrapper with no dedicated unit test, matching `remoteExec.ts`'s `createSshRemoteExec` (this codebase has no execa-mocking precedent); it's exercised only by manually running the finished command against a real Hyper-V host (see the Task 13 checklist).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guestSetup/powerShellExec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildPowerShellArgv } from '../../../src/guestSetup/powerShellExec';

describe('buildPowerShellArgv', () => {
  it('wraps the command with -NoProfile -NonInteractive -Command as one argv element', () => {
    expect(buildPowerShellArgv('Get-VM -Name x')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-VM -Name x',
    ]);
  });
});
```

Create `tests/unit/guestSetup/elevationCheck.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { buildElevationCheckCommand, isElevated } from '../../../src/guestSetup/elevationCheck';

describe('buildElevationCheckCommand', () => {
  it('checks the current identity against the Administrator role', () => {
    const command = buildElevationCheckCommand();
    expect(command).toContain('WindowsIdentity]::GetCurrent()');
    expect(command).toContain('WindowsBuiltInRole]::Administrator');
  });
});

describe('isElevated', () => {
  it('is true when the check reports True', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: 'True\r\n' };
      },
    };
    expect(await isElevated(exec)).toBe(true);
  });

  it('is false when the check reports False', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: 'False\r\n' };
      },
    };
    expect(await isElevated(exec)).toBe(false);
  });

  it('is false for unexpected output rather than assuming elevation', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 1, stdout: '' };
      },
    };
    expect(await isElevated(exec)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/powerShellExec.test.ts tests/unit/guestSetup/elevationCheck.test.ts`
Expected: FAIL — both modules don't exist yet.

- [ ] **Step 3: Write the implementations**

Create `src/guestSetup/powerShellExec.ts`:

```typescript
import { execa } from 'execa';

export interface PowerShellExecResult {
  exitCode: number;
  stdout: string;
}

/**
 * Injectable seam for "run this PowerShell command locally and get its exit
 * code and stdout back" — the local-process counterpart to remoteExec.ts's
 * RemoteExec. Production wires this to createRealPowerShellExec (below);
 * unit tests wire it to an in-memory fake.
 */
export interface PowerShellExec {
  run(command: string, opts?: { timeoutMs?: number }): Promise<PowerShellExecResult>;
}

export function buildPowerShellArgv(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', command];
}

/**
 * Thin execa wrapper, no dedicated unit test (no execa-mocking precedent in
 * this codebase, same as createSshRemoteExec) — exercised only by manual
 * verification against a real Hyper-V host.
 */
export function createRealPowerShellExec(): PowerShellExec {
  return {
    async run(command: string, opts?: { timeoutMs?: number }): Promise<PowerShellExecResult> {
      const result = await execa('powershell.exe', buildPowerShellArgv(command), {
        reject: false,
        timeout: opts?.timeoutMs,
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? '' };
    },
  };
}
```

Create `src/guestSetup/elevationCheck.ts`:

```typescript
import type { PowerShellExec } from './powerShellExec';

export function buildElevationCheckCommand(): string {
  return (
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
    '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
  );
}

export async function isElevated(exec: PowerShellExec): Promise<boolean> {
  const { stdout } = await exec.run(buildElevationCheckCommand());
  return stdout.trim() === 'True';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/powerShellExec.test.ts tests/unit/guestSetup/elevationCheck.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/powerShellExec.ts src/guestSetup/elevationCheck.ts tests/unit/guestSetup/powerShellExec.test.ts tests/unit/guestSetup/elevationCheck.test.ts
git commit -m "feat(guest-setup): add PowerShellExec seam and elevation check"
```

---

## Task 3: `hyperVQueries`

**Files:**

- Create: `src/guestSetup/hyperVQueries.ts`
- Test: `tests/unit/guestSetup/hyperVQueries.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` from Task 1; `PowerShellExec` from Task 2.
- Produces:
  ```typescript
  export interface VmQueryResult {
    name: string;
    state: string;
  }
  export function buildGetVmCommand(vmName: string): string;
  export function parseGetVmResult(stdout: string, expectedName: string): VmQueryResult | null;

  export interface VmAdapterQueryResult {
    switchName: string;
    ipAddresses: string[];
  }
  export function buildGetVmNetworkAdapterCommand(vmName: string): string;
  export function parseVmNetworkAdapterResult(stdout: string): VmAdapterQueryResult[];

  export function buildGetVmSwitchCommand(switchName: string): string;
  export function parseVmSwitchExists(stdout: string): boolean;

  export function getVmIpAddresses(exec: PowerShellExec, vmName: string): Promise<string[]>;
  ```

`Get-VM`/`Get-VMNetworkAdapter`/`Get-VMSwitch` are all called with `-ErrorAction SilentlyContinue` and re-shaped through `ConvertTo-Json -Compress`, so a "not found" result is simply empty stdout (parsed as "not found"/`[]`/`false`) rather than something the parser has to distinguish from a PowerShell-side terminating error. `Get-VM`'s `State` is explicitly `.ToString()`'d before `ConvertTo-Json` so it always serializes as a plain string, not an enum's numeric backing value.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/hyperVQueries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
  buildGetVmSwitchCommand,
  parseVmSwitchExists,
  getVmIpAddresses,
} from '../../../src/guestSetup/hyperVQueries';

describe('buildGetVmCommand', () => {
  it('quotes the VM name and requests a compact JSON object with Name and stringified State', () => {
    const command = buildGetVmCommand("temp'vm");
    expect(command).toContain("Get-VM -Name 'temp''vm'");
    expect(command).toContain('ConvertTo-Json -Compress');
    expect(command).toContain('$_.State.ToString()');
  });
});

describe('parseGetVmResult', () => {
  it('returns null for empty stdout (VM not found)', () => {
    expect(parseGetVmResult('', 'my-vm')).toBeNull();
    expect(parseGetVmResult('   ', 'my-vm')).toBeNull();
  });

  it('parses a single-object result', () => {
    expect(parseGetVmResult('{"Name":"my-vm","State":"Running"}', 'my-vm')).toEqual({
      name: 'my-vm',
      state: 'Running',
    });
  });

  it('picks the one exact match out of a wildcard-expanded array', () => {
    const stdout = '[{"Name":"my-vm","State":"Off"},{"Name":"my-vm-2","State":"Off"}]';
    expect(parseGetVmResult(stdout, 'my-vm')).toEqual({ name: 'my-vm', state: 'Off' });
  });

  it('rejects a name that only matches via wildcard expansion, not exactly', () => {
    const stdout = '[{"Name":"my-vm-2","State":"Off"}]';
    expect(parseGetVmResult(stdout, 'my-vm')).toBeNull();
  });

  it('rejects an ambiguous result with more than one exact match', () => {
    const stdout = '[{"Name":"my-vm","State":"Off"},{"Name":"my-vm","State":"Running"}]';
    expect(parseGetVmResult(stdout, 'my-vm')).toBeNull();
  });
});

describe('buildGetVmNetworkAdapterCommand', () => {
  it('quotes the VM name and requests SwitchName and IPAddresses', () => {
    const command = buildGetVmNetworkAdapterCommand("temp'vm");
    expect(command).toContain("Get-VMNetworkAdapter -VMName 'temp''vm'");
    expect(command).toContain('SwitchName');
    expect(command).toContain('IPAddresses');
  });
});

describe('parseVmNetworkAdapterResult', () => {
  it('returns an empty array for zero adapters', () => {
    expect(parseVmNetworkAdapterResult('')).toEqual([]);
  });

  it('parses a single adapter with multiple IP addresses', () => {
    const stdout = '{"SwitchName":"Default Switch","IPAddresses":["10.0.0.5","fe80::1"]}';
    expect(parseVmNetworkAdapterResult(stdout)).toEqual([
      { switchName: 'Default Switch', ipAddresses: ['10.0.0.5', 'fe80::1'] },
    ]);
  });

  it('normalizes a single IP address that PowerShell serialized as a bare string', () => {
    const stdout = '{"SwitchName":"Default Switch","IPAddresses":"10.0.0.5"}';
    expect(parseVmNetworkAdapterResult(stdout)).toEqual([
      { switchName: 'Default Switch', ipAddresses: ['10.0.0.5'] },
    ]);
  });

  it('parses multiple adapters (the too-many-adapters case the caller rejects)', () => {
    const stdout =
      '[{"SwitchName":"Default Switch","IPAddresses":[]},{"SwitchName":"susentorno-internal","IPAddresses":[]}]';
    expect(parseVmNetworkAdapterResult(stdout)).toHaveLength(2);
  });
});

describe('buildGetVmSwitchCommand / parseVmSwitchExists', () => {
  it('reports a switch as existing when stdout is non-empty', () => {
    expect(parseVmSwitchExists('{"Name":"susentorno-internal"}')).toBe(true);
  });

  it('reports a switch as not existing when stdout is empty', () => {
    expect(parseVmSwitchExists('')).toBe(false);
  });

  it('quotes the switch name', () => {
    expect(buildGetVmSwitchCommand("susentorno's-switch")).toContain(
      "Get-VMSwitch -Name 'susentorno''s-switch'",
    );
  });
});

describe('getVmIpAddresses', () => {
  it('flattens every adapter IP into one array', async () => {
    const exec: PowerShellExec = {
      async run() {
        return {
          exitCode: 0,
          stdout: '{"SwitchName":"susentorno-internal","IPAddresses":["192.168.67.50"]}',
        };
      },
    };
    expect(await getVmIpAddresses(exec, 'my-vm')).toEqual(['192.168.67.50']);
  });

  it('returns an empty array when the adapter has no reported address yet', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: '{"SwitchName":"susentorno-internal","IPAddresses":[]}' };
      },
    };
    expect(await getVmIpAddresses(exec, 'my-vm')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/hyperVQueries.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/hyperVQueries.ts`:

```typescript
import { quoteForPowerShell } from './quoteForPowerShell';
import type { PowerShellExec } from './powerShellExec';

export interface VmQueryResult {
  name: string;
  state: string;
}

export function buildGetVmCommand(vmName: string): string {
  return (
    `Get-VM -Name ${quoteForPowerShell(vmName)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ Name = $_.Name; State = $_.State.ToString() } } | ` +
    `ConvertTo-Json -Compress`
  );
}

interface RawVmEntry {
  Name?: unknown;
  State?: unknown;
}

/**
 * `-Name` accepts wildcard patterns, so Get-VM can legitimately return more
 * than one VM for a literal-looking input. Only an entry whose `Name` equals
 * the input exactly counts — exactly one such entry must exist, or this
 * returns null (covers both "not found" and "ambiguous").
 */
export function parseGetVmResult(stdout: string, expectedName: string): VmQueryResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawVmEntry[];
  const matches = list.filter((v) => v && v.Name === expectedName);
  if (matches.length !== 1) return null;
  return { name: matches[0].Name as string, state: matches[0].State as string };
}

export function buildGetVmNetworkAdapterCommand(vmName: string): string {
  return (
    `Get-VMNetworkAdapter -VMName ${quoteForPowerShell(vmName)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ SwitchName = $_.SwitchName; IPAddresses = $_.IPAddresses } } | ` +
    `ConvertTo-Json -Compress`
  );
}

export interface VmAdapterQueryResult {
  switchName: string;
  ipAddresses: string[];
}

interface RawAdapterEntry {
  SwitchName: string;
  IPAddresses?: string | string[] | null;
}

export function parseVmNetworkAdapterResult(stdout: string): VmAdapterQueryResult[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawAdapterEntry[];
  return list.map((entry) => ({
    switchName: entry.SwitchName,
    ipAddresses: Array.isArray(entry.IPAddresses)
      ? entry.IPAddresses
      : entry.IPAddresses
        ? [entry.IPAddresses]
        : [],
  }));
}

export function buildGetVmSwitchCommand(switchName: string): string {
  return (
    `Get-VMSwitch -Name ${quoteForPowerShell(switchName)} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 1 Name | ConvertTo-Json -Compress`
  );
}

export function parseVmSwitchExists(stdout: string): boolean {
  return stdout.trim() !== '';
}

/** Every reported IP across every adapter — in practice there's exactly one adapter (enforced elsewhere), so this is that adapter's addresses. */
export async function getVmIpAddresses(exec: PowerShellExec, vmName: string): Promise<string[]> {
  const result = await exec.run(buildGetVmNetworkAdapterCommand(vmName));
  return parseVmNetworkAdapterResult(result.stdout).flatMap((a) => a.ipAddresses);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/hyperVQueries.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/hyperVQueries.ts tests/unit/guestSetup/hyperVQueries.test.ts
git commit -m "feat(guest-setup): add Hyper-V VM/adapter/switch query builders and parsers"
```

---

## Task 4: `hyperVOperations`

**Files:**

- Create: `src/guestSetup/hyperVOperations.ts`
- Test: `tests/unit/guestSetup/hyperVOperations.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` from Task 1.
- Produces:
  ```typescript
  export function buildStopVmCommand(vmName: string): string;
  export function buildConnectVmNetworkAdapterCommand(vmName: string, switchName: string): string;
  export function buildStartVmCommand(vmName: string): string;

  export type VmReconciliationPlan =
    | { ok: true; stop: boolean; connect: boolean; start: boolean }
    | { ok: false; message: string };
  export function planVmReconciliation(
    state: string,
    currentSwitchName: string,
    targetSwitchName: string,
  ): VmReconciliationPlan;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/hyperVOperations.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildStopVmCommand,
  buildConnectVmNetworkAdapterCommand,
  buildStartVmCommand,
  planVmReconciliation,
} from '../../../src/guestSetup/hyperVOperations';

describe('command builders', () => {
  it('quotes the VM name and switch name', () => {
    expect(buildStopVmCommand("temp'vm")).toBe("Stop-VM -Name 'temp''vm'");
    expect(buildStartVmCommand("temp'vm")).toBe("Start-VM -Name 'temp''vm'");
    expect(buildConnectVmNetworkAdapterCommand("temp'vm", "susentorno's-internal")).toBe(
      "Connect-VMNetworkAdapter -VMName 'temp''vm' -SwitchName 'susentorno''s-internal'",
    );
  });
});

describe('planVmReconciliation', () => {
  it('is a no-op when Running on the correct switch', () => {
    expect(planVmReconciliation('Running', 'susentorno-internal', 'susentorno-internal')).toEqual({
      ok: true,
      stop: false,
      connect: false,
      start: false,
    });
  });

  it('stops, reconnects, and restarts when Running on the wrong switch', () => {
    expect(planVmReconciliation('Running', 'Default Switch', 'susentorno-internal')).toEqual({
      ok: true,
      stop: true,
      connect: true,
      start: true,
    });
  });

  it('reconnects and starts, without stopping, when Off on the wrong switch', () => {
    expect(planVmReconciliation('Off', 'Default Switch', 'susentorno-internal')).toEqual({
      ok: true,
      stop: false,
      connect: true,
      start: true,
    });
  });

  it('only starts when Off on the correct switch', () => {
    expect(planVmReconciliation('Off', 'susentorno-internal', 'susentorno-internal')).toEqual({
      ok: true,
      stop: false,
      connect: false,
      start: true,
    });
  });

  it.each(['Saved', 'Paused', 'Starting', 'Stopping'])(
    'fails with a clear message for state %s rather than guessing',
    (state) => {
      const result = planVmReconciliation(state, 'Default Switch', 'susentorno-internal');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(state);
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/hyperVOperations.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/hyperVOperations.ts`:

```typescript
import { quoteForPowerShell } from './quoteForPowerShell';

export function buildStopVmCommand(vmName: string): string {
  return `Stop-VM -Name ${quoteForPowerShell(vmName)}`;
}

export function buildConnectVmNetworkAdapterCommand(vmName: string, switchName: string): string {
  return (
    `Connect-VMNetworkAdapter -VMName ${quoteForPowerShell(vmName)} ` +
    `-SwitchName ${quoteForPowerShell(switchName)}`
  );
}

export function buildStartVmCommand(vmName: string): string {
  return `Start-VM -Name ${quoteForPowerShell(vmName)}`;
}

export type VmReconciliationPlan =
  | { ok: true; stop: boolean; connect: boolean; start: boolean }
  | { ok: false; message: string };

/**
 * Step 1's reconciliation table: only `Running`/`Off` are handled — any other
 * state (Saved, Paused, a transitional state) fails loudly rather than
 * guessing how to recover it. Stop-VM is only ever planned when the VM is
 * currently Running, never against an already-Off VM.
 */
export function planVmReconciliation(
  state: string,
  currentSwitchName: string,
  targetSwitchName: string,
): VmReconciliationPlan {
  const correctSwitch = currentSwitchName === targetSwitchName;
  if (state === 'Running' && correctSwitch) return { ok: true, stop: false, connect: false, start: false };
  if (state === 'Running' && !correctSwitch) return { ok: true, stop: true, connect: true, start: true };
  if (state === 'Off' && !correctSwitch) return { ok: true, stop: false, connect: true, start: true };
  if (state === 'Off' && correctSwitch) return { ok: true, stop: false, connect: false, start: true };
  return {
    ok: false,
    message: `VM state is '${state}' — it must be 'Off' or 'Running' before this command can proceed.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/hyperVOperations.test.ts`
Expected: PASS (6 tests, `it.each` counts as 4)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/hyperVOperations.ts tests/unit/guestSetup/hyperVOperations.test.ts
git commit -m "feat(guest-setup): add Stop/Connect/Start-VM builders and the reconciliation table"
```

---

## Task 5: `vmReconcile`

**Files:**

- Create: `src/guestSetup/vmReconcile.ts`
- Test: `tests/unit/guestSetup/vmReconcile.test.ts`

**Interfaces:**

- Consumes: `PowerShellExec` from Task 2; `buildGetVmCommand`/`parseGetVmResult`/`buildGetVmNetworkAdapterCommand`/`parseVmNetworkAdapterResult` from Task 3; `buildStopVmCommand`/`buildConnectVmNetworkAdapterCommand`/`buildStartVmCommand`/`planVmReconciliation` from Task 4; `sleep(ms, signal?)` from the existing `src/runHosting/abortableSleep.ts`.
- Produces:
  ```typescript
  export interface VmReconcileDeps {
    exec: PowerShellExec;
    vmName: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    stopTimeoutMs?: number; // default 60_000
    offConfirmTimeoutMs?: number; // default 30_000
    offPollIntervalMs?: number; // default 2_000
  }
  export interface VmReconcileOutcome {
    started: boolean;
  }
  export class VmReconcileError extends Error {}
  export function reconcileVmToSwitch(
    deps: VmReconcileDeps,
    targetSwitchName: string,
  ): Promise<VmReconcileOutcome>;
  export function isolateVmToSwitch(deps: VmReconcileDeps, targetSwitchName: string): Promise<void>;
  ```

`reconcileVmToSwitch` returns whether it actually issued a `Start-VM` — the caller (Task 12) uses this to decide whether the reachability wait is needed at all: per the spec, a VM already `Running` on the correct switch needs no new wait, since the connection from the guest address the user typed is still assumed valid (no power/network event happened). `isolateVmToSwitch` always performs `Connect`+`Start` unconditionally (step 5 is a fixed sequence, not table-driven), but still queries state first so it never assumes `Stop-VM` is a safe no-op against an already-`Off` VM — the same discipline the reconciliation table applies.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/vmReconcile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec, PowerShellExecResult } from '../../../src/guestSetup/powerShellExec';
import {
  reconcileVmToSwitch,
  isolateVmToSwitch,
  VmReconcileError,
} from '../../../src/guestSetup/vmReconcile';

function queuedExec(responses: PowerShellExecResult[]): { exec: PowerShellExec; calls: string[] } {
  const calls: string[] = [];
  const queue = [...responses];
  const exec: PowerShellExec = {
    async run(command: string) {
      calls.push(command);
      return queue.shift() ?? { exitCode: 0, stdout: '' };
    },
  };
  return { exec, calls };
}

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const vmState = (state: string): PowerShellExecResult => ({
  exitCode: 0,
  stdout: `{"Name":"my-vm","State":"${state}"}`,
});
const adapter = (switchName: string): PowerShellExecResult => ({
  exitCode: 0,
  stdout: `[{"SwitchName":"${switchName}","IPAddresses":[]}]`,
});
const ok: PowerShellExecResult = { exitCode: 0, stdout: '' };

describe('reconcileVmToSwitch', () => {
  it('does nothing when already Running on the target switch', async () => {
    const { exec, calls } = queuedExec([vmState('Running'), adapter('susentorno-internal')]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: false });
    expect(calls.some((c) => c.startsWith('Stop-VM'))).toBe(false);
    expect(calls.some((c) => c.startsWith('Connect-VMNetworkAdapter'))).toBe(false);
    expect(calls.some((c) => c.startsWith('Start-VM'))).toBe(false);
  });

  it('stops, reconnects, and restarts when Running on the wrong switch', async () => {
    const { exec, calls } = queuedExec([
      vmState('Running'),
      adapter('Default Switch'),
      ok, // Stop-VM
      vmState('Off'), // off-confirm poll, succeeds first try
      ok, // Connect
      ok, // Start
    ]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: true });
    expect(calls[2]).toBe("Stop-VM -Name 'my-vm'");
    expect(calls[4]).toBe("Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'");
    expect(calls[5]).toBe("Start-VM -Name 'my-vm'");
  });

  it('reconnects and starts, without stopping, when Off on the wrong switch', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), adapter('Default Switch'), ok, ok]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: true });
    expect(calls.some((c) => c.startsWith('Stop-VM'))).toBe(false);
    expect(calls[2]).toBe("Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'");
  });

  it('only starts when Off on the correct switch', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), adapter('susentorno-internal'), ok]);
    const outcome = await reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(outcome).toEqual({ started: true });
    expect(calls.some((c) => c.startsWith('Connect-VMNetworkAdapter'))).toBe(false);
    expect(calls[2]).toBe("Start-VM -Name 'my-vm'");
  });

  it('fails with a clear message for an unsupported state, touching nothing', async () => {
    const { exec, calls } = queuedExec([vmState('Saved'), adapter('Default Switch')]);
    await expect(reconcileVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal')).rejects.toThrow(
      VmReconcileError,
    );
    expect(calls).toHaveLength(2); // only the two state queries ran
  });

  it('polls Get-VM until the graceful stop is confirmed Off, retrying while still Running', async () => {
    const clock = fakeClock();
    const { exec } = queuedExec([
      vmState('Running'),
      adapter('Default Switch'),
      ok, // Stop-VM
      vmState('Running'), // poll 1
      vmState('Running'), // poll 2
      vmState('Off'), // poll 3
      ok, // Connect
      ok, // Start
    ]);
    const outcome = await reconcileVmToSwitch(
      {
        exec,
        vmName: 'my-vm',
        now: clock.now,
        sleep: clock.sleep,
        offPollIntervalMs: 2_000,
        offConfirmTimeoutMs: 30_000,
      },
      'susentorno-internal',
    );
    expect(outcome).toEqual({ started: true });
  });

  it('fails if the VM never reaches Off within the confirmation deadline', async () => {
    const clock = fakeClock();
    const exec: PowerShellExec = {
      async run(command: string) {
        if (command.startsWith('Get-VMNetworkAdapter')) return adapter('Default Switch');
        return vmState('Running'); // Get-VM always reports Running
      },
    };
    await expect(
      reconcileVmToSwitch(
        {
          exec,
          vmName: 'my-vm',
          now: clock.now,
          sleep: clock.sleep,
          offPollIntervalMs: 2_000,
          offConfirmTimeoutMs: 5_000,
        },
        'susentorno-internal',
      ),
    ).rejects.toThrow(/did not reach 'Off'/);
  });
});

describe('isolateVmToSwitch', () => {
  it('stops, reconnects, and starts when the VM is Running', async () => {
    const { exec, calls } = queuedExec([
      vmState('Running'),
      ok, // Stop-VM
      vmState('Off'), // off-confirm poll
      ok, // Connect
      ok, // Start
    ]);
    await isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(calls[1]).toBe("Stop-VM -Name 'my-vm'");
    expect(calls[3]).toBe("Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'");
    expect(calls[4]).toBe("Start-VM -Name 'my-vm'");
  });

  it('reconnects and starts without stopping when the VM is already Off', async () => {
    const { exec, calls } = queuedExec([vmState('Off'), ok, ok]);
    await isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal');
    expect(calls.some((c) => c.startsWith('Stop-VM'))).toBe(false);
    expect(calls[1]).toBe("Connect-VMNetworkAdapter -VMName 'my-vm' -SwitchName 'susentorno-internal'");
  });

  it('fails for an unsupported state rather than guessing', async () => {
    const { exec } = queuedExec([vmState('Paused')]);
    await expect(isolateVmToSwitch({ exec, vmName: 'my-vm' }, 'susentorno-internal')).rejects.toThrow(
      VmReconcileError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/vmReconcile.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/vmReconcile.ts`:

```typescript
import type { PowerShellExec } from './powerShellExec';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
} from './hyperVQueries';
import {
  buildStopVmCommand,
  buildConnectVmNetworkAdapterCommand,
  buildStartVmCommand,
  planVmReconciliation,
} from './hyperVOperations';
import { sleep as defaultSleep } from '../runHosting/abortableSleep';

export interface VmReconcileDeps {
  exec: PowerShellExec;
  vmName: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  offConfirmTimeoutMs?: number;
  offPollIntervalMs?: number;
}

export interface VmReconcileOutcome {
  started: boolean;
}

export class VmReconcileError extends Error {}

async function queryVmStateAndSwitch(
  deps: VmReconcileDeps,
): Promise<{ state: string; switchName: string }> {
  const vmResult = await deps.exec.run(buildGetVmCommand(deps.vmName));
  const vm = parseGetVmResult(vmResult.stdout, deps.vmName);
  if (!vm) {
    throw new VmReconcileError(`vmReconcile: VM '${deps.vmName}' not found (or matched more than one VM)`);
  }
  const adapterResult = await deps.exec.run(buildGetVmNetworkAdapterCommand(deps.vmName));
  const adapters = parseVmNetworkAdapterResult(adapterResult.stdout);
  if (adapters.length !== 1) {
    throw new VmReconcileError(
      `vmReconcile: VM '${deps.vmName}' has ${adapters.length} network adapters, expected exactly 1`,
    );
  }
  return { state: vm.state, switchName: adapters[0].switchName };
}

/**
 * Bounds the graceful shutdown at the process level (Stop-VM's own execa call
 * is given stopTimeoutMs and killed if exceeded), then separately confirms
 * the VM actually reached Off by polling Get-VM — either way the Stop-VM call
 * returns (early, or killed at its deadline), confirmation is what decides
 * success, not Stop-VM's own exit code.
 */
async function gracefulStopAndConfirmOff(deps: VmReconcileDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 60_000;
  const offConfirmTimeoutMs = deps.offConfirmTimeoutMs ?? 30_000;
  const offPollIntervalMs = deps.offPollIntervalMs ?? 2_000;

  await deps.exec.run(buildStopVmCommand(deps.vmName), { timeoutMs: stopTimeoutMs });

  const deadline = now() + offConfirmTimeoutMs;
  for (;;) {
    const vmResult = await deps.exec.run(buildGetVmCommand(deps.vmName));
    const vm = parseGetVmResult(vmResult.stdout, deps.vmName);
    if (vm?.state === 'Off') return;
    if (now() >= deadline) {
      throw new VmReconcileError(
        `vmReconcile: VM '${deps.vmName}' did not reach 'Off' after a graceful Stop-VM — ` +
          `current state is '${vm?.state ?? 'unknown'}'. Investigate or force-stop it manually, then rerun.`,
      );
    }
    await sleep(offPollIntervalMs);
  }
}

export async function reconcileVmToSwitch(
  deps: VmReconcileDeps,
  targetSwitchName: string,
): Promise<VmReconcileOutcome> {
  const { state, switchName } = await queryVmStateAndSwitch(deps);
  const plan = planVmReconciliation(state, switchName, targetSwitchName);
  if (!plan.ok) throw new VmReconcileError(`vmReconcile: ${plan.message}`);
  if (plan.stop) await gracefulStopAndConfirmOff(deps);
  if (plan.connect) {
    await deps.exec.run(buildConnectVmNetworkAdapterCommand(deps.vmName, targetSwitchName));
  }
  if (plan.start) {
    await deps.exec.run(buildStartVmCommand(deps.vmName));
  }
  return { started: plan.start };
}

/** Step 5's unconditional isolate sequence: always ends Connect+Start, but only Stops first if actually Running. */
export async function isolateVmToSwitch(deps: VmReconcileDeps, targetSwitchName: string): Promise<void> {
  const vmResult = await deps.exec.run(buildGetVmCommand(deps.vmName));
  const vm = parseGetVmResult(vmResult.stdout, deps.vmName);
  if (!vm) {
    throw new VmReconcileError(`vmReconcile: VM '${deps.vmName}' not found (or matched more than one VM)`);
  }
  if (vm.state === 'Running') {
    await gracefulStopAndConfirmOff(deps);
  } else if (vm.state !== 'Off') {
    throw new VmReconcileError(
      `vmReconcile: VM '${deps.vmName}' is in state '${vm.state}' — it must be 'Off' or 'Running' before isolating it.`,
    );
  }
  await deps.exec.run(buildConnectVmNetworkAdapterCommand(deps.vmName, targetSwitchName));
  await deps.exec.run(buildStartVmCommand(deps.vmName));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/vmReconcile.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/vmReconcile.ts tests/unit/guestSetup/vmReconcile.test.ts
git commit -m "feat(guest-setup): add reconcileVmToSwitch and isolateVmToSwitch"
```

---

## Task 6: `runHostingReadiness`

**Files:**

- Create: `src/guestSetup/runHostingReadiness.ts`
- Test: `tests/unit/guestSetup/runHostingReadiness.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` from Task 1; `PowerShellExec` from Task 2.
- Produces:
  ```typescript
  export function buildGetNetUdpEndpointCommand(localAddress: string, localPort: number): string;
  export function parseEndpointBound(stdout: string): boolean;
  export interface RunHostingReadiness {
    dhcpBound: boolean;
    dnsBound: boolean;
  }
  export function checkRunHostingReady(
    exec: PowerShellExec,
    internalSwitchHostIp: string,
  ): Promise<RunHostingReadiness>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/runHostingReadiness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  buildGetNetUdpEndpointCommand,
  parseEndpointBound,
  checkRunHostingReady,
} from '../../../src/guestSetup/runHostingReadiness';

describe('buildGetNetUdpEndpointCommand', () => {
  it('quotes the address and includes the port', () => {
    expect(buildGetNetUdpEndpointCommand('192.168.67.1', 67)).toBe(
      "Get-NetUDPEndpoint -LocalAddress '192.168.67.1' -LocalPort 67",
    );
  });
});

describe('parseEndpointBound', () => {
  it('is false for empty stdout', () => {
    expect(parseEndpointBound('')).toBe(false);
    expect(parseEndpointBound('   \n')).toBe(false);
  });

  it('is true for any non-empty stdout', () => {
    expect(parseEndpointBound('LocalAddress : 192.168.67.1')).toBe(true);
  });
});

describe('checkRunHostingReady', () => {
  it('reports both bound when both ports return output', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: 'bound' };
      },
    };
    expect(await checkRunHostingReady(exec, '192.168.67.1')).toEqual({ dhcpBound: true, dnsBound: true });
  });

  it('reports each port independently', async () => {
    const exec: PowerShellExec = {
      async run(command: string) {
        return { exitCode: 0, stdout: command.includes('-LocalPort 67') ? 'bound' : '' };
      },
    };
    expect(await checkRunHostingReady(exec, '192.168.67.1')).toEqual({ dhcpBound: true, dnsBound: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/runHostingReadiness.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/runHostingReadiness.ts`:

```typescript
import { quoteForPowerShell } from './quoteForPowerShell';
import type { PowerShellExec } from './powerShellExec';

export function buildGetNetUdpEndpointCommand(localAddress: string, localPort: number): string {
  return `Get-NetUDPEndpoint -LocalAddress ${quoteForPowerShell(localAddress)} -LocalPort ${localPort}`;
}

/** Get-NetUDPEndpoint returns nothing (empty stdout, no error) when no endpoint matches. */
export function parseEndpointBound(stdout: string): boolean {
  return stdout.trim() !== '';
}

export interface RunHostingReadiness {
  dhcpBound: boolean;
  dnsBound: boolean;
}

export async function checkRunHostingReady(
  exec: PowerShellExec,
  internalSwitchHostIp: string,
): Promise<RunHostingReadiness> {
  const dhcpResult = await exec.run(buildGetNetUdpEndpointCommand(internalSwitchHostIp, 67));
  const dnsResult = await exec.run(buildGetNetUdpEndpointCommand(internalSwitchHostIp, 53));
  return {
    dhcpBound: parseEndpointBound(dhcpResult.stdout),
    dnsBound: parseEndpointBound(dnsResult.stdout),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/runHostingReadiness.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/runHostingReadiness.ts tests/unit/guestSetup/runHostingReadiness.test.ts
git commit -m "feat(guest-setup): add run-hosting DHCP/DNS readiness check"
```

---

## Task 7: `tcpConnect` and `reachabilityWait`

**Files:**

- Create: `src/guestSetup/tcpConnect.ts`
- Create: `src/guestSetup/reachabilityWait.ts`
- Test: `tests/unit/guestSetup/reachabilityWait.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  export const realTcpConnect: TcpConnector;

  export interface ReachabilityWaitOptions {
    getCandidates: () => string[] | Promise<string[]>;
    connect: TcpConnector;
    port?: number; // default 22
    timeoutMs?: number; // default 600_000 (10 min)
    pollIntervalMs?: number; // default 10_000
    connectTimeoutMs?: number; // default 5_000
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onProgress?: (elapsedMs: number) => void;
  }
  export type ReachabilityResult = { reachable: true; address: string } | { reachable: false };
  export function waitForReachable(opts: ReachabilityWaitOptions): Promise<ReachabilityResult>;
  ```

`realTcpConnect` (in `tcpConnect.ts`) is a thin `node:net` wrapper with no dedicated unit test, matching `createSshRemoteExec`/`createRealPowerShellExec` — it's exercised only by manual verification. `waitForReachable` is the pure, injectable orchestration: on each poll it asks `getCandidates()` for the current set of addresses (which may be empty, e.g. before Hyper-V has reported anything yet) and tries `connect` against each in order, returning the first that succeeds; "racing" the prompted address against Hyper-V discovery (step 1) is just supplying both as candidates in one list — whichever `connect` accepts first wins.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/reachabilityWait.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { waitForReachable } from '../../../src/guestSetup/reachabilityWait';

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('waitForReachable', () => {
  it('returns immediately when the first candidate is reachable', async () => {
    const clock = fakeClock();
    const result = await waitForReachable({
      getCandidates: () => ['192.168.67.50'],
      connect: async () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toEqual({ reachable: true, address: '192.168.67.50' });
  });

  it('times out when nothing is ever reachable', async () => {
    const clock = fakeClock();
    const result = await waitForReachable({
      getCandidates: () => ['192.168.67.50'],
      connect: async () => false,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 30_000,
      pollIntervalMs: 10_000,
    });
    expect(result).toEqual({ reachable: false });
  });

  it('succeeds once a candidate address appears after several empty polls', async () => {
    const clock = fakeClock();
    let poll = 0;
    const result = await waitForReachable({
      getCandidates: () => {
        poll += 1;
        return poll < 3 ? [] : ['192.168.67.60'];
      },
      connect: async (address) => address === '192.168.67.60',
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 60_000,
      pollIntervalMs: 10_000,
    });
    expect(result).toEqual({ reachable: true, address: '192.168.67.60' });
    expect(poll).toBe(3);
  });

  it('reports progress on every poll that does not find a reachable candidate', async () => {
    const clock = fakeClock();
    const progressAt: number[] = [];
    await waitForReachable({
      getCandidates: () => [],
      connect: async () => false,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 25_000,
      pollIntervalMs: 10_000,
      onProgress: (elapsedMs) => progressAt.push(elapsedMs),
    });
    expect(progressAt).toEqual([0, 10_000, 20_000]);
  });

  it('races the prompted address against a Hyper-V-discovered one, either winning', async () => {
    const clock1 = fakeClock();
    const onlyPromptedReachable = await waitForReachable({
      getCandidates: () => ['prompted-address', 'hyperv-address'],
      connect: async (address) => address === 'prompted-address',
      now: clock1.now,
      sleep: clock1.sleep,
    });
    expect(onlyPromptedReachable).toEqual({ reachable: true, address: 'prompted-address' });

    const clock2 = fakeClock();
    const onlyHyperVReachable = await waitForReachable({
      getCandidates: () => ['prompted-address', 'hyperv-address'],
      connect: async (address) => address === 'hyperv-address',
      now: clock2.now,
      sleep: clock2.sleep,
    });
    expect(onlyHyperVReachable).toEqual({ reachable: true, address: 'hyperv-address' });
  });

  it('polls repeatedly against an unresponsive port before giving up', async () => {
    const clock = fakeClock();
    let connectCalls = 0;
    const result = await waitForReachable({
      getCandidates: () => ['192.168.67.50'],
      connect: async () => {
        connectCalls += 1;
        return false;
      },
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 20_000,
      pollIntervalMs: 10_000,
    });
    expect(result).toEqual({ reachable: false });
    expect(connectCalls).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/reachabilityWait.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementations**

Create `src/guestSetup/tcpConnect.ts`:

```typescript
import { Socket } from 'node:net';

export type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * A raw socket connect/close, not a full SSH handshake — deliberately avoids
 * running real SSH during the reachability poll (see reachabilityWait.ts).
 * No dedicated unit test (thin production wrapper, same as createSshRemoteExec).
 */
export const realTcpConnect: TcpConnector = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
```

Create `src/guestSetup/reachabilityWait.ts`:

```typescript
import type { TcpConnector } from './tcpConnect';

export interface ReachabilityWaitOptions {
  getCandidates: () => string[] | Promise<string[]>;
  connect: TcpConnector;
  port?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (elapsedMs: number) => void;
}

export type ReachabilityResult = { reachable: true; address: string } | { reachable: false };

/**
 * Address discovery and reachability checking are the same loop: each tick
 * asks getCandidates() for whatever's currently known (prompted address,
 * Hyper-V-discovered addresses, or both — the caller decides), and tries a
 * raw TCP connect against each in order, returning the first that answers.
 */
export async function waitForReachable(opts: ReachabilityWaitOptions): Promise<ReachabilityResult> {
  const port = opts.port ?? 22;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();

  for (;;) {
    const candidates = await opts.getCandidates();
    for (const address of candidates) {
      if (await opts.connect(address, port, connectTimeoutMs)) {
        return { reachable: true, address };
      }
    }
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) return { reachable: false };
    opts.onProgress?.(elapsed);
    await sleep(pollIntervalMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/reachabilityWait.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/tcpConnect.ts src/guestSetup/reachabilityWait.ts tests/unit/guestSetup/reachabilityWait.test.ts
git commit -m "feat(guest-setup): add TCP reachability poll with injectable clock and connector"
```

---

## Task 8: `preflightChecks`

**Files:**

- Create: `src/guestSetup/preflightChecks.ts`
- Test: `tests/unit/guestSetup/preflightChecks.test.ts`

**Interfaces:**

- Consumes: `deriveSwitchName` from Task 1; `PowerShellExec` from Task 2; `buildGetVmCommand`/`parseGetVmResult`/`buildGetVmNetworkAdapterCommand`/`parseVmNetworkAdapterResult`/`buildGetVmSwitchCommand`/`parseVmSwitchExists` from Task 3; `checkRunHostingReady` from Task 6.
- Produces:
  ```typescript
  export interface PreflightOptions {
    exec: PowerShellExec;
    vmName: string;
    adapterAlias: string; // Internal-switch adapter alias
    natAdapterAlias: string; // Default-Switch adapter alias
    internalSwitchHostIp: string;
  }
  export type PreflightResult =
    | { ok: true; defaultSwitchName: string; internalSwitchName: string }
    | { ok: false; message: string };
  export function runPreflightChecks(opts: PreflightOptions): Promise<PreflightResult>;
  ```

This is step 0 end to end (minus elevation, which is checked earlier and separately — see Task 12): derive both switch names, confirm the VM exists uniquely and has exactly one adapter, confirm both derived switch names resolve to real Hyper-V switches, confirm `run-hosting`'s DHCP/DNS ports are bound. Each check fails fast with a specific message before the next one runs.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/preflightChecks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { runPreflightChecks } from '../../../src/guestSetup/preflightChecks';

function fakeExec(responses: Record<string, string>): PowerShellExec {
  return {
    async run(command: string) {
      for (const [substring, stdout] of Object.entries(responses)) {
        if (command.includes(substring)) return { exitCode: 0, stdout };
      }
      return { exitCode: 0, stdout: '' };
    },
  };
}

const ready = {
  "Get-VM -Name 'my-vm'": '{"Name":"my-vm","State":"Running"}',
  "Get-VMNetworkAdapter -VMName 'my-vm'": '{"SwitchName":"Default Switch","IPAddresses":[]}',
  "Get-VMSwitch -Name 'susentorno-internal'": '{"Name":"susentorno-internal"}',
  "Get-VMSwitch -Name 'Default Switch'": '{"Name":"Default Switch"}',
  '-LocalPort 67': 'bound',
  '-LocalPort 53': 'bound',
};

const baseOpts = {
  vmName: 'my-vm',
  adapterAlias: 'vEthernet (susentorno-internal)',
  natAdapterAlias: 'vEthernet (Default Switch)',
  internalSwitchHostIp: '192.168.67.1',
};

describe('runPreflightChecks', () => {
  it('succeeds and returns both derived switch names when everything checks out', async () => {
    const result = await runPreflightChecks({ ...baseOpts, exec: fakeExec(ready) });
    expect(result).toEqual({
      ok: true,
      defaultSwitchName: 'Default Switch',
      internalSwitchName: 'susentorno-internal',
    });
  });

  it('fails on a malformed adapter alias before touching the VM', async () => {
    const result = await runPreflightChecks({ ...baseOpts, adapterAlias: 'Ethernet', exec: fakeExec(ready) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Ethernet');
  });

  it('fails when no VM matches the name exactly', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VM -Name 'my-vm'": '' }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when the VM has more than one network adapter', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({
        ...ready,
        "Get-VMNetworkAdapter -VMName 'my-vm'":
          '[{"SwitchName":"Default Switch","IPAddresses":[]},{"SwitchName":"susentorno-internal","IPAddresses":[]}]',
      }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when the VM has zero network adapters', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMNetworkAdapter -VMName 'my-vm'": '' }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when a derived switch name does not resolve to a real switch', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMSwitch -Name 'susentorno-internal'": '' }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when run-hosting is not listening on the internal-switch host IP', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, '-LocalPort 67': '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('run-hosting');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/preflightChecks.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/preflightChecks.ts`:

```typescript
import type { PowerShellExec } from './powerShellExec';
import { deriveSwitchName } from './switchName';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
  buildGetVmSwitchCommand,
  parseVmSwitchExists,
} from './hyperVQueries';
import { checkRunHostingReady } from './runHostingReadiness';

export interface PreflightOptions {
  exec: PowerShellExec;
  vmName: string;
  adapterAlias: string;
  natAdapterAlias: string;
  internalSwitchHostIp: string;
}

export type PreflightResult =
  | { ok: true; defaultSwitchName: string; internalSwitchName: string }
  | { ok: false; message: string };

export async function runPreflightChecks(opts: PreflightOptions): Promise<PreflightResult> {
  const internalSwitchName = deriveSwitchName(opts.adapterAlias);
  if (!internalSwitchName) {
    return {
      ok: false,
      message: `preflight: '${opts.adapterAlias}' does not look like a Hyper-V vEthernet adapter alias`,
    };
  }
  const defaultSwitchName = deriveSwitchName(opts.natAdapterAlias);
  if (!defaultSwitchName) {
    return {
      ok: false,
      message: `preflight: '${opts.natAdapterAlias}' does not look like a Hyper-V vEthernet adapter alias`,
    };
  }

  const vmResult = await opts.exec.run(buildGetVmCommand(opts.vmName));
  const vm = parseGetVmResult(vmResult.stdout, opts.vmName);
  if (!vm) {
    return { ok: false, message: `preflight: no VM named exactly '${opts.vmName}' was found` };
  }

  const adapterResult = await opts.exec.run(buildGetVmNetworkAdapterCommand(opts.vmName));
  const adapters = parseVmNetworkAdapterResult(adapterResult.stdout);
  if (adapters.length !== 1) {
    return {
      ok: false,
      message: `preflight: VM '${opts.vmName}' has ${adapters.length} network adapters, expected exactly 1`,
    };
  }

  for (const [alias, switchName] of [
    [opts.adapterAlias, internalSwitchName],
    [opts.natAdapterAlias, defaultSwitchName],
  ] as const) {
    const switchResult = await opts.exec.run(buildGetVmSwitchCommand(switchName));
    if (!parseVmSwitchExists(switchResult.stdout)) {
      return {
        ok: false,
        message: `preflight: derived switch name '${switchName}' (from '${alias}') does not resolve to a real Hyper-V switch`,
      };
    }
  }

  const readiness = await checkRunHostingReady(opts.exec, opts.internalSwitchHostIp);
  if (!readiness.dhcpBound || !readiness.dnsBound) {
    const missing = [!readiness.dhcpBound && 'DHCP (67)', !readiness.dnsBound && 'DNS (53)']
      .filter(Boolean)
      .join(', ');
    return {
      ok: false,
      message:
        `preflight: run-hosting does not appear to be listening on ${opts.internalSwitchHostIp} — ` +
        `${missing} not bound. Start 'susentorno run-hosting' and retry.`,
    };
  }

  return { ok: true, defaultSwitchName, internalSwitchName };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/preflightChecks.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/preflightChecks.ts tests/unit/guestSetup/preflightChecks.test.ts
git commit -m "feat(guest-setup): add step 0 pre-flight checks"
```

---

## Task 9: Fix `mountShare`'s remount step and generalize its host-IP option

**Files:**

- Modify: `src/guestSetup/mountShare.ts`
- Modify: `src/guestSetup/fstabLine.ts`
- Modify: `tests/unit/guestSetup/mountShare.test.ts`
- Modify: `tests/unit/guestSetup/fstabLine.test.ts`

**Interfaces:**

- Produces (changed):
  ```typescript
  export interface FstabReplaceOptions {
    shareName: string;
    hostIp: string; // renamed from defaultSwitchHostIp — mountShare is now called with either host IP
  }
  export interface MountShareOptions {
    shareName: string;
    accountName: string;
    password: string;
    hostIp: string; // renamed from defaultSwitchHostIp
    onStep?: (message: string) => void;
  }
  ```

`mountShare` is called twice by the finished command (Task 12) — once with the Default-Switch host IP, once with the Internal-switch host IP — so its option can no longer be named after one specific phase. This task also fixes the bug the spec calls out: `mount -a` alone doesn't detect or remount an entry whose *source* changed while the mount point is still (stale-)mounted, so a rerun after isolation could leave the live mount pointed at the old, now-unreachable Default-Switch IP even though `/etc/fstab` was rewritten correctly. The fix distinguishes "not mounted" (skip straight to `mount -a`) from "mounted but failed to unmount" (stop — do not call `mount -a` over a still-active stale mount).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/guestSetup/fstabLine.test.ts`, replace every `defaultSwitchHostIp:` key with `hostIp:` (three occurrences):

```typescript
import { describe, it, expect } from 'vitest';
import { buildFstabReplaceCommand } from '../../../src/guestSetup/fstabLine';

describe('buildFstabReplaceCommand', () => {
  it('deletes any existing line for the mount point, then appends the correct one', () => {
    const command = buildFstabReplaceCommand({
      shareName: 'vm-shared-linux',
      hostIp: '172.28.128.1',
    });
    expect(command).toBe(
      "sudo sed -i '\\#[[:space:]]/mnt/vm-shared-linux[[:space:]]#d' /etc/fstab && " +
        "echo '//172.28.128.1/vm-shared-linux /mnt/vm-shared-linux cifs " +
        "ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount 0 0' " +
        '| sudo tee -a /etc/fstab > /dev/null',
    );
  });

  it('quotes a share name containing a single quote', () => {
    const command = buildFstabReplaceCommand({
      shareName: "share'name",
      hostIp: '172.28.128.1',
    });
    expect(command).toContain("/mnt/share'\\''name");
  });

  it('escapes sed/BRE metacharacters in the share name so the delete pattern matches literally', () => {
    const command = buildFstabReplaceCommand({
      shareName: 'share.name#1',
      hostIp: '172.28.128.1',
    });
    expect(command).toContain('/mnt/share\\.name\\#1');
  });
});
```

In `tests/unit/guestSetup/mountShare.test.ts`, replace **every** `defaultSwitchHostIp: '172.28.128.1'` with `hostIp: '172.28.128.1'` across all six existing tests (the field rename is the only change to those six), then add three new tests and rewrite the interleaving-order test. The full file becomes:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import { mountShare, MountShareError } from '../../../src/guestSetup/mountShare';

function fakeRemoteExec(
  overrides: {
    runResults?: Record<string, number>;
    copyResult?: number;
  } = {},
): { remoteExec: RemoteExec; calls: string[]; copiedFiles: [string, string][] } {
  const calls: string[] = [];
  const copiedFiles: [string, string][] = [];
  const remoteExec: RemoteExec = {
    async run(command: string): Promise<RemoteExecResult> {
      calls.push(command);
      for (const [substring, exitCode] of Object.entries(overrides.runResults ?? {})) {
        if (command.includes(substring)) return { exitCode };
      }
      return { exitCode: 0 };
    },
    async copyFile(local: string, remote: string): Promise<RemoteExecResult> {
      copiedFiles.push([local, remote]);
      return { exitCode: overrides.copyResult ?? 0 };
    },
  };
  return { remoteExec, calls, copiedFiles };
}

describe('mountShare', () => {
  it('runs cifs-utils install, delivers credentials, creates the mount point, updates fstab, and mounts', async () => {
    const { remoteExec, calls, copiedFiles } = fakeRemoteExec();
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      hostIp: '172.28.128.1',
    });

    expect(calls[0]).toBe('sudo apt-get install -y cifs-utils');
    expect(copiedFiles).toHaveLength(1);
    expect(
      calls.some(
        (c) => c.includes('sudo install -m 600') && c.includes('/etc/susentorno-share.cred'),
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.includes('sudo mkdir -p') && c.includes('/mnt/vm-shared-linux')),
    ).toBe(true);
    expect(calls.some((c) => c.includes('/etc/fstab'))).toBe(true);
    expect(calls[calls.length - 1]).toBe('sudo systemctl daemon-reload && sudo mount -a');
  });

  it('writes the credentials file locally with the account name and password before copying it, then deletes it', async () => {
    let capturedContents = '';
    let capturedLocalPath = '';
    const remoteExec: RemoteExec = {
      async run(): Promise<RemoteExecResult> {
        return { exitCode: 0 };
      },
      async copyFile(local: string): Promise<RemoteExecResult> {
        capturedLocalPath = local;
        capturedContents = readFileSync(local, 'utf8');
        return { exitCode: 0 };
      },
    };
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      hostIp: '172.28.128.1',
    });
    expect(capturedContents).toBe('username=susentorno-share\npassword=hunter2\n');
    expect(existsSync(capturedLocalPath)).toBe(false); // deleted after mountShare returns
  });

  it('stops at the first failing step and reports which one', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ runResults: { 'cifs-utils': 1 } });
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        hostIp: '172.28.128.1',
      }),
    ).rejects.toThrow(MountShareError);
    expect(calls).toEqual(['sudo apt-get install -y cifs-utils']); // nothing after the failure ran
  });

  it('stops if the credentials-file copy fails', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ copyResult: 1 });
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        hostIp: '172.28.128.1',
      }),
    ).rejects.toThrow(MountShareError);
    expect(calls.some((c) => c.includes('sudo install -m 600'))).toBe(false);
  });

  it('constructs the install step so the remote temp file is removed even if install fails', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      hostIp: '172.28.128.1',
    });
    const installCall = calls.find((c) => c.includes('sudo install -m 600'))!;
    expect(installCall).toContain('rm -f');
    expect(installCall).toMatch(/"\$HOME\/\.susentorno-share-cred-[a-f0-9]+"/);
    expect(installCall).not.toContain("'~/.susentorno-share-cred-");
    expect(installCall).not.toMatch(/sudo install[^;]*&&[^;]*rm -f/);
  });

  it('reports each step to onStep immediately before the operation it describes runs, in order', async () => {
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        if (command.startsWith('mountpoint -q')) return { exitCode: 1 }; // not currently mounted
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        events.push('copyFile');
        return { exitCode: 0 };
      },
    };
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      hostIp: '172.28.128.1',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events.map((e) => e.split(':')[0])).toEqual([
      'step', 'run', // install cifs-utils
      'step', 'copyFile', // copy credentials file
      'step', 'run', // install credentials file
      'step', 'run', // create mount point
      'step', 'run', // update fstab
      'step', 'run', // check active mount
      'step', 'run', // mount share
    ]);
    expect(events[0]).toBe('step:install cifs-utils');
    expect(events[2]).toBe('step:copy credentials file');
    expect(events[4]).toBe('step:install credentials file');
    expect(events[6]).toBe('step:create mount point');
    expect(events[8]).toBe('step:update fstab');
    expect(events[10]).toBe('step:check active mount');
    expect(events[12]).toBe('step:mount share');
  });

  it('works with no onStep given', async () => {
    const { remoteExec } = fakeRemoteExec();
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        hostIp: '172.28.128.1',
      }),
    ).resolves.toBeUndefined();
  });

  it('skips straight to mount -a when the share is not currently mounted', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ runResults: { 'mountpoint -q': 1 } });
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      hostIp: '172.28.128.1',
    });
    expect(calls.some((c) => c.startsWith('sudo umount'))).toBe(false);
    expect(calls[calls.length - 1]).toBe('sudo systemctl daemon-reload && sudo mount -a');
  });

  it('unmounts a currently-active mount before remounting', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ runResults: { 'mountpoint -q': 0 } });
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      hostIp: '172.28.128.1',
    });
    const umountIndex = calls.findIndex((c) => c.startsWith('sudo umount'));
    const mountAIndex = calls.indexOf('sudo systemctl daemon-reload && sudo mount -a');
    expect(umountIndex).toBeGreaterThan(-1);
    expect(umountIndex).toBeLessThan(mountAIndex);
  });

  it('stops before mount -a when a failing umount cannot clear a stale active mount (regression)', async () => {
    const { remoteExec, calls } = fakeRemoteExec({
      runResults: { 'mountpoint -q': 0, 'sudo umount': 1 },
    });
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        hostIp: '172.28.128.1',
      }),
    ).rejects.toThrow(MountShareError);
    expect(calls).not.toContain('sudo systemctl daemon-reload && sudo mount -a');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/mountShare.test.ts tests/unit/guestSetup/fstabLine.test.ts`
Expected: FAIL — `hostIp` doesn't exist on `MountShareOptions`/`FstabReplaceOptions` yet (TypeScript error), and the three new mount-fix tests fail against the old blind `mount -a`.

- [ ] **Step 3: Update the implementations**

In `src/guestSetup/fstabLine.ts`, rename the field and its two usages:

```typescript
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface FstabReplaceOptions {
  shareName: string;
  hostIp: string;
}

/**
 * Idempotent /etc/fstab update for the cifs mount line: delete any existing
 * line for this mount point (matched by [[:space:]]-bounded field, so it
 * can't false-positive on a longer directory name), then append the correct
 * line fresh. Safe both for a same-content rerun and for a rerun after the
 * host IP changed — either the Default-Switch address across a host reboot,
 * or the switch from Default to Internal across isolation — either way this
 * converges on one correct line, unlike a plain `tee -a`.
 */
function escapeForSedBre(value: string): string {
  return value.replace(/[\\.*[\]^$#]/g, '\\$&');
}

export function buildFstabReplaceCommand(opts: FstabReplaceOptions): string {
  const mountPoint = `/mnt/${opts.shareName}`;
  const fstabLine =
    `//${opts.hostIp}/${opts.shareName} ${mountPoint} cifs ` +
    `ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount 0 0`;
  const deleteScript = `\\#[[:space:]]${escapeForSedBre(mountPoint)}[[:space:]]#d`;
  return (
    `sudo sed -i ${quoteForRemoteShell(deleteScript)} /etc/fstab && ` +
    `echo ${quoteForRemoteShell(fstabLine)} | sudo tee -a /etc/fstab > /dev/null`
  );
}
```

In `src/guestSetup/mountShare.ts`, rename the field and replace the final step with the unmount-then-remount fix:

```typescript
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RemoteExec } from './remoteExec';
import { quoteForRemoteShell } from './quoteForRemoteShell';
import { buildFstabReplaceCommand } from './fstabLine';

export interface MountShareOptions {
  shareName: string;
  accountName: string;
  password: string;
  hostIp: string;
  onStep?: (message: string) => void;
}

export class MountShareError extends Error {
  readonly step: string;
  constructor(step: string, exitCode: number) {
    super(`mountShare: '${step}' exited with code ${exitCode}`);
    this.step = step;
  }
}

async function runStep(
  remoteExec: RemoteExec,
  step: string,
  command: string,
  onStep: (message: string) => void,
): Promise<void> {
  onStep(step);
  const { exitCode } = await remoteExec.run(command);
  if (exitCode !== 0) throw new MountShareError(step, exitCode);
}

export async function mountShare(remoteExec: RemoteExec, opts: MountShareOptions): Promise<void> {
  const onStep = opts.onStep ?? (() => {});

  await runStep(remoteExec, 'install cifs-utils', 'sudo apt-get install -y cifs-utils', onStep);

  const suffix = randomBytes(8).toString('hex');
  const localTempPath = join(tmpdir(), `susentorno-share-cred-${suffix}`);
  const remoteTempFilename = `.susentorno-share-cred-${suffix}`;
  const remoteTempPath = `~/${remoteTempFilename}`;
  const remoteHomeTempPath = `"$HOME/${remoteTempFilename}"`;
  writeFileSync(localTempPath, `username=${opts.accountName}\npassword=${opts.password}\n`, {
    mode: 0o600,
  });
  try {
    onStep('copy credentials file');
    const { exitCode: copyExitCode } = await remoteExec.copyFile(localTempPath, remoteTempPath);
    if (copyExitCode !== 0) throw new MountShareError('copy credentials file', copyExitCode);

    await runStep(
      remoteExec,
      'install credentials file',
      `sudo install -m 600 -o root -g root ${remoteHomeTempPath} /etc/susentorno-share.cred; ` +
        `install_exit=$?; rm -f ${remoteHomeTempPath}; exit $install_exit`,
      onStep,
    );
  } finally {
    rmSync(localTempPath, { force: true });
  }

  const mountPoint = `/mnt/${opts.shareName}`;
  await runStep(
    remoteExec,
    'create mount point',
    `sudo mkdir -p ${quoteForRemoteShell(mountPoint)}`,
    onStep,
  );
  await runStep(
    remoteExec,
    'update fstab',
    buildFstabReplaceCommand({ shareName: opts.shareName, hostIp: opts.hostIp }),
    onStep,
  );

  // `mount -a` only mounts fstab entries that aren't already active — it does
  // not notice a mount point whose *source* changed while still mounted (the
  // exact case after isolation re-points this mount at a different host IP).
  // Distinguish "not mounted" (skip straight to mount -a) from "mounted but
  // failed to unmount" (stop — a `;`-joined umount;mount-a would let a real
  // unmount failure pass silently into mount -a, which would then skip the
  // still-active stale mount and wrongly report success).
  onStep('check active mount');
  const { exitCode: mountpointExitCode } = await remoteExec.run(
    `mountpoint -q ${quoteForRemoteShell(mountPoint)}`,
  );
  if (mountpointExitCode === 0) {
    await runStep(
      remoteExec,
      'unmount stale mount',
      `sudo umount ${quoteForRemoteShell(mountPoint)}`,
      onStep,
    );
  }
  await runStep(remoteExec, 'mount share', 'sudo systemctl daemon-reload && sudo mount -a', onStep);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/mountShare.test.ts tests/unit/guestSetup/fstabLine.test.ts`
Expected: PASS (13 tests total: 10 in mountShare.test.ts, 3 in fstabLine.test.ts)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/mountShare.ts src/guestSetup/fstabLine.ts tests/unit/guestSetup/mountShare.test.ts tests/unit/guestSetup/fstabLine.test.ts
git commit -m "fix(guest-setup): unmount a stale active mount before remounting; generalize mountShare's host-IP option"
```

---

## Task 10: `kvpDaemon`

**Files:**

- Create: `src/guestSetup/kvpDaemon.ts`
- Test: `tests/unit/guestSetup/kvpDaemon.test.ts`

**Interfaces:**

- Consumes: `RemoteExec` from the existing `src/guestSetup/remoteExec.ts`; `quoteForRemoteShell`.
- Produces:
  ```typescript
  export const KVP_DAEMON_PACKAGE: string;
  export class EnsureKvpDaemonError extends Error {
    readonly exitCode: number;
  }
  export function ensureKvpDaemon(remoteExec: RemoteExec, onStep?: (message: string) => void): Promise<void>;
  ```

`(Get-VMNetworkAdapter -VMName <name>).IPAddresses` (used throughout `hyperVQueries.ts`/`vmReconcile.ts`) is populated by the guest's Hyper-V Data Exchange (KVP) daemon, a userspace package not installed on a stock Ubuntu Server image. This installs it, the same guaranteed-not-assumed way `mountShare` already installs `cifs-utils`. `KVP_DAEMON_PACKAGE` defaults to `hv-kvp-daemon-init` (the modern init-based package cited by Ubuntu's `hv_kvp_daemon` manpage and Microsoft's Hyper-V IP-discovery troubleshooting doc, both referenced by the spec) — confirm this against the exact Ubuntu LTS version `setup-guest.md` targets during the manual verification pass (Task 13's checklist has a line item for this) before relying on it in production.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/kvpDaemon.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import {
  ensureKvpDaemon,
  EnsureKvpDaemonError,
  KVP_DAEMON_PACKAGE,
} from '../../../src/guestSetup/kvpDaemon';

describe('ensureKvpDaemon', () => {
  it('installs the KVP daemon package', async () => {
    const calls: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        calls.push(command);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('ensureKvpDaemon should never call copyFile');
      },
    };
    await ensureKvpDaemon(remoteExec);
    expect(calls).toEqual([`sudo apt-get install -y '${KVP_DAEMON_PACKAGE}'`]);
  });

  it('reports the step before running it', async () => {
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('unused');
      },
    };
    await ensureKvpDaemon(remoteExec, (message) => events.push(`step:${message}`));
    expect(events[0]).toBe(`step:install ${KVP_DAEMON_PACKAGE}`);
    expect(events[1]).toBe(`run:sudo apt-get install -y '${KVP_DAEMON_PACKAGE}'`);
  });

  it('throws EnsureKvpDaemonError on a non-zero exit', async () => {
    const remoteExec: RemoteExec = {
      async run(): Promise<RemoteExecResult> {
        return { exitCode: 1 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('unused');
      },
    };
    await expect(ensureKvpDaemon(remoteExec)).rejects.toThrow(EnsureKvpDaemonError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/kvpDaemon.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/kvpDaemon.ts`:

```typescript
import type { RemoteExec } from './remoteExec';
import { quoteForRemoteShell } from './quoteForRemoteShell';

// Candidates seen for the Hyper-V Data Exchange (KVP) daemon on Ubuntu LTS
// releases: 'hv-kvp-daemon-init' and 'linux-cloud-tools-virtual'. This is the
// modern init-based package cited by Ubuntu's hv_kvp_daemon manpage and
// Microsoft's Hyper-V IP-discovery troubleshooting doc — confirm it against
// the specific Ubuntu LTS version setup-guest.md targets (e.g. `apt-cache
// search kvp` on a scratch guest) during manual verification before relying
// on it in production; see the manual-verification checklist.
export const KVP_DAEMON_PACKAGE = 'hv-kvp-daemon-init';

export class EnsureKvpDaemonError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`ensureKvpDaemon: install exited with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/**
 * Guarantees the KVP daemon package is installed, the same way mountShare
 * guarantees cifs-utils — a stock Ubuntu Server image doesn't ship it, and
 * without it (Get-VMNetworkAdapter -VMName <name>).IPAddresses never reports
 * an address, breaking Hyper-V-based guest discovery for the rest of this
 * run and every rerun after it.
 */
export async function ensureKvpDaemon(
  remoteExec: RemoteExec,
  onStep?: (message: string) => void,
): Promise<void> {
  const step = onStep ?? (() => {});
  step(`install ${KVP_DAEMON_PACKAGE}`);
  const { exitCode } = await remoteExec.run(
    `sudo apt-get install -y ${quoteForRemoteShell(KVP_DAEMON_PACKAGE)}`,
  );
  if (exitCode !== 0) throw new EnsureKvpDaemonError(exitCode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/kvpDaemon.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/kvpDaemon.ts tests/unit/guestSetup/kvpDaemon.test.ts
git commit -m "feat(guest-setup): add ensureKvpDaemon"
```

---

## Task 11: Generalize script listing and add `runPostScripts`

**Files:**

- Create: `src/guestSetup/listScripts.ts` (replaces `src/guestSetup/listPreScripts.ts`)
- Delete: `src/guestSetup/listPreScripts.ts`
- Create: `tests/unit/guestSetup/listScripts.test.ts` (replaces `tests/unit/guestSetup/listPreScripts.test.ts`)
- Delete: `tests/unit/guestSetup/listPreScripts.test.ts`
- Modify: `src/guestSetup/runPreScripts.ts`
- Modify: `tests/unit/guestSetup/runPreScripts.test.ts`
- Create: `src/guestSetup/runPostScripts.ts`
- Test: `tests/unit/guestSetup/runPostScripts.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export interface GuestScript {
    path: string;
    filename: string;
    slug: string;
  }
  export function listScripts(dir: string): GuestScript[];

  export interface RunPostScriptsOptions {
    scripts: GuestScript[];
    shareName: string;
    onStep?: (message: string) => void;
  }
  export class RunPostScriptsError extends Error {
    readonly script: string;
  }
  export function runPostScripts(remoteExec: RemoteExec, opts: RunPostScriptsOptions): Promise<void>;
  ```
- `runPreScripts`'s own exported signature (`RunPreScriptsOptions`, `RunPreScriptsError`, `runPreScripts`) is unchanged — only its internal `PreScript`/`listPreScripts` import becomes `GuestScript`/`listScripts`.

`listPreScripts` becomes directory-agnostic `listScripts` — `post-scripts/` uses the exact same numeric-prefix-ordering rule as `pre-scripts/`, so this removes the would-be duplication rather than writing a second identical directory-listing function. `runPostScripts` is `runPreScripts` minus the `configure-network` argument special case: no built-in or documented custom post-script takes an argument.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guestSetup/listScripts.test.ts` (same tests as the file it replaces, renamed):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listScripts } from '../../../src/guestSetup/listScripts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'list-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function touch(name: string) {
  writeFileSync(join(dir, name), '');
}

describe('listScripts', () => {
  it('returns scripts in numeric-prefix order with the extension-stripped slug', () => {
    touch('02-install-pnpm.sh');
    touch('01-apt-packages.sh');
    touch('05-configure-network.sh');
    const scripts = listScripts(dir);
    expect(scripts.map((s) => s.filename)).toEqual([
      '01-apt-packages.sh',
      '02-install-pnpm.sh',
      '05-configure-network.sh',
    ]);
    expect(scripts.map((s) => s.slug)).toEqual([
      'apt-packages',
      'install-pnpm',
      'configure-network',
    ]);
    expect(scripts[0].path).toBe(join(dir, '01-apt-packages.sh'));
  });

  it('ignores files that are not NN-name.sh', () => {
    touch('01-apt-packages.sh');
    touch('README.md');
    touch('nn-configure-network.sh'); // unwoven sentinel form — should not appear
    touch('1-bad.sh'); // single-digit prefix
    const scripts = listScripts(dir);
    expect(scripts.map((s) => s.filename)).toEqual(['01-apt-packages.sh']);
  });

  it('returns an empty array for a directory with no matching scripts', () => {
    touch('README.md');
    expect(listScripts(dir)).toEqual([]);
  });

  it('works identically for a post-scripts-shaped directory (no built-in argument convention differs)', () => {
    touch('01-auth-config.sh');
    touch('02-apply-home-jq-transforms.sh');
    expect(listScripts(dir).map((s) => s.slug)).toEqual([
      'auth-config',
      'apply-home-jq-transforms',
    ]);
  });
});
```

Delete `tests/unit/guestSetup/listPreScripts.test.ts` and `src/guestSetup/listPreScripts.ts`.

In `tests/unit/guestSetup/runPreScripts.test.ts`, change only the import line from:

```typescript
import type { PreScript } from '../../../src/guestSetup/listPreScripts';
```

to:

```typescript
import type { GuestScript } from '../../../src/guestSetup/listScripts';
```

and change the local `script()` helper's return type annotation from `PreScript` to `GuestScript` (its body is unchanged). No other line in that file changes — `runPreScripts`'s behavior and exported names are untouched.

Create `tests/unit/guestSetup/runPostScripts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import type { GuestScript } from '../../../src/guestSetup/listScripts';
import { runPostScripts, RunPostScriptsError } from '../../../src/guestSetup/runPostScripts';

function script(filename: string, slug: string): GuestScript {
  return { path: `/local/${filename}`, filename, slug };
}

function fakeRemoteExec(exitCodeFor: (command: string) => number = () => 0): {
  remoteExec: RemoteExec;
  calls: string[];
} {
  const calls: string[] = [];
  const remoteExec: RemoteExec = {
    async run(command: string): Promise<RemoteExecResult> {
      calls.push(command);
      return { exitCode: exitCodeFor(command) };
    },
    async copyFile(): Promise<RemoteExecResult> {
      throw new Error('runPostScripts should never call copyFile');
    },
  };
  return { remoteExec, calls };
}

describe('runPostScripts', () => {
  it('runs every script in order from the share post-scripts directory, with no arguments', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPostScripts(remoteExec, {
      scripts: [script('01-auth-config.sh', 'auth-config'), script('02-apply-home-jq-transforms.sh', 'apply-home-jq-transforms')],
      shareName: 'vm-shared-linux',
    });
    expect(calls).toEqual([
      "cd '/mnt/vm-shared-linux/post-scripts' && './01-auth-config.sh'",
      "cd '/mnt/vm-shared-linux/post-scripts' && './02-apply-home-jq-transforms.sh'",
    ]);
  });

  it('quotes a script filename containing shell metacharacters', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPostScripts(remoteExec, {
      scripts: [script('03-a b;c.sh', 'a b;c')],
      shareName: 'vm-shared-linux',
    });
    expect(calls).toEqual(["cd '/mnt/vm-shared-linux/post-scripts' && './03-a b;c.sh'"]);
  });

  it('stops at the first non-zero exit and reports which script failed', async () => {
    const { remoteExec, calls } = fakeRemoteExec((command) =>
      command.includes('02-apply-home-jq-transforms.sh') ? 1 : 0,
    );
    await expect(
      runPostScripts(remoteExec, {
        scripts: [
          script('01-auth-config.sh', 'auth-config'),
          script('02-apply-home-jq-transforms.sh', 'apply-home-jq-transforms'),
        ],
        shareName: 'vm-shared-linux',
      }),
    ).rejects.toThrow(RunPostScriptsError);
    expect(calls).toHaveLength(2);
  });

  it('reports each script to onStep immediately before running it, interleaved in order', async () => {
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('runPostScripts should never call copyFile');
      },
    };
    await runPostScripts(remoteExec, {
      scripts: [script('01-auth-config.sh', 'auth-config'), script('02-apply-home-jq-transforms.sh', 'apply-home-jq-transforms')],
      shareName: 'vm-shared-linux',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events).toEqual([
      'step:running 01-auth-config.sh',
      "run:cd '/mnt/vm-shared-linux/post-scripts' && './01-auth-config.sh'",
      'step:running 02-apply-home-jq-transforms.sh',
      "run:cd '/mnt/vm-shared-linux/post-scripts' && './02-apply-home-jq-transforms.sh'",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/guestSetup/listScripts.test.ts tests/unit/guestSetup/runPreScripts.test.ts tests/unit/guestSetup/runPostScripts.test.ts`
Expected: FAIL — `listScripts` module doesn't exist yet, `runPreScripts.test.ts` fails to resolve the new import, `runPostScripts` module doesn't exist yet.

- [ ] **Step 3: Write the implementations**

Create `src/guestSetup/listScripts.ts`:

```typescript
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GuestScript {
  path: string;
  filename: string;
  slug: string;
}

// Matches the woven output shape update-shares always produces: a two-digit
// prefix, a hyphen, and a .sh extension (see src/weaveScripts.ts's renumber(),
// which builds output names as `${NN}-${remainder}` and always uses '-'). The
// same rule applies to pre-scripts/ and post-scripts/ directories alike.
const SCRIPT_NAME_RE = /^(\d{2})-(.+)\.sh$/;

export function listScripts(dir: string): GuestScript[] {
  return readdirSync(dir)
    .filter((name) => SCRIPT_NAME_RE.test(name))
    .sort()
    .map((filename) => {
      const match = SCRIPT_NAME_RE.exec(filename)!;
      return { path: join(dir, filename), filename, slug: match[2] };
    });
}
```

In `src/guestSetup/runPreScripts.ts`, change only the import:

```typescript
import type { RemoteExec } from './remoteExec';
import type { GuestScript } from './listScripts';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RunPreScriptsOptions {
  scripts: GuestScript[];
  shareName: string;
  internalSwitchHostIp: string;
  onStep?: (message: string) => void;
}
```

(Everything else in `runPreScripts.ts` — the class, the constant, the function body — is unchanged.)

Create `src/guestSetup/runPostScripts.ts`:

```typescript
import type { RemoteExec } from './remoteExec';
import type { GuestScript } from './listScripts';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RunPostScriptsOptions {
  scripts: GuestScript[];
  shareName: string;
  onStep?: (message: string) => void;
}

export class RunPostScriptsError extends Error {
  readonly script: string;
  constructor(script: string, exitCode: number) {
    super(`runPostScripts: '${script}' exited with code ${exitCode}`);
    this.script = script;
  }
}

export async function runPostScripts(
  remoteExec: RemoteExec,
  opts: RunPostScriptsOptions,
): Promise<void> {
  const onStep = opts.onStep ?? (() => {});
  const remoteDir = `/mnt/${opts.shareName}/post-scripts`;
  for (const script of opts.scripts) {
    const scriptPath = quoteForRemoteShell(`./${script.filename}`);
    const command = `cd ${quoteForRemoteShell(remoteDir)} && ${scriptPath}`;
    onStep(`running ${script.filename}`);
    const { exitCode } = await remoteExec.run(command);
    if (exitCode !== 0) throw new RunPostScriptsError(script.filename, exitCode);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/listScripts.test.ts tests/unit/guestSetup/runPreScripts.test.ts tests/unit/guestSetup/runPostScripts.test.ts`
Expected: PASS (4 + 6 + 4 = 14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/listScripts.ts src/guestSetup/runPreScripts.ts src/guestSetup/runPostScripts.ts tests/unit/guestSetup/listScripts.test.ts tests/unit/guestSetup/runPreScripts.test.ts tests/unit/guestSetup/runPostScripts.test.ts
git rm src/guestSetup/listPreScripts.ts tests/unit/guestSetup/listPreScripts.test.ts
git commit -m "feat(guest-setup): generalize listPreScripts to listScripts and add runPostScripts"
```

---

## Task 12: Rewrite `setup-guest-unix` to run the full idempotent flow

**Files:**

- Modify: `src/commands/setupGuestUnix.ts`

**Interfaces:**

- Consumes: everything produced by Tasks 1–11 — `isElevated`/`createRealPowerShellExec` (Task 2), `runPreflightChecks` (Task 8), `reconcileVmToSwitch`/`isolateVmToSwitch`/`VmReconcileError` (Task 5), `waitForReachable`/`realTcpConnect` (Task 7), `getVmIpAddresses` (Task 3), `ensureKvpDaemon`/`EnsureKvpDaemonError` (Task 10), `mountShare`/`MountShareError` (Task 9, with the renamed `hostIp` option), `runPreScripts`/`RunPreScriptsError` (existing, updated import in Task 11), `checkRunHostingReady` (Task 6), `runPostScripts`/`RunPostScriptsError`/`listScripts` (Task 11). Also the existing, unchanged `resolveGuestNetwork`, `requireEnvPathsOrExit`, `promptText`/`promptMasked`, `createSshRemoteExec`.
- Produces (unchanged export surface, behavior rewritten):
  ```typescript
  export interface ResolvedGuestNetwork {
    internalSwitchHostIp: string;
    defaultSwitchHostIp: string;
  }
  export interface GuestNetworkResolutionFailure {
    adapterAlias: string;
    hint: string;
  }
  export function resolveGuestNetwork(...): ResolvedGuestNetwork | GuestNetworkResolutionFailure;
  export function registerSetupGuestUnix(program: Command): void;
  ```

**A critical detail this task must get right — address discovery across the run:** the SSH target used for steps 1–4 (`ensureKvpDaemon`, both calls' worth of `mountShare` — no, just the first — and `runPreScripts`) is **not** always the raw prompted address. It's whichever address step 1's reachability wait actually confirmed reachable (which may be the prompted address, or a Hyper-V-discovered one, whichever won the race) — **except** on the fast no-op branch (`reconcileVmToSwitch` returns `{ started: false }`, meaning the VM was already `Running` on the correct switch and no `Start-VM` happened), where no wait runs at all and the prompted address is used directly, matching today's existing pre-isolation-feature behavior for that case. Steps 6–7 (the second `mountShare` call, `runPostScripts`) use whichever address step 5's Hyper-V-only reachability wait confirmed — never the prompt, since no prompted address is valid on the Internal-switch network at all. Two separate `RemoteExec` instances are therefore created: one after step 1's address is settled, one after step 5's.

- [ ] **Step 1: Update the command's registration and full action body**

Replace the entire contents of `src/commands/setupGuestUnix.ts`:

```typescript
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import {
  resolveForwardListenAddress,
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
} from '../runHosting/forwarder';
import { promptText, promptMasked } from '../cliPrompt';
import { listScripts } from '../guestSetup/listScripts';
import { createSshRemoteExec } from '../guestSetup/remoteExec';
import { mountShare, MountShareError } from '../guestSetup/mountShare';
import { runPreScripts, RunPreScriptsError } from '../guestSetup/runPreScripts';
import { runPostScripts, RunPostScriptsError } from '../guestSetup/runPostScripts';
import { ensureKvpDaemon, EnsureKvpDaemonError } from '../guestSetup/kvpDaemon';
import { createRealPowerShellExec } from '../guestSetup/powerShellExec';
import { isElevated } from '../guestSetup/elevationCheck';
import { runPreflightChecks } from '../guestSetup/preflightChecks';
import { checkRunHostingReady } from '../guestSetup/runHostingReadiness';
import {
  reconcileVmToSwitch,
  isolateVmToSwitch,
  VmReconcileError,
  type VmReconcileDeps,
} from '../guestSetup/vmReconcile';
import { getVmIpAddresses } from '../guestSetup/hyperVQueries';
import { waitForReachable } from '../guestSetup/reachabilityWait';
import { realTcpConnect } from '../guestSetup/tcpConnect';

const DEFAULT_NAT_ADAPTER = 'vEthernet (Default Switch)';

interface SetupGuestUnixOptions {
  adapterAlias: string;
  natAdapterAlias: string;
}

export interface ResolvedGuestNetwork {
  internalSwitchHostIp: string;
  defaultSwitchHostIp: string;
}

export interface GuestNetworkResolutionFailure {
  adapterAlias: string;
  hint: string;
}

export function resolveGuestNetwork(
  adapterAlias: string,
  natAdapterAlias: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): ResolvedGuestNetwork | GuestNetworkResolutionFailure {
  const internalSwitchHostIp = resolveForwardListenAddress(adapterAlias, interfaces);
  if (!internalSwitchHostIp) {
    return { adapterAlias, hint: 'Pass --adapter-alias, or complete setup-machine.md first.' };
  }
  const defaultSwitchHostIp = resolveForwardListenAddress(natAdapterAlias, interfaces);
  if (!defaultSwitchHostIp) {
    return {
      adapterAlias: natAdapterAlias,
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    };
  }
  return { internalSwitchHostIp, defaultSwitchHostIp };
}

function isResolutionFailure(
  result: ResolvedGuestNetwork | GuestNetworkResolutionFailure,
): result is GuestNetworkResolutionFailure {
  return 'hint' in result;
}

const REACHABILITY_TROUBLESHOOTING_HINT =
  "See setup-guest.md's troubleshooting section (the host firewall \"allow node.exe on public networks?\" dialog, etc.).";

export function registerSetupGuestUnix(program: Command): void {
  program
    .command('setup-guest-unix')
    .description(
      "Run the entire Ubuntu guest setup path over SSH and PowerShell: mount this environment's SMB " +
        'share, run pre-scripts/, isolate the guest onto the Internal switch, re-mount the share there, ' +
        'and run post-scripts/. Requires an elevated (Administrator) PowerShell/terminal. A failed run is ' +
        'safe to retry — every step reruns from the top — but a woven-in custom pre-/post-script must be ' +
        'idempotent itself for that retry to be safe.',
    )
    .option('--adapter-alias <name>', 'Internal-switch adapter', DEFAULT_INTERNAL_SWITCH_ADAPTER)
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .action(async (options: SetupGuestUnixOptions) => {
      const exec = createRealPowerShellExec();
      if (!(await isElevated(exec))) {
        console.error(
          'setup-guest-unix: this command requires an elevated (Administrator) PowerShell/terminal — re-run it from one.',
        );
        process.exitCode = 1;
        return;
      }

      const paths = requireEnvPathsOrExit('setup-guest-unix');
      if (!paths) return;

      const resolved = resolveGuestNetwork(options.adapterAlias, options.natAdapterAlias);
      if (isResolutionFailure(resolved)) {
        console.error(
          `setup-guest-unix: could not find an IPv4 address on adapter '${resolved.adapterAlias}'. ${resolved.hint}`,
        );
        process.exitCode = 1;
        return;
      }
      const { internalSwitchHostIp, defaultSwitchHostIp } = resolved;

      const vmName = await promptText('Hyper-V VM name');

      const preflight = await runPreflightChecks({
        exec,
        vmName,
        adapterAlias: options.adapterAlias,
        natAdapterAlias: options.natAdapterAlias,
        internalSwitchHostIp,
      });
      if (!preflight.ok) {
        console.error(`setup-guest-unix: ${preflight.message}`);
        process.exitCode = 1;
        return;
      }
      const { defaultSwitchName, internalSwitchName } = preflight;

      const address = await promptText('Guest address (hostname or IP)');
      const username = await promptText('Guest username');
      const shareName = await promptText('SMB share name', 'vm-shared-linux');
      const accountName = await promptText('Share account name', 'susentorno-share');
      const password = await promptMasked('SMB share password');

      const preScripts = listScripts(join(paths.vmShared, 'pre-scripts'));
      const postScripts = listScripts(join(paths.vmShared, 'post-scripts'));
      const onStep = (message: string) => console.log(`\nsetup-guest-unix: ${message}...\n`);
      const onProgress = (elapsedMs: number) =>
        console.log(
          `setup-guest-unix: waiting for guest to become reachable... (${Math.round(elapsedMs / 1000)}s elapsed)`,
        );
      const vmReconcileDeps: VmReconcileDeps = { exec, vmName };

      try {
        console.log(`setup-guest-unix: reconciling '${vmName}' to '${defaultSwitchName}'...`);
        const reconcileOutcome = await reconcileVmToSwitch(vmReconcileDeps, defaultSwitchName);

        let setupAddress: string;
        if (reconcileOutcome.started) {
          const setupReachability = await waitForReachable({
            getCandidates: async () => [address, ...(await getVmIpAddresses(exec, vmName))],
            connect: realTcpConnect,
            onProgress,
          });
          if (!setupReachability.reachable) {
            console.error(
              `setup-guest-unix: guest did not become reachable on port 22. ${REACHABILITY_TROUBLESHOOTING_HINT}`,
            );
            process.exitCode = 1;
            return;
          }
          setupAddress = setupReachability.address;
        } else {
          // No power/network event happened — the guest was already Running
          // on the target switch, so the address the user just typed is
          // still assumed valid; no reachability wait is needed.
          setupAddress = address;
        }

        const remoteExec = createSshRemoteExec({ address: setupAddress, username });

        await ensureKvpDaemon(remoteExec, onStep);

        await mountShare(remoteExec, {
          shareName,
          accountName,
          password,
          hostIp: defaultSwitchHostIp,
          onStep,
        });
        await runPreScripts(remoteExec, { scripts: preScripts, shareName, internalSwitchHostIp, onStep });

        const readiness = await checkRunHostingReady(exec, internalSwitchHostIp);
        if (!readiness.dhcpBound || !readiness.dnsBound) {
          console.error(
            `setup-guest-unix: run-hosting is no longer listening on ${internalSwitchHostIp} — ` +
              `start 'susentorno run-hosting' and rerun.`,
          );
          process.exitCode = 1;
          return;
        }

        console.log(`setup-guest-unix: isolating '${vmName}' to '${internalSwitchName}'...`);
        await isolateVmToSwitch(vmReconcileDeps, internalSwitchName);

        const isolatedReachability = await waitForReachable({
          getCandidates: () => getVmIpAddresses(exec, vmName),
          connect: realTcpConnect,
          onProgress,
        });
        if (!isolatedReachability.reachable) {
          console.error(
            `setup-guest-unix: guest did not become reachable on port 22 after isolation. ${REACHABILITY_TROUBLESHOOTING_HINT}`,
          );
          process.exitCode = 1;
          return;
        }

        const isolatedRemoteExec = createSshRemoteExec({
          address: isolatedReachability.address,
          username,
        });

        await mountShare(isolatedRemoteExec, {
          shareName,
          accountName,
          password,
          hostIp: internalSwitchHostIp,
          onStep,
        });
        await runPostScripts(isolatedRemoteExec, { scripts: postScripts, shareName, onStep });
      } catch (error) {
        if (
          error instanceof MountShareError ||
          error instanceof RunPreScriptsError ||
          error instanceof RunPostScriptsError ||
          error instanceof EnsureKvpDaemonError ||
          error instanceof VmReconcileError
        ) {
          console.error(`setup-guest-unix: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      console.log('setup-guest-unix: isolation and post-scripts/ completed on the guest.');
    });
}
```

Note: `tests/unit/commands/setupGuestUnix.test.ts` needs no changes — it only exercises the option surface and `resolveGuestNetwork`, both unchanged. The rewritten action body itself is not independently unit tested: like `run-hosting`'s action in `src/commands/runHosting.ts`, it's orchestration glue over already-unit-tested pieces (Tasks 1–11), wiring in real factories (`createRealPowerShellExec`, `createSshRemoteExec`) that this codebase has no established mocking pattern for. Its correctness — especially the two-`RemoteExec` address handling above — is verified by the manual checklist in Task 13.

- [ ] **Step 2: Typecheck and run the full unit suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS — no type errors, and every existing and new unit test (including `tests/unit/commands/setupGuestUnix.test.ts`, unaffected by this task) passes.

- [ ] **Step 3: Run lint and format checks**

Run: `pnpm lint && pnpm format:check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/setupGuestUnix.ts
git commit -m "feat: extend setup-guest-unix to isolate the guest and run post-scripts/"
```

---

## Task 13: Documentation — `setup-guest.md`, the manual-verification checklist, and `testing.md`

**Files:**

- Modify: `setup-guest.md`
- Create: `setup-guest-unix-isolation-checklist.md`
- Modify: `testing.md`

- [ ] **Step 1: Rewrite `setup-guest.md`'s Ubuntu path in §2, remove the now-automated Ubuntu bullets in §3**

In `setup-guest.md`, replace the Ubuntu-specific content of "## 2. Configure the guest network and mount the share" — everything from `**Ubuntu guest**` through the closing `</details>` — with:

````markdown
**Ubuntu guest** — leave the interface on **DHCP**; the installer's default configuration is already correct. Install `openssh-server` (there is no network path into the guest before this exists — everything after it is automated):

```bash
sudo apt update -y && sudo apt install -y openssh-server
```

Then, from the Host, in an **elevated (Administrator) PowerShell**, run the environment's setup command. It mounts the share, runs `pre-scripts/`, isolates the guest onto `susentorno-internal`, re-mounts the share there, and runs `post-scripts/` — the entire remaining Ubuntu flow in one command:

```powershell
susentorno setup-guest-unix
```

It prompts for the Hyper-V VM name, the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno-share`), and the share password from setup-environment.md. Before prompting for anything it checks that the terminal is elevated and, once the VM name is given, that the VM exists with exactly one network adapter and that both `susentorno-internal` and `Default Switch` resolve to real Hyper-V switches — a typo or a missing prerequisite fails fast with a specific message rather than partway through.

A few things worth knowing before running it:

- **`run-hosting` must already be running** (and stay running) before and during isolation — the command checks this both before touching the VM and again right before isolating it, but a `run-hosting` that stops mid-run between those two checks (during the potentially multi-minute `pre-scripts/` run) is caught only at the second check.
- **Every rerun of an already-isolated guest briefly reattaches it to the Default Switch** — there's no phase-detection/resume logic, so a rerun always executes all 8 steps from the top, including a round-trip through the internet-facing Default Switch and back. This is expected, not a bug: it's what makes "just rerun the whole command" a safe recovery path after a failure.
- **A graceful-shutdown timeout is a failure, not an auto-forced power-off.** If the guest doesn't reach `Off` within the timeout after a graceful `Stop-VM`, the command stops and asks you to investigate or force-stop it manually — it will not call `Stop-VM -Force` on your behalf, since a stuck shutdown usually means something is genuinely wrong inside the guest.
- **A woven-in custom `pre-scripts/`/`post-scripts/` addition must be safe to rerun**, same as today — every invocation reruns the whole pipeline unconditionally.
- **The command installs a Hyper-V KVP/Data Exchange daemon package** on the guest as part of its own setup (separate from anything `pre-scripts/` itself installs) — this is what lets the command discover the guest's address automatically after isolation, when no prompted address is valid anymore.
- **Four distinct addresses are in play** across this command: the guest's own DHCP lease on the Default Switch, the guest's own (different) DHCP lease on `susentorno-internal`, the Windows host's address on the Default Switch, and the Windows host's address on `susentorno-internal`. If a failure message is unclear about which one it means, this is the ordering to check against.

<details>
<summary>Manual fallback (for diagnosing a failure, or to see exactly what the command does)</summary>

With `openssh-server` installed you can open an ssh shell to make copying and pasting easier:

```
ssh <username>@<vm-name>
```

For the following commands, replace `<the password from setup-environment.md>`. Special characters don't need to be escaped — the heredoc interpreter is only watching for an `EOF`.

**Mount** (during the setup/NAT phase, and again after isolation with the other host IP — see below):

```bash
sudo apt install -y cifs-utils

# Credentials file, readable only by root:
sudo tee /etc/susentorno-share.cred > /dev/null << 'EOF'
username=susentorno-share
password=<the password from setup-environment.md>
EOF
sudo chmod 600 /etc/susentorno-share.cred

sudo mkdir -p /mnt/vm-shared-linux
# /etc/fstab — auto-mounts at boot so the credentials symlink resolves. Use
# the Default-Switch host IP during the NAT phase and the Internal-switch
# host IP afterwards (both from setup-machine.md) — there is no single
# correct value to hardcode here, unlike a specific environment's own doc.
echo '//<host-ip>/vm-shared-linux  /mnt/vm-shared-linux  cifs  ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount  0  0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
```

If the share was already mounted against a different host IP (e.g. rerunning this after isolation), `mount -a` alone won't notice the change — unmount first: `mountpoint -q /mnt/vm-shared-linux && sudo umount /mnt/vm-shared-linux`, then rerun the `daemon-reload && mount -a` line above.

The share then lives at `/mnt/vm-shared-linux`. `cd` into `pre-scripts/` and run every script in number order; the last is `05-configure-network.sh <host-ip>` when there are no custom scripts, where `<host-ip>` is the Internal-switch host IP from setup-machine.md.

**Isolate** — confirm the host firewall is open and `run-hosting` is running (both from `setup-machine.md`/`setup-environment.md`), then see "Isolate" in §4 below for the `Stop-VM`/`Connect-VMNetworkAdapter`/`Start-VM` sequence. Wait for the guest to come back up, then redo the mount step above with the Internal-switch host IP.

**Post-scripts** — `cd` into `post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.

Before installing anything else, the automated command also installs a Hyper-V KVP/Data Exchange daemon package (`hv-kvp-daemon-init` at the time of writing — see `src/guestSetup/kvpDaemon.ts`) so `Get-VMNetworkAdapter`'s reported IP addresses work; if reproducing this by hand for diagnosis, `sudo apt-get install -y hv-kvp-daemon-init` is that step.

</details>
````

Then, in "## 3. Run the numbered scripts", replace the entire Ubuntu bullet block (the `**Ubuntu**` paragraph and its three numbered sub-items, including today's duplicated "Isolate the VM's network... then reboot" lines) with:

```markdown
**Ubuntu** — the Host-side `susentorno setup-guest-unix` command already did all of this: mounted the share, ran `pre-scripts/`, isolated the guest, re-mounted the share, and ran `post-scripts/`. Nothing further is needed here — see the manual fallback above if you need to reproduce or diagnose any individual step.
```

Leave the Windows-guest content in both §2 and §3, and all of §1 and §4, unchanged — Windows automation and VM creation are both out of scope.

- [ ] **Step 2: Create the manual-verification checklist**

Create `setup-guest-unix-isolation-checklist.md`:

```markdown
# `setup-guest-unix` isolation manual-verification checklist

`tests/guest/`'s QEMU-in-WSL2 harness (see [ADR-0010](docs/adr/0010-vm-tests-via-qemu-in-wsl2.md)) doesn't run under Hyper-V, so it cannot exercise VM stop/reassign/start, the elevation check, or the `run-hosting` readiness check against a real adapter. This checklist covers that gap against a real Hyper-V host and a real Ubuntu guest, the same spirit as ADR-0010's other manual-checkpoint callouts. Run it once per change to `src/guestSetup/vmReconcile.ts`, `hyperVQueries.ts`, `hyperVOperations.ts`, `preflightChecks.ts`, `reachabilityWait.ts`, `kvpDaemon.ts`, or `src/commands/setupGuestUnix.ts`.

Prerequisites: a scratch Ubuntu guest per setup-guest.md §1 with `openssh-server` installed, an elevated PowerShell terminal, `run-hosting` running.

- [ ] **KVP daemon package name.** Confirm `hv-kvp-daemon-init` (`src/guestSetup/kvpDaemon.ts`'s `KVP_DAEMON_PACKAGE`) actually exists and installs cleanly on the exact Ubuntu LTS version setup-guest.md targets (`apt-cache search kvp` on the scratch guest as a cross-check). Update the constant if not.
- [ ] **Fresh guest end-to-end.** Run `setup-guest-unix` against a guest that has never run it before. Confirm: the KVP daemon installs; `(Get-VMNetworkAdapter -VMName <name>).IPAddresses` starts reporting an address once it's up; the share mounts against the Default-Switch host IP; every `pre-scripts/` script runs in order; isolation happens; the share re-mounts against the Internal-switch host IP; every `post-scripts/` script runs in order; the command exits 0.
- [ ] **Full rerun of an already-completed guest.** Run it again against the guest from the previous step. Confirm it reattaches to the Default Switch, redoes every step, and completes successfully — and that the guest briefly loses Internet access during the round-trip, as documented.
- [ ] **`run-hosting` not running at step 0.** Stop `run-hosting`, run the command, confirm it fails fast at the pre-flight check with a clear message before touching the VM.
- [ ] **`run-hosting` stopped mid-`pre-scripts/`.** Start the command, stop `run-hosting` partway through `pre-scripts/`, confirm the step-4 re-check catches it before isolation.
- [ ] **Graceful-shutdown timeout.** Simulate a stuck shutdown (e.g. a guest process ignoring ACPI shutdown) and confirm the command fails with a clear message rather than force-stopping the VM.
- [ ] **VM left `Off` on the wrong switch from an interrupted prior run.** Manually leave the VM `Off` and attached to `susentorno-internal`, then run the command; confirm step 1's reconciliation correctly reconnects to `Default Switch` and starts it.
- [ ] **Elevation check.** Run the command from a non-elevated terminal; confirm it fails immediately with the elevation message, before any prompt.
- [ ] **Final state.** After a full successful run, confirm on the guest: the adapter is on `susentorno-internal`; `/etc/fstab`'s mount source is the Internal-switch host IP; `mount` shows the share actually mounted from that IP (not just the fstab line updated); `post-scripts/`'s effects (git identity, `gh auth`, placeholder credentials) are present.
```

- [ ] **Step 3: Link the checklist from `testing.md`**

In `testing.md`, in the `guest` tier's row description (the "What each tier exercises" section's `guest` bullet), add a sentence at the end:

```markdown
- **`guest`** tests make their observations from inside a disposable guest. They generally cross the CLI and proxy stack too, but the guest is the highest exercised surface. The test harness boots QEMU under WSL2; Hyper-V remains the production guest platform and is not the test runtime (see [ADR-0010](docs/adr/0010-vm-tests-via-qemu-in-wsl2.md)). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/guest/<timestamp>/`. Hyper-V-specific behavior this harness cannot exercise (VM stop/reassign/start, the elevation check, the `run-hosting` readiness check) is covered instead by [setup-guest-unix-isolation-checklist.md](setup-guest-unix-isolation-checklist.md), a manual checklist.
```

- [ ] **Step 4: Verify formatting**

Run: `pnpm exec prettier --check setup-guest.md setup-guest-unix-isolation-checklist.md testing.md`
Expected: no formatting errors

- [ ] **Step 5: Commit**

```bash
git add setup-guest.md setup-guest-unix-isolation-checklist.md testing.md
git commit -m "docs: document the automated isolation/post-scripts flow and add its manual-verification checklist"
```

---

## Self-Review Notes

- **Spec coverage**: "New prerequisite: elevation" → Task 2; "New input: VM name" + its validation → Tasks 3, 8, 12; "Guest address discovery across network transitions" (including the KVP-daemon prerequisite) → Tasks 3, 7, 10, 12; "Idempotent top-level flow" (all 8 steps, the reconciliation table, the no-op-branch address handling) → Tasks 4, 5, 12; "Isolation mechanics" (PowerShell quoting, graceful `Stop-VM` + 60s timeout + confirmation poll, `run-hosting` readiness, the TCP reachability wait) → Tasks 1, 2, 5, 6, 7; "Mount step (reused, with one fix)" → Task 9; "Post-scripts execution" (`listScripts` generalization, `runPostScripts`) → Task 11; "Console output for step announcements" (blank-line `onStep` formatting) → Task 12; "Failure handling & idempotency limits" (the built-in-script idempotency audit — `01-auth-config.sh`'s `git config --global`/`ln -sfn`/`mkdir -p` and `02-apply-home-jq-transforms.sh` are all convergent, confirmed by inspection during planning) → reflected in Task 13's checklist and this plan's Global Constraints; "Testing" (unit coverage per module, the manual-verification checklist) → Tasks 1–13 collectively, checklist in Task 13; "Documentation" → Task 13. "Out of scope" items (Windows automation, cross-adapter pre-isolation mounting, a persisted guest registry) have deliberately no task.
- **Placeholder scan**: no TBD/"add error handling"/"similar to Task N" phrasing anywhere; every code step shows complete code. The one open external fact (`KVP_DAEMON_PACKAGE`'s exact value) is not left as a placeholder — it's given a concrete, cited default (`hv-kvp-daemon-init`) plus an explicit verification step in the Task 13 checklist, matching the spec's own framing ("should be confirmed... during implementation, not asserted here").
- **Type/name consistency checked**: `PowerShellExec`/`PowerShellExecResult` (Task 2) are the exact types every later Hyper-V-touching module (Tasks 3–8, 12) consumes. `GuestScript`/`listScripts` (Task 11) match what `runPreScripts.ts` (modified) and `runPostScripts.ts` (new) both import — no stray `PreScript` references remain anywhere after Task 11. `hostIp` (Task 9) is the field name both `mountShare` calls in Task 12 use — no leftover `defaultSwitchHostIp`/`internalSwitchHostIp` field name on `MountShareOptions`. `VmReconcileError`, `EnsureKvpDaemonError`, `RunPostScriptsError` (Tasks 5, 10, 11) are the exact classes Task 12's `catch` block checks. `reconcileVmToSwitch`'s `{ started: boolean }` return (Task 5) is exactly what Task 12 branches on to decide whether step 1's reachability wait runs at all.

## Peer Review Notes

_(Filled in after running the prompt-a-peer-medium review against this plan and the spec.)_

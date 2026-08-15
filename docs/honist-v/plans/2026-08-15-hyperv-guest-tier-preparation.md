# Hyper-V Guest Tier Preparation Implementation Plan

**Goal:** Land the three product changes spec 2 (the real-Hyper-V `guest` tier) depends on — `run-hosting --isolation-name`, `setup-guest-unix` answer flags plus `--isolation-name`, and a trimmed Linux guest template set — per [docs/honist-v/specs/2026-08-15-hyperv-guest-tier-preparation-design.md](../specs/2026-08-15-hyperv-guest-tier-preparation-design.md).

**Architecture:** Both commands gate on conditions a test cannot fake (`isElevated()`, live Hyper-V), so every new decision is pushed into a pure, injectable function that gets a unit test, with the Commander action left as thin glue — the split this codebase already uses across `src/hostNetwork/`, `src/guestSetup/`, and `src/commands/`. `resolveHostNetworkNames` becomes the single authority for the isolation name → switch name → adapter alias mapping, replacing today's opposite-direction `deriveSwitchName(adapterAlias)` recovery on the internal-switch side. The template trim is deletion plus the renumbering fallout it forces.

**Tech Stack:** TypeScript, Commander, Vitest (five tiers: `unit`, `cli`, `host-network`, `proxy-stack`, `guest`), Node's `node:os` `networkInterfaces()`, bash/PowerShell guest templates.

## Global Constraints

- The three phases (Tasks 1–3 = `run-hosting`; Tasks 4–7 = `setup-guest-unix`; Tasks 8–10 = templates) have no implementation dependency on each other. Each task must leave `pnpm test` green on its own — this is a spec requirement, not a preference.
- The existing WSL2 `guest` tier is **not** retired here and must stay green. Retiring it is spec 2's work.
- `templates/vm-shared-windows/` is **untouched** by this changeset, with exactly one deliberate exception: the shared `templates/home-jq-transforms/manifest.yaml` entry deleted in Task 10 carries a `windows:` target, so Windows guests lose the VS Code settings transform too.
- [ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md) is **not** amended by this changeset.
- Isolation-name validation is inherited from `resolveHostNetworkNames` (`src/hostNetwork/hostNetworkNames.ts`), never re-implemented. Both commands catch `HostNetworkError` at the command boundary, print its message, set `process.exitCode = 1`, and return — matching `createHostNetwork.ts:97-104` and `deleteHostNetwork.ts`.
- `node:`-prefixed core imports; flat `tests/unit/**/*.test.ts` layout mirroring `src/`.
- Run `pnpm format && pnpm lint && pnpm typecheck` before every commit. Prettier formats the bash templates too (`prettier-plugin-sh`), so template edits need `pnpm format` as much as `.ts` edits do.
- `tests/cli/**` runs against `dist/cli.js`, so `pnpm build` must precede `pnpm test:cli`.
- The `cli` and `host-network` tiers require an **elevated (Administrator)** terminal; `guest` requires WSL2/KVM; `proxy-stack` requires Docker.

### Spec deviations recorded up front

Two places where this plan does something the spec's prose does not literally say. Both are deliberate.

1. The spec's Verification table says "The new isolation-name resolver in `forwarder.ts`", but section 1 explicitly places it in a **new module** `src/runHosting/isolationNetwork.ts` and argues the import cycle that forces it. Section 1 wins; the table row is stale.
2. `tests/guest/guest.test.ts:230`'s test title already says `06` where the path says `05` — stale before this changeset. Task 9 retitles it to the number-free slug rather than to `04`, which is the same decoupling the spec applies to the script's own log prefixes.

---

## Task 1: `resolveIsolationNetwork` and the shared `create-host-network` hint

**Files:**

- Create: `src/runHosting/isolationNetwork.ts`
- Modify: `src/hostNetwork/hostNetworkNames.ts` (append one exported function)
- Test: `tests/unit/runHosting/isolationNetwork.test.ts`

**Interfaces:**

- Consumes: `resolveHostNetworkNames(isolationName?: string): HostNetworkNames` and `HostNetworkError` (both existing); `resolveInternalSwitchNetwork(adapterName?: string, interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): { address: string; netmask: string } | null` and `DEFAULT_INTERNAL_SWITCH_ADAPTER` from `src/runHosting/forwarder.ts` (both existing).
- Produces:
  ```typescript
  // src/runHosting/isolationNetwork.ts
  export type IsolationNetworkResolution =
    | { found: true; adapterAlias: string; address: string; netmask: string }
    | { found: false; adapterAlias: string };
  export function resolveIsolationNetwork(
    isolationName: string | undefined,
    interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>,
  ): IsolationNetworkResolution;

  // src/hostNetwork/hostNetworkNames.ts
  export function createHostNetworkHint(isolationName?: string): string;
  ```

Why a new module rather than a function in `forwarder.ts`: `hostNetworkNames.ts:2` already imports `DEFAULT_INTERNAL_SWITCH_ADAPTER` from `forwarder.ts`, so a resolver living in `forwarder.ts` that imported `resolveHostNetworkNames` back would create an import cycle. A new module importing both, imported by neither, has none.

`createHostNetworkHint` lives in `hostNetworkNames.ts` because Task 6 needs the identical string in `setup-guest-unix`: the spec requires both commands to fail identically for the same underlying cause.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runHosting/isolationNetwork.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { resolveIsolationNetwork } from '../../../src/runHosting/isolationNetwork';
import {
  createHostNetworkHint,
  HostNetworkError,
} from '../../../src/hostNetwork/hostNetworkNames';

function ipv4(address: string, netmask = '255.255.255.0'): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('resolveIsolationNetwork', () => {
  it('resolves the named isolation network to its derived adapter, address, and netmask', () => {
    expect(
      resolveIsolationNetwork('test', {
        'vEthernet (susentorno-test-internal)': [ipv4('192.168.68.1')],
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1')],
      }),
    ).toEqual({
      found: true,
      adapterAlias: 'vEthernet (susentorno-test-internal)',
      address: '192.168.68.1',
      netmask: '255.255.255.0',
    });
  });

  it('falls back to the unnamed default adapter when no isolation name is given', () => {
    expect(
      resolveIsolationNetwork(undefined, {
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1', '255.255.255.128')],
      }),
    ).toEqual({
      found: true,
      adapterAlias: 'vEthernet (susentorno-internal)',
      address: '192.168.67.1',
      netmask: '255.255.255.128',
    });
  });

  it('reports the alias it looked for when that adapter is absent', () => {
    expect(resolveIsolationNetwork('test', { 'Wi-Fi': [ipv4('10.0.0.5')] })).toEqual({
      found: false,
      adapterAlias: 'vEthernet (susentorno-test-internal)',
    });
  });

  it('reports not-found when the adapter is present with no non-internal IPv4', () => {
    expect(
      resolveIsolationNetwork('test', {
        'vEthernet (susentorno-test-internal)': [
          { ...ipv4('127.0.0.1'), internal: true },
          {
            address: 'fe80::1',
            netmask: 'ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 0,
          } as NetworkInterfaceInfo,
        ],
      }),
    ).toEqual({ found: false, adapterAlias: 'vEthernet (susentorno-test-internal)' });
  });

  it('propagates HostNetworkError for an invalid isolation name', () => {
    expect(() => resolveIsolationNetwork('bad name!', {})).toThrow(HostNetworkError);
    expect(() => resolveIsolationNetwork('bad name!', {})).toThrow(
      'only letters, digits, and hyphens are allowed',
    );
  });
});

describe('createHostNetworkHint', () => {
  it('names the plain command when there is no isolation name', () => {
    expect(createHostNetworkHint()).toBe("Run 'susentorno create-host-network' first.");
  });

  it('echoes the isolation name back so the printed command is the one to run', () => {
    expect(createHostNetworkHint('test')).toBe(
      "Run 'susentorno create-host-network --isolation-name test' first.",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/runHosting/isolationNetwork.test.ts`
Expected: FAIL — `Cannot find module '../../../src/runHosting/isolationNetwork'`, plus `HostNetworkError`/`createHostNetworkHint` not exported from `hostNetworkNames`.

- [ ] **Step 3: Re-export `HostNetworkError` and add `createHostNetworkHint`**

Append to `src/hostNetwork/hostNetworkNames.ts`, and change its `HostNetworkError` import line to also re-export it so callers have one import site for the isolation-name vocabulary:

```typescript
import { HostNetworkError } from './hostNetworkError';

export { HostNetworkError };
```

(replacing the existing `import { HostNetworkError } from './hostNetworkError';` line at the top), then at the end of the file:

```typescript
/**
 * The remedy both `run-hosting` and `setup-guest-unix` print when an isolation
 * name resolves to an adapter that isn't on this host. Shared so the two
 * commands fail identically for the same underlying cause: the overwhelmingly
 * likely one is that `create-host-network` was never run for that name.
 */
export function createHostNetworkHint(isolationName?: string): string {
  const flag = isolationName === undefined ? '' : ` --isolation-name ${isolationName}`;
  return `Run 'susentorno create-host-network${flag}' first.`;
}
```

- [ ] **Step 4: Write `src/runHosting/isolationNetwork.ts`**

```typescript
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { resolveHostNetworkNames } from '../hostNetwork/hostNetworkNames';
import { DEFAULT_INTERNAL_SWITCH_ADAPTER, resolveInternalSwitchNetwork } from './forwarder';

export type IsolationNetworkResolution =
  | { found: true; adapterAlias: string; address: string; netmask: string }
  | { found: false; adapterAlias: string };

/**
 * Turns an optional `--isolation-name` into the one Internal-switch network
 * `run-hosting` should bind: the adapter alias comes from
 * `resolveHostNetworkNames` (which also validates the name, throwing
 * HostNetworkError), and the address and netmask come from a SINGLE
 * `networkInterfaces()` snapshot of that adapter.
 *
 * That single snapshot is the point. Resolving the address and the netmask
 * independently — as run-hosting used to — let the second lookup miss or
 * disagree with the first, at which cost DHCP handed every guest a guessed /24.
 *
 * Lives here rather than in forwarder.ts because hostNetworkNames.ts already
 * imports DEFAULT_INTERNAL_SWITCH_ADAPTER from forwarder.ts; putting this
 * function there would close an import cycle.
 */
export function resolveIsolationNetwork(
  isolationName: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): IsolationNetworkResolution {
  const adapterAlias =
    isolationName === undefined
      ? DEFAULT_INTERNAL_SWITCH_ADAPTER
      : resolveHostNetworkNames(isolationName).adapterAlias;
  const network = resolveInternalSwitchNetwork(adapterAlias, interfaces);
  if (!network) return { found: false, adapterAlias };
  return { found: true, adapterAlias, address: network.address, netmask: network.netmask };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/runHosting/isolationNetwork.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Format, lint, typecheck, and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/runHosting/isolationNetwork.ts src/hostNetwork/hostNetworkNames.ts tests/unit/runHosting/isolationNetwork.test.ts
git commit -m "feat: resolve an isolation name to one Internal-switch network snapshot"
```

---

## Task 2: `run-hosting --isolation-name` replaces `--forward-listen`

**Files:**

- Modify: `src/commands/runHosting.ts` — imports (`:18`), options interface (`:42-56`), flag registration (`:122-125`), the two `if (options.forward)` blocks (`:194-205`, `:222-261`)
- Modify: `tests/unit/commands/runHosting.test.ts`
- Modify: `setup-environment.md:12`
- Modify: `setup-machine.md:9`
- Modify: `docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md:21`

**Interfaces:**

- Consumes: `resolveIsolationNetwork(isolationName, interfaces?)` and `createHostNetworkHint(isolationName?)` from Task 1; `HostNetworkError` from `src/hostNetwork/hostNetworkNames`.
- Produces: the `run-hosting` flag surface `--isolation-name <name>` (present) and `--forward-listen <ip>` (gone). No new exported symbols.

Three things travel together in this task and cannot be separated: removing `--forward-listen`, adding `--isolation-name`, and consolidating the address and netmask onto one `resolveIsolationNetwork` call. The guessed-`/24` fallback at `runHosting.ts:241` is only unreachable once all three land — removing the flag alone does not close it, because the two `networkInterfaces()` snapshots were independent.

- [ ] **Step 1: Write the failing option-surface test**

Replace the first test in `tests/unit/commands/runHosting.test.ts` (`no longer exposes --forward-ports`, lines 6-13) with:

```typescript
  it('exposes neither --forward-ports nor --forward-listen, and does expose --isolation-name', () => {
    const program = new Command();
    registerRunHosting(program);
    const runHostingCommand = program.commands.find((cmd) => cmd.name() === 'run-hosting');
    expect(runHostingCommand).toBeDefined();
    const flags = runHostingCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--forward-ports'))).toBe(false);
    expect(flags.some((f) => f.includes('--forward-listen'))).toBe(false);
    expect(flags.some((f) => f.includes('--isolation-name'))).toBe(true);
    // --no-forward is unchanged by the isolation-name work.
    expect(flags.some((f) => f.includes('--no-forward'))).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/commands/runHosting.test.ts`
Expected: FAIL — `expected true to be false` on the `--forward-listen` assertion.

- [ ] **Step 3: Swap the imports in `src/commands/runHosting.ts`**

Replace line 18:

```typescript
import { resolveForwardListenAddress, resolveInternalSwitchNetwork } from '../runHosting/forwarder';
```

with:

```typescript
import {
  resolveIsolationNetwork,
  type IsolationNetworkResolution,
} from '../runHosting/isolationNetwork';
import { createHostNetworkHint, HostNetworkError } from '../hostNetwork/hostNetworkNames';
```

- [ ] **Step 4: Change the options interface**

In `interface RunHostingOptions` (`:42-56`), replace:

```typescript
  forwardListen?: string;
```

with:

```typescript
  isolationName?: string;
```

- [ ] **Step 5: Swap the flag registration**

Replace the `--forward-listen` option (`:122-125`):

```typescript
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the Hyper-V Internal-switch adapter IP)',
    )
```

with:

```typescript
    .option(
      '--isolation-name <name>',
      'Bind the sandboxed host network created by create-host-network --isolation-name <name> ' +
        'instead of the default one (letters, digits, and hyphens only)',
    )
```

- [ ] **Step 6: Reject `--isolation-name` combined with `--no-forward`**

Inside the main `try {` block (`:157`), as the very first statement — before `requireEnvPathsOrExit`:

```typescript
        // --no-forward disables the gateway's non-loopback listener, the DNS
        // responder, and the DHCP server: the only three consumers of the
        // resolved address. Silently ignoring --isolation-name here would leave
        // a run-hosting that looks configured for a sandbox but is serving the
        // default network, so this fails loudly.
        if (options.isolationName !== undefined && !options.forward) {
          console.error(
            'run-hosting: --isolation-name cannot be combined with --no-forward — ' +
              '--no-forward disables the gateway listener, the DNS responder, and the DHCP ' +
              'server, which are the only consumers of the address --isolation-name selects.',
          );
          process.exitCode = 1;
          return;
        }
```

This sits inside the try/finally, so it speaks the abnormal-exit alert like every other startup validation failure in this action ([ADR-0019](../../adr/0019-run-hosting-speaks-on-abnormal-exit.md) treats an invalid config as a startup failure). It does not need to run before `relaunchIfNeeded`: the conflicting combination requires `--no-forward`, and `createRelaunchDeps(options.forward)` never relaunches when forwarding is off.

- [ ] **Step 7: Resolve one network, once**

Replace the first `if (options.forward)` block (`:193-205`):

```typescript
        const listenAddresses = ['127.0.0.1'];
        if (options.forward) {
          const forwardIp = options.forwardListen ?? resolveForwardListenAddress();
          if (!forwardIp) {
            console.error(
              'run-hosting: could not find the Hyper-V Internal-switch adapter IP to forward from. ' +
                'Pass --forward-listen <ip>, or --no-forward to disable forwarding.',
            );
            process.exitCode = 1;
            return;
          }
          listenAddresses.push(forwardIp);
        }
```

with:

```typescript
        const listenAddresses = ['127.0.0.1'];
        // Non-null exactly when forwarding is on AND the adapter resolved, so it
        // doubles as the guard for the DNS/DHCP block below — one snapshot feeds
        // the gateway's listen address, the DNS answer IP, and the DHCP netmask.
        let internalNetwork: IsolationNetworkResolution | null = null;
        if (options.forward) {
          let resolution: IsolationNetworkResolution;
          try {
            resolution = resolveIsolationNetwork(options.isolationName);
          } catch (err) {
            if (err instanceof HostNetworkError) {
              console.error(`run-hosting: ${err.message}`);
              process.exitCode = 1;
              return;
            }
            throw err;
          }
          if (!resolution.found) {
            console.error(
              `run-hosting: could not find an IPv4 address on adapter '${resolution.adapterAlias}'. ` +
                createHostNetworkHint(options.isolationName),
            );
            process.exitCode = 1;
            return;
          }
          internalNetwork = resolution;
          listenAddresses.push(resolution.address);
        }
```

The `HostNetworkError` catch is required, not stylistic: an escaping throw would land in `installAbnormalExitHandlers`' `uncaughtException` path and report a typo'd flag as a crash.

- [ ] **Step 8: Feed the same snapshot to DNS and DHCP**

Replace the second block's header (`:222-223`):

```typescript
        if (options.forward) {
          const dnsIp = listenAddresses[listenAddresses.length - 1];
```

with:

```typescript
        if (internalNetwork?.found) {
          const dnsIp = internalNetwork.address;
```

and replace the netmask derivation (`:240-241`):

```typescript
          const network = resolveInternalSwitchNetwork();
          const netmask = network?.address === dnsIp ? network.netmask : '255.255.255.0';
```

with:

```typescript
          const netmask = internalNetwork.netmask;
```

The `?.found` narrows the union so `.address`/`.netmask` typecheck without a non-null assertion. Everything else in the block — the DNS bind-failure message at `:234`, the DHCP bind-failure message at `:253`, both `console.log` lines — is unchanged.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm vitest run tests/unit/commands/runHosting.test.ts`
Expected: PASS, 2 tests. `pnpm typecheck` must report no unused-import errors — if `resolveForwardListenAddress`/`resolveInternalSwitchNetwork` are still imported in this file, Step 3 was incomplete.

- [ ] **Step 10: Update the two docs that name the removed flag**

In `setup-environment.md:12`, replace the final sentence:

```
Pass `--no-forward` to disable forwarding, or `--forward-listen <ip>` to override the bind address.
```

with:

```
Pass `--no-forward` to disable forwarding, or `--isolation-name <name>` to bind the sandboxed host network created by `susentorno create-host-network --isolation-name <name>` instead of the default one.
```

In `setup-machine.md:9`, replace:

```
is simultaneously the SMB server address, the `run-hosting --forward-listen` target, and the `<host-ip>` argument
```

with:

```
is simultaneously the SMB server address, the address `run-hosting` forwards from, and the `<host-ip>` argument
```

- [ ] **Step 11: Reword ADR-0019's consequence**

In `docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md:21`, replace:

```
unresolvable forward-listen IP, gateway/DNS/DHCP bind failures, and every failure inside
```

with:

```
an Internal-switch adapter with no resolvable IPv4 address, gateway/DNS/DHCP bind failures, and every failure inside
```

The decision is untouched — that failure mode survives the change (an isolation name can still resolve to no adapter), only the flag that used to be its remedy is gone.

- [ ] **Step 12: Run the full pipeline and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli
git add src/commands/runHosting.ts tests/unit/commands/runHosting.test.ts setup-environment.md setup-machine.md docs/adr/0019-run-hosting-speaks-on-abnormal-exit.md
git commit -m "feat: replace run-hosting --forward-listen with --isolation-name"
```

---

## Task 3: `host-network` tier coverage for alias → real address and netmask

**Files:**

- Modify: `tests/host-network/createDeleteHostNetwork.test.ts`

**Interfaces:**

- Consumes: `resolveIsolationNetwork` from Task 1; the suite's existing `createHostNetwork(...)`, `findFreeSubnet(detectTakenRanges())`, and the `beforeEach`/`afterEach`/`afterAll` `cleanUp()` fixtures.
- Produces: nothing consumed by later tasks.

This is the only exercise of alias-to-real-adapter resolution against Windows rather than a fixture, and specifically the only place the **netmask** half is checked against a real adapter. `create-host-network` assigns `-PrefixLength 24` (`src/hostNetwork/hostNetworkSwitchOps.ts:14`), so the expected netmask is `255.255.255.0`.

**Prerequisite:** this tier needs an elevated (Administrator) PowerShell with Hyper-V available. Confirm before running:

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

Expected: `True`.

- [ ] **Step 1: Write the failing test**

Add to `tests/host-network/createDeleteHostNetwork.test.ts`, inside the existing `describe` block, after the `refreshes rules without recreating the switch...` test:

```typescript
  it('resolves the created switch to a real address and netmask through resolveIsolationNetwork', async () => {
    const subnet = findFreeSubnet(detectTakenRanges())!;
    await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet,
    });

    // The only place the alias-to-real-adapter mapping is exercised against
    // Windows rather than a fixture — and the only check that the netmask
    // run-hosting hands to DHCP is the switch's real one, not a guessed /24.
    expect(resolveIsolationNetwork(ISOLATION_NAME)).toEqual({
      found: true,
      adapterAlias: ADAPTER_ALIAS,
      address: `192.168.${subnet}.1`,
      netmask: '255.255.255.0',
    });
  });
```

and add the import next to the existing `resolveForwardListenAddress` import:

```typescript
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
```

- [ ] **Step 2: Run the tier to verify the new test passes**

Run (elevated): `pnpm test:host-network`
Expected: PASS, 4 tests. This one passes immediately — Task 1's implementation already exists — so its value is regression coverage, not red-green. If it fails with `found: false`, the adapter did not appear before the assertion ran; that is a real product-level finding about `create-host-network`, not a test bug — investigate rather than adding a sleep.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/host-network/createDeleteHostNetwork.test.ts
git commit -m "test: cover isolation-name adapter resolution against real Hyper-V"
```

---

## Task 4: `setup-guest-unix` answer resolution

**Files:**

- Create: `src/guestSetup/setupAnswers.ts`
- Test: `tests/unit/guestSetup/setupAnswers.test.ts`

**Interfaces:**

- Consumes: nothing (fully injected).
- Produces:
  ```typescript
  export interface SetupAnswerPrompts {
    text: (question: string, defaultValue?: string) => Promise<string>;
    masked: (question: string) => Promise<string>;
  }
  export interface SetupAnswerFlags {
    vmName?: string;
    guestAddress?: string;
    guestUsername?: string;
    shareName?: string;
    shareAccount?: string;
  }
  export interface ConnectionAnswers {
    address: string;
    username: string;
    shareName: string;
    accountName: string;
    password: string;
  }
  export function resolveVmNameAnswer(
    flags: SetupAnswerFlags,
    prompts: SetupAnswerPrompts,
  ): Promise<string>;
  export function resolveConnectionAnswers(
    flags: SetupAnswerFlags,
    prompts: SetupAnswerPrompts,
  ): Promise<ConnectionAnswers>;
  ```

Two functions rather than one, because the command gathers answers in **two stages either side of preflight** and that ordering is deliberate: a bad VM name or a missing switch must fail before the user types five more answers. `resolveVmNameAnswer` is stage one (before `runPreflightChecks`), `resolveConnectionAnswers` is stage two (after it succeeds).

The SMB share password is in `ConnectionAnswers` but has no flag and never will: automation answers it by piping one line into stdin, which [ADR-0022](../../adr/0022-promptmasked-releases-stdin-explicitly.md) establishes works against this repo's own `promptMasked`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/setupAnswers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  resolveVmNameAnswer,
  resolveConnectionAnswers,
  type SetupAnswerPrompts,
} from '../../../src/guestSetup/setupAnswers';

/**
 * Records every prompt actually shown, so a test can assert that a flag
 * suppresses ONLY its own prompt. `answers` maps a question to what the user
 * would type; anything unmapped answers with the empty string, which the
 * prompt's own default handling (not this fake) would then replace.
 */
function recordingPrompts(answers: Record<string, string> = {}): {
  prompts: SetupAnswerPrompts;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    prompts: {
      async text(question, defaultValue) {
        asked.push(question);
        return answers[question] ?? defaultValue ?? '';
      },
      async masked(question) {
        asked.push(question);
        return answers[question] ?? '';
      },
    },
  };
}

describe('resolveVmNameAnswer', () => {
  it('prompts for the VM name when --vm-name is absent', async () => {
    const { prompts, asked } = recordingPrompts({ 'Hyper-V VM name': 'ubuntu-dev' });
    expect(await resolveVmNameAnswer({}, prompts)).toBe('ubuntu-dev');
    expect(asked).toEqual(['Hyper-V VM name']);
  });

  it('uses --vm-name without prompting', async () => {
    const { prompts, asked } = recordingPrompts();
    expect(await resolveVmNameAnswer({ vmName: 'ubuntu-dev' }, prompts)).toBe('ubuntu-dev');
    expect(asked).toEqual([]);
  });
});

describe('resolveConnectionAnswers', () => {
  it('prompts for all five answers plus the password, in order, with the documented defaults', async () => {
    const { prompts, asked } = recordingPrompts({
      'Guest address (hostname or IP)': '192.168.67.42',
      'Guest username': 'dev',
      'SMB share password': 'hunter2',
    });
    expect(await resolveConnectionAnswers({}, prompts)).toEqual({
      address: '192.168.67.42',
      username: 'dev',
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
    });
    expect(asked).toEqual([
      'Guest address (hostname or IP)',
      'Guest username',
      'SMB share name',
      'Share account name',
      'SMB share password',
    ]);
  });

  it('uses every flag when every flag is given, and still prompts for the password', async () => {
    const { prompts, asked } = recordingPrompts({ 'SMB share password': 'hunter2' });
    expect(
      await resolveConnectionAnswers(
        {
          guestAddress: '192.168.67.42',
          guestUsername: 'dev',
          shareName: 'vm-shared-custom',
          shareAccount: 'custom-share',
        },
        prompts,
      ),
    ).toEqual({
      address: '192.168.67.42',
      username: 'dev',
      shareName: 'vm-shared-custom',
      accountName: 'custom-share',
      password: 'hunter2',
    });
    expect(asked).toEqual(['SMB share password']);
  });

  it('suppresses only the prompts whose flags were given', async () => {
    const { prompts, asked } = recordingPrompts({
      'Guest username': 'dev',
      'SMB share password': 'hunter2',
    });
    const result = await resolveConnectionAnswers(
      { guestAddress: '192.168.67.42', shareAccount: 'custom-share' },
      prompts,
    );
    expect(result).toEqual({
      address: '192.168.67.42',
      username: 'dev',
      shareName: 'vm-shared-linux',
      accountName: 'custom-share',
      password: 'hunter2',
    });
    expect(asked).toEqual(['Guest username', 'SMB share name', 'SMB share password']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/setupAnswers.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/setupAnswers'`

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/setupAnswers.ts`:

```typescript
export interface SetupAnswerPrompts {
  text: (question: string, defaultValue?: string) => Promise<string>;
  masked: (question: string) => Promise<string>;
}

/** The five answers that have a flag. The SMB share password never does. */
export interface SetupAnswerFlags {
  vmName?: string;
  guestAddress?: string;
  guestUsername?: string;
  shareName?: string;
  shareAccount?: string;
}

export interface ConnectionAnswers {
  address: string;
  username: string;
  shareName: string;
  accountName: string;
  password: string;
}

export const DEFAULT_SHARE_NAME = 'vm-shared-linux';
export const DEFAULT_SHARE_ACCOUNT = 'susentorno-share';

/**
 * Stage one, before runPreflightChecks. Split from the rest deliberately: a bad
 * VM name or a missing switch must fail before the user types five more answers.
 */
export async function resolveVmNameAnswer(
  flags: SetupAnswerFlags,
  prompts: SetupAnswerPrompts,
): Promise<string> {
  return flags.vmName ?? prompts.text('Hyper-V VM name');
}

/**
 * Stage two, only after preflight succeeds. Each flag suppresses ONLY its own
 * prompt; anything absent still prompts, in today's order. There is no
 * all-or-nothing mode. The password is always prompted — never a flag, never a
 * file, never an environment variable; automation pipes one line into stdin
 * (see ADR-0022).
 */
export async function resolveConnectionAnswers(
  flags: SetupAnswerFlags,
  prompts: SetupAnswerPrompts,
): Promise<ConnectionAnswers> {
  const address = flags.guestAddress ?? (await prompts.text('Guest address (hostname or IP)'));
  const username = flags.guestUsername ?? (await prompts.text('Guest username'));
  const shareName =
    flags.shareName ?? (await prompts.text('SMB share name', DEFAULT_SHARE_NAME));
  const accountName =
    flags.shareAccount ?? (await prompts.text('Share account name', DEFAULT_SHARE_ACCOUNT));
  const password = await prompts.masked('SMB share password');
  return { address, username, shareName, accountName, password };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/setupAnswers.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/guestSetup/setupAnswers.ts tests/unit/guestSetup/setupAnswers.test.ts
git commit -m "feat: per-flag answer resolution for setup-guest-unix"
```

---

## Task 5: `runPreflightChecks` takes both internal names from its caller

**Files:**

- Modify: `src/guestSetup/preflightChecks.ts:13-83`
- Modify: `tests/unit/guestSetup/preflightChecks.test.ts`

**Interfaces:**

- Consumes: `deriveSwitchName` (unchanged, still required for the NAT side), the existing `hyperVQueries` builders/parsers, `checkRunHostingReady`.
- Produces:
  ```typescript
  export interface PreflightOptions {
    exec: PowerShellExec;
    vmName: string;
    internalAdapterAlias: string;
    internalSwitchName: string;
    natAdapterAlias: string;
    internalSwitchHostIp: string;
  }
  export type PreflightResult =
    | { ok: true; defaultSwitchName: string }
    | { ok: false; message: string };
  ```

The internal-switch half of the "derived switch name" guard is **deleted**, not left unreachable: with both names produced by `resolveHostNetworkNames` they cannot disagree. The NAT half stays — `vEthernet (Default Switch)` → `Default Switch` is still a derivation, and `--nat-adapter-alias` is still user-supplied.

`internalSwitchName` disappears from `PreflightResult`: the caller now knows it before calling, so returning it would be an echo. `defaultSwitchName` stays, because deriving it is still preflight's job.

- [ ] **Step 1: Rewrite the test's fixtures and the affected cases**

In `tests/unit/guestSetup/preflightChecks.test.ts`, replace `baseOpts` (lines 25-30):

```typescript
const baseOpts = {
  vmName: 'my-vm',
  internalAdapterAlias: 'vEthernet (susentorno-internal)',
  internalSwitchName: 'susentorno-internal',
  natAdapterAlias: 'vEthernet (Default Switch)',
  internalSwitchHostIp: '192.168.67.1',
};
```

replace the first test (lines 33-40):

```typescript
  it('succeeds and returns the derived NAT switch name when everything checks out', async () => {
    const result = await runPreflightChecks({ ...baseOpts, exec: fakeExec(ready) });
    expect(result).toEqual({ ok: true, defaultSwitchName: 'Default Switch' });
  });
```

replace the `fails on a malformed adapter alias before touching the VM` test (lines 42-50) — the internal side can no longer be malformed, so this now covers the NAT side, which is the half that survives:

```typescript
  it('fails on a malformed NAT adapter alias before touching the VM', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      natAdapterAlias: 'Ethernet',
      exec: fakeExec(ready),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Ethernet');
  });
```

and replace the `fails when a derived switch name does not resolve to a real switch` test (lines 80-86) with two cases, so both halves of the surviving loop stay covered and the internal message is asserted not to claim a derivation:

```typescript
  it('fails when the internal switch does not exist, without claiming the name was derived', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMSwitch -Name 'susentorno-internal'": '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Internal switch 'susentorno-internal'");
      expect(result.message).not.toContain('derived');
    }
  });

  it('fails when the derived NAT switch does not resolve to a real switch', async () => {
    const result = await runPreflightChecks({
      ...baseOpts,
      exec: fakeExec({ ...ready, "Get-VMSwitch -Name 'Default Switch'": '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("derived switch name 'Default Switch'");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/preflightChecks.test.ts`
Expected: FAIL — the success case still returns `internalSwitchName`, and the internal-switch message still says `derived switch name`.

- [ ] **Step 3: Reshape `PreflightOptions` and `PreflightResult`**

In `src/guestSetup/preflightChecks.ts`, replace lines 13-23:

```typescript
export interface PreflightOptions {
  exec: PowerShellExec;
  vmName: string;
  /**
   * Both internal names come from the caller's single resolveHostNetworkNames
   * call, so they cannot disagree — which is why preflight no longer recovers
   * the switch name from the alias with deriveSwitchName on this side.
   */
  internalAdapterAlias: string;
  internalSwitchName: string;
  natAdapterAlias: string;
  internalSwitchHostIp: string;
}

export type PreflightResult =
  | { ok: true; defaultSwitchName: string }
  | { ok: false; message: string };
```

- [ ] **Step 4: Delete the internal derivation and reshape the loop**

Replace lines 25-39 (the two `deriveSwitchName` guards) with just the NAT one:

```typescript
export async function runPreflightChecks(opts: PreflightOptions): Promise<PreflightResult> {
  const defaultSwitchName = deriveSwitchName(opts.natAdapterAlias);
  if (!defaultSwitchName) {
    return {
      ok: false,
      message: `preflight: '${opts.natAdapterAlias}' does not look like a Hyper-V vEthernet adapter alias`,
    };
  }
```

Replace the switch-existence loop (lines 56-67) — it still checks **both** switches against real Hyper-V, which is what catches "you never ran `create-host-network`" before a VM is stopped:

```typescript
  for (const { switchName, message } of [
    {
      switchName: opts.internalSwitchName,
      message: `preflight: Internal switch '${opts.internalSwitchName}' (adapter '${opts.internalAdapterAlias}') does not resolve to a real Hyper-V switch`,
    },
    {
      switchName: defaultSwitchName,
      message: `preflight: derived switch name '${defaultSwitchName}' (from '${opts.natAdapterAlias}') does not resolve to a real Hyper-V switch`,
    },
  ]) {
    const switchResult = await opts.exec.run(buildGetVmSwitchCommand(switchName));
    if (!parseVmSwitchExists(switchResult.stdout)) {
      return { ok: false, message };
    }
  }
```

Replace the final return (line 82):

```typescript
  return { ok: true, defaultSwitchName };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/preflightChecks.test.ts`
Expected: PASS, 8 tests. `pnpm typecheck` will still fail at `src/commands/setupGuestUnix.ts:114` (it passes `adapterAlias` and reads `internalSwitchName` off the result) — that call site is Task 6's job. Do not fix it here; commit this task with the typecheck failure isolated to that one file, or fold Steps 1-5 into Task 6's commit if you prefer never having a red `pnpm typecheck` in history.

- [ ] **Step 6: Commit (with Task 6, or standalone)**

If committing standalone, note the known-broken call site in the message so a bisect reads correctly:

```bash
pnpm format && pnpm lint && pnpm vitest run tests/unit/guestSetup/preflightChecks.test.ts
git add src/guestSetup/preflightChecks.ts tests/unit/guestSetup/preflightChecks.test.ts
git commit -m "refactor: preflight takes both internal switch names from its caller

setup-guest-unix's call site is updated in the next commit; pnpm typecheck
fails only on src/commands/setupGuestUnix.ts until then."
```

---

## Task 6: `setup-guest-unix --isolation-name` and the five answer flags

**Files:**

- Modify: `src/commands/setupGuestUnix.ts` — imports (`:1-29`), `SetupGuestUnixOptions` (`:31-34`), `ResolvedGuestNetwork` (`:36-39`), `resolveGuestNetwork` (`:46-63`), flag registration (`:84-85`), action body (`:86-130`)
- Modify: `tests/unit/commands/setupGuestUnix.test.ts`
- Modify: `tests/cli/setupGuestUnix.test.ts`

**Interfaces:**

- Consumes: `resolveHostNetworkNames`, `createHostNetworkHint`, `HostNetworkError` (Task 1); `resolveVmNameAnswer`, `resolveConnectionAnswers` (Task 4); `runPreflightChecks` with the reshaped `PreflightOptions` (Task 5); the existing `resolveForwardListenAddress` for the NAT side.
- Produces:
  ```typescript
  export interface ResolvedGuestNetwork {
    internalAdapterAlias: string;
    internalSwitchName: string;
    internalSwitchHostIp: string;
    defaultSwitchHostIp: string;
  }
  export interface GuestNetworkResolutionFailure {
    adapterAlias: string;
    hint: string;
  }
  export function resolveGuestNetwork(
    isolationName: string | undefined,
    natAdapterAlias: string,
    interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>,
  ): ResolvedGuestNetwork | GuestNetworkResolutionFailure;
  ```

`--adapter-alias` is removed, not deprecated. A hand-made Internal switch whose name does not follow `susentorno-<name>-internal` becomes unsupported — the same trade accepted in removing `--forward-listen`. `--nat-adapter-alias` is untouched: the Default Switch is a shared Windows object this project neither creates nor names.

`resolveGuestNetwork` calls `resolveHostNetworkNames` directly rather than Task 1's `resolveIsolationNetwork`, because it needs `switchName` as well as `adapterAlias` and only wants the address, never the netmask.

- [ ] **Step 1: Rewrite the unit test**

Replace `tests/unit/commands/setupGuestUnix.test.ts` in full:

```typescript
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import type { NetworkInterfaceInfo } from 'node:os';
import { registerSetupGuestUnix, resolveGuestNetwork } from '../../../src/commands/setupGuestUnix';
import { HostNetworkError } from '../../../src/hostNetwork/hostNetworkNames';

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('setup-guest-unix command option surface', () => {
  it('exposes --isolation-name and the five answer flags, and no longer exposes --adapter-alias', () => {
    const program = new Command();
    registerSetupGuestUnix(program);
    const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-unix');
    expect(command).toBeDefined();
    const flags = command!.options.map((o) => o.flags);

    expect(flags.some((f) => f.includes('--adapter-alias'))).toBe(false);
    for (const flag of [
      '--isolation-name',
      '--vm-name',
      '--guest-address',
      '--guest-username',
      '--share-name',
      '--share-account',
    ]) {
      expect(flags.some((f) => f.includes(flag)), flag).toBe(true);
    }

    const natAdapterOption = command!.options.find((o) => o.flags.includes('--nat-adapter-alias'));
    expect(natAdapterOption?.defaultValue).toBe('vEthernet (Default Switch)');
  });

  it('gives the share flags no Commander default, so an absent flag still prompts', () => {
    const program = new Command();
    registerSetupGuestUnix(program);
    const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-unix');
    for (const flag of ['--share-name', '--share-account']) {
      expect(command!.options.find((o) => o.flags.includes(flag))?.defaultValue, flag).toBeUndefined();
    }
  });
});

describe('resolveGuestNetwork', () => {
  it('resolves both IPs and both internal names for a named isolation network', () => {
    expect(
      resolveGuestNetwork('test', 'nat-adapter', {
        'vEthernet (susentorno-test-internal)': [ipv4('192.168.68.1')],
        'nat-adapter': [ipv4('172.28.128.1')],
      }),
    ).toEqual({
      internalAdapterAlias: 'vEthernet (susentorno-test-internal)',
      internalSwitchName: 'susentorno-test-internal',
      internalSwitchHostIp: '192.168.68.1',
      defaultSwitchHostIp: '172.28.128.1',
    });
  });

  it('selects the unnamed default network when no isolation name is given', () => {
    expect(
      resolveGuestNetwork(undefined, 'nat-adapter', {
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1')],
        'nat-adapter': [ipv4('172.28.128.1')],
      }),
    ).toEqual({
      internalAdapterAlias: 'vEthernet (susentorno-internal)',
      internalSwitchName: 'susentorno-internal',
      internalSwitchHostIp: '192.168.67.1',
      defaultSwitchHostIp: '172.28.128.1',
    });
  });

  it('fails on the internal-switch adapter first, pointing at create-host-network', () => {
    expect(
      resolveGuestNetwork('test', 'nat-adapter', { 'nat-adapter': [ipv4('172.28.128.1')] }),
    ).toEqual({
      adapterAlias: 'vEthernet (susentorno-test-internal)',
      hint: "Run 'susentorno create-host-network --isolation-name test' first.",
    });
  });

  it('omits the flag from the hint when no isolation name was given', () => {
    expect(resolveGuestNetwork(undefined, 'nat-adapter', {})).toEqual({
      adapterAlias: 'vEthernet (susentorno-internal)',
      hint: "Run 'susentorno create-host-network' first.",
    });
  });

  it('fails on the NAT adapter when only it is missing', () => {
    expect(
      resolveGuestNetwork(undefined, 'nat-adapter', {
        'vEthernet (susentorno-internal)': [ipv4('192.168.67.1')],
      }),
    ).toEqual({
      adapterAlias: 'nat-adapter',
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    });
  });

  it('throws HostNetworkError for an invalid isolation name', () => {
    expect(() => resolveGuestNetwork('bad name!', 'nat-adapter', {})).toThrow(HostNetworkError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/commands/setupGuestUnix.test.ts`
Expected: FAIL — `--isolation-name` is not registered and `resolveGuestNetwork` still takes an adapter alias.

- [ ] **Step 3: Swap the imports**

In `src/commands/setupGuestUnix.ts`, replace lines 5-10:

```typescript
import {
  resolveForwardListenAddress,
  DEFAULT_INTERNAL_SWITCH_ADAPTER,
  DEFAULT_NAT_ADAPTER,
} from '../runHosting/forwarder';
import { promptText, promptMasked } from '../cliPrompt';
```

with:

```typescript
import { resolveForwardListenAddress, DEFAULT_NAT_ADAPTER } from '../runHosting/forwarder';
import {
  createHostNetworkHint,
  resolveHostNetworkNames,
  HostNetworkError,
} from '../hostNetwork/hostNetworkNames';
import { promptText, promptMasked } from '../cliPrompt';
import {
  resolveVmNameAnswer,
  resolveConnectionAnswers,
  type SetupAnswerPrompts,
} from '../guestSetup/setupAnswers';
```

- [ ] **Step 4: Reshape the options and the resolver**

Replace lines 31-63:

```typescript
interface SetupGuestUnixOptions {
  isolationName?: string;
  natAdapterAlias: string;
  vmName?: string;
  guestAddress?: string;
  guestUsername?: string;
  shareName?: string;
  shareAccount?: string;
}

export interface ResolvedGuestNetwork {
  internalAdapterAlias: string;
  internalSwitchName: string;
  internalSwitchHostIp: string;
  defaultSwitchHostIp: string;
}

export interface GuestNetworkResolutionFailure {
  adapterAlias: string;
  hint: string;
}

/**
 * The isolation name — not an adapter alias — is the input, so the adapter
 * alias and the switch name both come from resolveHostNetworkNames and cannot
 * disagree. That inverts the old direction, where the command took an alias and
 * preflight recovered the switch name from it by string-stripping.
 *
 * Throws HostNetworkError for an invalid name; the command action catches it.
 */
export function resolveGuestNetwork(
  isolationName: string | undefined,
  natAdapterAlias: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): ResolvedGuestNetwork | GuestNetworkResolutionFailure {
  const names = resolveHostNetworkNames(isolationName);
  const internalSwitchHostIp = resolveForwardListenAddress(names.adapterAlias, interfaces);
  if (!internalSwitchHostIp) {
    return { adapterAlias: names.adapterAlias, hint: createHostNetworkHint(isolationName) };
  }
  const defaultSwitchHostIp = resolveForwardListenAddress(natAdapterAlias, interfaces);
  if (!defaultSwitchHostIp) {
    return {
      adapterAlias: natAdapterAlias,
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    };
  }
  return {
    internalAdapterAlias: names.adapterAlias,
    internalSwitchName: names.switchName,
    internalSwitchHostIp,
    defaultSwitchHostIp,
  };
}
```

- [ ] **Step 5: Swap the flag registration**

Replace lines 84-85:

```typescript
    .option('--adapter-alias <name>', 'Internal-switch adapter', DEFAULT_INTERNAL_SWITCH_ADAPTER)
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
```

with:

```typescript
    .option(
      '--isolation-name <name>',
      'Host network to attach the guest to, as passed to create-host-network ' +
        '(letters, digits, and hyphens only); omit for the default one',
    )
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .option('--vm-name <name>', 'Hyper-V VM name, skipping its prompt')
    .option('--guest-address <host>', 'Guest hostname or IP, skipping its prompt')
    .option('--guest-username <user>', 'Guest username, skipping its prompt')
    .option('--share-name <name>', 'SMB share name, skipping its prompt (prompt default: vm-shared-linux)')
    .option(
      '--share-account <name>',
      'Share account name, skipping its prompt (prompt default: susentorno-share)',
    )
```

No Commander defaults on `--share-name`/`--share-account`: the prompt owns those defaults, so an absent flag prompts with a default rather than silently resolving to one.

- [ ] **Step 6: Rewire the action body**

Replace lines 99-129 (from `const resolved = ...` through the `promptMasked` line):

```typescript
      const prompts: SetupAnswerPrompts = {
        text: (question, defaultValue) => promptText(question, defaultValue),
        masked: (question) => promptMasked(question),
      };

      let resolved: ResolvedGuestNetwork | GuestNetworkResolutionFailure;
      try {
        resolved = resolveGuestNetwork(options.isolationName, options.natAdapterAlias);
      } catch (error) {
        // Caught here rather than left to escape: an escaping throw would leave
        // the action handler entirely and print a stack trace for a typo'd flag.
        if (error instanceof HostNetworkError) {
          console.error(`setup-guest-unix: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      if (isResolutionFailure(resolved)) {
        console.error(
          `setup-guest-unix: could not find an IPv4 address on adapter '${resolved.adapterAlias}'. ${resolved.hint}`,
        );
        process.exitCode = 1;
        return;
      }
      const {
        internalAdapterAlias,
        internalSwitchName,
        internalSwitchHostIp,
        defaultSwitchHostIp,
      } = resolved;

      // Two stages either side of preflight, deliberately: a bad VM name or a
      // missing switch fails before the user types five more answers.
      const vmName = await resolveVmNameAnswer(options, prompts);

      const preflight = await runPreflightChecks({
        exec,
        vmName,
        internalAdapterAlias,
        internalSwitchName,
        natAdapterAlias: options.natAdapterAlias,
        internalSwitchHostIp,
      });
      if (!preflight.ok) {
        console.error(`setup-guest-unix: ${preflight.message}`);
        process.exitCode = 1;
        return;
      }
      const { defaultSwitchName } = preflight;

      const { address, username, shareName, accountName, password } =
        await resolveConnectionAnswers(options, prompts);
```

Everything after this point in the action is unchanged: `internalSwitchName` now comes from `resolved` instead of `preflight`, and every other identifier (`address`, `username`, `shareName`, `accountName`, `password`, `defaultSwitchName`) keeps the name the rest of the body already uses.

- [ ] **Step 7: Run the unit test and typecheck**

Run: `pnpm typecheck && pnpm vitest run tests/unit/commands/setupGuestUnix.test.ts tests/unit/guestSetup/preflightChecks.test.ts`
Expected: PASS, 8 + 8 tests, and typecheck clean (Task 5's isolated failure is now resolved).

- [ ] **Step 8: Rewrite the CLI test**

Replace the `describe` block in `tests/cli/setupGuestUnix.test.ts` (lines 19-30). The old test passes `--adapter-alias does-not-exist-adapter`; Commander would reject that removed option before reaching the asserted behavior.

```typescript
describe('susentorno setup-guest-unix', () => {
  it('fails fast with no prompts when the isolation name resolves to no adapter', async () => {
    const { exitCode, stderr, stdout } = await execa(
      'node',
      [cliPath, 'setup-guest-unix', '--isolation-name', 'does-not-exist'],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "could not find an IPv4 address on adapter 'vEthernet (susentorno-does-not-exist-internal)'",
    );
    expect(stderr).toContain(
      "Run 'susentorno create-host-network --isolation-name does-not-exist' first.",
    );
    expect(stdout).not.toContain('Guest address'); // never reached the prompts
  });

  it('reports an invalid isolation name as a message, not a stack trace', async () => {
    const { exitCode, stderr } = await execa(
      'node',
      [cliPath, 'setup-guest-unix', '--isolation-name', 'bad name!'],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('only letters, digits, and hyphens are allowed');
    expect(stderr).not.toContain('HostNetworkError:'); // caught at the command boundary
  });
});
```

Both tests require an elevated terminal — `isElevated()` is the command's first gate, ahead of everything asserted here. This is the same prerequisite the `cli` tier already carries.

- [ ] **Step 9: Build and run the CLI tier**

Run (elevated): `pnpm build && pnpm test:cli`
Expected: PASS across the tier, including 2 tests in `setupGuestUnix.test.ts`.

- [ ] **Step 10: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/commands/setupGuestUnix.ts tests/unit/commands/setupGuestUnix.test.ts tests/cli/setupGuestUnix.test.ts
git commit -m "feat: setup-guest-unix takes an isolation name and five answer flags"
```

---

## Task 7: Document the flags and what makes a run unattended

**Files:**

- Modify: `setup-guest.md:111-118` (the `setup-guest-unix` invocation) and the "A few things worth knowing" list at `:119-124`

**Interfaces:**

- Consumes: the flag surface from Task 6.
- Produces: nothing consumed by later tasks.

The unattended note is not actionable without the flags, so both land together. This is documentation only — no probe, no enforcement, no breaking change. Spec 2's test guest satisfies both preconditions by construction, exactly as today's QEMU harness already does (`tests/guest/harness/seed/user-data` sets `sudo: ALL=(ALL) NOPASSWD:ALL`).

- [ ] **Step 1: Replace the invocation section**

In `setup-guest.md`, replace lines 113-117:

````markdown
```powershell
susentorno setup-guest-unix
```

It prompts for the Hyper-V VM name, the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno-share`), and the share password from setup-environment.md.
````

with:

````markdown
```powershell
susentorno setup-guest-unix
```

It prompts for the Hyper-V VM name, the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno-share`), and the share password from setup-environment.md.

Any of those answers except the password can be supplied as a flag instead, and each flag suppresses **only its own** prompt — anything you leave off still prompts, in the same order:

| Flag | Answers |
| --- | --- |
| `--vm-name <name>` | Hyper-V VM name |
| `--guest-address <host>` | Guest address (hostname or IP) |
| `--guest-username <user>` | Guest username |
| `--share-name <name>` | SMB share name |
| `--share-account <name>` | Share account name |

The SMB share password is always prompted. Automation answers it by piping one line into the command's stdin.

Two more flags select which networks the guest is moved between:

| Flag | Selects |
| --- | --- |
| `--isolation-name <name>` | The host network created by `susentorno create-host-network --isolation-name <name>`. Omit it for the default `susentorno-internal` network. |
| `--nat-adapter-alias <name>` | The Default-Switch adapter used during the setup phase. Defaults to `vEthernet (Default Switch)`. |
````

- [ ] **Step 2: Add the unattended precondition note**

In the same file, append to the "A few things worth knowing before running it:" list (after the "Four distinct addresses" bullet at `:124`):

```markdown
- **A flag-driven run is unattended only if the guest never prompts**, which needs two things this command does not check or configure: the **key-based SSH auth** set up above, *and* **passwordless sudo** in the guest. A single run makes roughly twenty separate `ssh`/`scp` invocations, each of which prompts for the guest password without a key. Every remote command also gets a fresh pty (`ssh -t`), so sudo's per-tty credential timestamp never carries from one invocation to the next — nearly every remote step uses sudo, so without `NOPASSWD` you get roughly twenty sudo prompts even with the key in place. Key auth alone is not enough.
```

Also soften the framing above it: `setup-guest.md` currently presents key auth as optional-but-recommended, which is accurate for an attended run and misleading for a flag-driven one. The bullet above states the distinction explicitly; leave the existing "optional but recommended" wording alone so the attended path still reads correctly.

- [ ] **Step 3: Verify and commit**

Run: `pnpm format:check`
Expected: PASS (Prettier formats Markdown; run `pnpm format` first if it complains).

```bash
git add setup-guest.md
git commit -m "docs: setup-guest-unix answer flags and unattended preconditions"
```

---

## Task 8: Trim the Linux pre-script contents

**Files:**

- Modify: `templates/vm-shared-linux/pre-scripts/01-apt-packages.sh`
- Modify: `templates/vm-shared-linux/pre-scripts/02-install-pnpm.sh`
- Modify: `templates/vm-shared-linux/pre-scripts/03-install-tools.sh`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks. Deliberately separated from Task 9 (deleting `04-configure-tools.sh`), because deletion renumbers the woven output and Task 9 owns that fallout — a reviewer can accept this content trim while rejecting the deletion.

What survives, and why it is not obviously load-bearing:

- **`gh`** is required by `post-scripts/01-auth-config.sh` (`gh auth login --with-token`, `gh auth setup-git`); **`jq`** by the home settings transforms.
- **pnpm** survives solely as the vehicle for `pnpm runtime set node latest -g`; the guest needs node because `02-apply-home-jq-transforms.sh` runs `apply-home-jq-transforms.mjs`.
- **The three agent installs** stay: each has a first-class host credential channel and placeholder mount in the product ([ADR-0002](../../adr/0002-credential-injection-at-proxy.md), [ADR-0018](../../adr/0018-pi-agent-reuses-codex-placeholder-literal.md)). Shipping credential injection for an agent the templates do not install would be incoherent.
- **`apt upgrade -y`** stays. It is slow, and it will be a large cost in spec 2's end-to-end test — but it is a legitimate step in setting up a real user's guest, and removing it to speed up a test that does not exist yet would be the wrong reason.

Removing the `~/.bashrc` dotnet PATH block also removes the hardcoded `/home/username/.dotnet/tools` path at `03-install-tools.sh:19`, a latent bug for any guest whose user is not named `username`.

- [ ] **Step 1: Write the failing test**

In `tests/unit/templates.test.ts`, inside the `describe('ubuntu pre-/post-isolation step scripts', ...)` block, add after the existing `ubuntu 01-apt-packages installs jq and gh` test:

```typescript
    it('ubuntu pre-scripts install only what a susentorno guest requires', () => {
      const read = (name: string) =>
        readFileSync(join(templatesDir(), 'vm-shared-linux', 'pre-scripts', name), 'utf8');

      const apt = read('01-apt-packages.sh');
      expect(apt).toContain('apt upgrade -y'); // a real setup step, kept deliberately
      expect(apt).not.toContain('okular');
      expect(apt).not.toContain('build-essential');

      const pnpm = read('02-install-pnpm.sh');
      expect(pnpm).toContain('get.pnpm.io/install.sh');
      expect(pnpm).not.toContain('dotnet-sdk');

      const tools = read('03-install-tools.sh');
      // Each surviving install has a host credential channel and placeholder
      // mount in the product (ADR-0002, ADR-0018).
      expect(tools).toContain('claude.ai/install.sh');
      expect(tools).toContain('chatgpt.com/codex/install.sh');
      expect(tools).toContain('pi-coding-agent');
      expect(tools).toContain('pnpm runtime set node latest -g');
      expect(tools).not.toContain('snap install code');
      expect(tools).not.toContain('dotnet');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — `okular`, `dotnet-sdk`, `snap install code`, and `dotnet` are all still present.

- [ ] **Step 3: Trim `01-apt-packages.sh`**

Replace line 6:

```bash
sudo apt install -y curl git build-essential okular jq gh
```

with:

```bash
sudo apt install -y curl git jq gh
```

- [ ] **Step 4: Trim `02-install-pnpm.sh`**

Delete lines 12-13:

```bash
sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0
```

Leave everything else, including the existing commented-out pip/PyYAML note at the top — the spec's table removes `dotnet-sdk-10.0` from this file and nothing else.

- [ ] **Step 5: Trim `03-install-tools.sh`**

Replace the whole file with:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Pi Coding Agent
pnpm runtime set node latest -g

curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh

curl -fsSL https://claude.ai/install.sh | bash

pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent

echo "03-install-tools: node runtime, codex, claude, and the Pi coding agent installed."
```

The old closing `echo` named VS Code and pointed at `vm/04-claude-mcp.sh`; both references are gone (`04-configure-tools.sh` is deleted in Task 9, and there has never been an `04-claude-mcp.sh`).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS across the file.

- [ ] **Step 7: Format and commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add templates/vm-shared-linux/pre-scripts/01-apt-packages.sh templates/vm-shared-linux/pre-scripts/02-install-pnpm.sh templates/vm-shared-linux/pre-scripts/03-install-tools.sh tests/unit/templates.test.ts
git commit -m "feat: ship only what a susentorno guest requires in the Linux pre-scripts"
```

---

## Task 9: Delete `04-configure-tools.sh` and absorb the renumbering

**Files:**

- Delete: `templates/vm-shared-linux/pre-scripts/04-configure-tools.sh`
- Modify: `templates/vm-shared-linux/pre-scripts/nn-configure-network.sh:9,26,58,60,75`
- Modify: `templates/vm-shared-linux/verify-config.sh:93`
- Modify: `setup-guest.md:158`, `:205`
- Modify: `tests/unit/templates.test.ts:20-24`, `:174`
- Modify: `tests/unit/initEnv.test.ts:50`
- Modify: `tests/cli/init.test.ts:33`
- Modify: `tests/cli/updateShares.test.ts:101-106`
- Modify: `tests/guest/guest.test.ts:151,154,156,230,233,459,461`

**Interfaces:**

- Consumes: nothing.
- Produces: `nn-configure-network.sh` no longer prints its woven number, so nothing downstream can couple to it again.

This is one commit, not several: `renumber()` (`src/weaveScripts.ts:117-127`) assigns prefixes sequentially by index and `compareScripts` sorts the `nn` sentinel last, so deleting the fourth built-in renumbers `nn-configure-network.sh` from `05-` to `04-` the moment the file is gone. Every assertion below breaks in the same instant. Windows keeps four built-ins and stays `05-`, so the platforms legitimately diverge from here.

Production code is already immune: `runPreScripts.ts:20` matches the slug `configure-network`, never the number.

`templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1` has the same hardcoded-number defect at `:9`, `:29`, `:35` and is **left alone** with the rest of `vm-shared-windows/`.

`04-configure-tools.sh` is deleted rather than emptied because every line in it is preference — four named VS Code extensions, GNOME screensaver `gsettings`, `codebase-memory-mcp`, and context7 MCP wiring for both Claude and Codex.

**Do not touch** `tests/unit/guestSetup/listScripts.test.ts` or `tests/unit/guestSetup/runPreScripts.test.ts`. They name `05-configure-network.sh` too, but as synthetic fixtures in their own temp directories — they are unaffected and "fixing" them would break them.

- [ ] **Step 1: Write the failing test**

In `tests/unit/templates.test.ts`, inside `describe('packaged template & allowlist inventory', ...)`, add after the `ships every template file` test:

```typescript
    it('ships exactly the four ubuntu pre-scripts a guest requires', () => {
      const dir = join(templatesDir(), 'vm-shared-linux', 'pre-scripts');
      expect(readdirSync(dir).sort()).toEqual([
        '01-apt-packages.sh',
        '02-install-pnpm.sh',
        '03-install-tools.sh',
        'nn-configure-network.sh',
      ]);
    });
```

`readdirSync` is already imported at the top of this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — the actual array still contains `'04-configure-tools.sh'`.

- [ ] **Step 3: Delete the file and its inventory entry**

```bash
git rm templates/vm-shared-linux/pre-scripts/04-configure-tools.sh
```

In `tests/unit/templates.test.ts`, delete line 23 from `expectedTemplateFiles`:

```typescript
  'vm-shared-linux/pre-scripts/04-configure-tools.sh',
```

- [ ] **Step 4: Decouple `nn-configure-network.sh` from its woven number**

The file hardcodes the number in two kinds of string that need different treatments.

Replace line 9 (the **usage string** — it names a *file* the user is meant to invoke, so a bare slug would be wrong; `basename "$0"` prints whatever number weaving actually assigned, and so stays correct permanently):

```bash
host_ip="${1:?usage: 05-configure-network.sh <host-ip> [cert-path]}"
```

with:

```bash
usage="usage: $(basename "$0") <host-ip> [cert-path]"
host_ip="${1:?$usage}"
```

Replace the four **log prefixes** — line 26:

```bash
echo "configure-network: installed and trusted $cert_path; NODE_EXTRA_CA_CERTS configured for new shells"
```

line 58:

```bash
  echo "configure-network: registered CA with Firefox via $policy_file"
```

line 60:

```bash
  echo "configure-network: Firefox not found; skipped browser CA registration"
```

line 75:

```bash
echo "configure-network: CA trusted; addressing and DNS come from the host via DHCP"
```

- [ ] **Step 5: Verify the usage string still works**

```bash
bash -n templates/vm-shared-linux/pre-scripts/nn-configure-network.sh
bash templates/vm-shared-linux/pre-scripts/nn-configure-network.sh; echo "exit=$?"
```

Expected: the first command prints nothing (syntax OK). The second prints a line containing `usage: nn-configure-network.sh <host-ip> [cert-path]` and `exit=1`.

- [ ] **Step 6: Update `verify-config.sh`**

In `templates/vm-shared-linux/verify-config.sh:93`, replace `05-configure-network.sh` with `04-configure-network.sh`:

```bash
    bad 'firefox policy cert matches installed proxy CA' "missing or stale $ff_ca -- re-run 04-configure-network.sh"
```

Unlike the script's own usage string, this file has no way to ask what number weaving assigned, so it names the number the Linux share now produces.

- [ ] **Step 7: Update the docs**

In `setup-guest.md:158`, replace `05-configure-network.sh <host-ip>` with `04-configure-network.sh <host-ip>`.

In `setup-guest.md:205`, replace:

```
When a script asks for `<host-ip>` (`05-configure-network.sh` / `05-configure-network.ps1`), it is
```

with:

```
When a script asks for `<host-ip>` (`04-configure-network.sh` / `05-configure-network.ps1`), it is
```

`setup-guest.md:200` is the Windows path and correctly **stays** `05-`.

- [ ] **Step 8: Update the remaining tests**

`tests/unit/templates.test.ts:174` — retitle (the body reads the `nn-` source path and is otherwise unaffected):

```typescript
    it('ubuntu configure-network leaves addressing and DNS to DHCP', () => {
```

`tests/unit/initEnv.test.ts:50` — `'vm-shared-linux/pre-scripts/05-configure-network.sh'` becomes `'vm-shared-linux/pre-scripts/04-configure-network.sh'`. Line 60's `vm-shared-windows/pre-scripts/05-configure-network.ps1` is **unchanged**.

`tests/cli/init.test.ts:33` — `'05-configure-network.sh'` becomes `'04-configure-network.sh'`.

`tests/cli/updateShares.test.ts:101-106` — both the with-custom-script and without-custom-script expectations shift by one built-in:

```typescript
      expect(existsSync(join(wovenPre, '04-docker.sh'))).toBe(true);
      expect(existsSync(join(wovenPre, '05-configure-network.sh'))).toBe(true);
      rmSync(join(preSrc, '01-docker.sh'));
      await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      expect(existsSync(join(wovenPre, '04-docker.sh'))).toBe(false);
      expect(existsSync(join(wovenPre, '04-configure-network.sh'))).toBe(true);
```

(Built-ins weave as one block, then customs, then the `nn` sentinel — see `weaveShares.ts:111-120` — so with three built-ins the custom script lands at `04-` and the sentinel at `05-`; remove the custom and the sentinel becomes `04-`.)

`tests/guest/guest.test.ts` — line 151's title, 154, 156, 233, 459, 461:

```typescript
  it('runs 04-configure-network.sh from the VM share', async () => {
    const { stdout } = await guest(
      'g1',
      `bash /mnt/vm-shared-linux/pre-scripts/04-configure-network.sh ${BRIDGE_IP}`,
    );
    expect(stdout).toContain('configure-network:');
  });
```

At line 230, retitle and re-point the path. The existing title says `06` where the path says `05` — stale before this changeset — so it goes to the number-free slug rather than to `04`, which is the same decoupling applied to the script's own log prefixes:

```typescript
  it('configure-network merges the CA into an existing firefox policies.json, preserving other keys', async () => {
```

and inside it, `pre-scripts/05-configure-network.sh` becomes `pre-scripts/04-configure-network.sh`.

At lines 457-461:

```typescript
    const run = await guest(
      'g2',
      `bash /mnt/vm-shared-linux/pre-scripts/04-configure-network.sh ${BRIDGE_IP}`,
    );
    expect(run.stdout).toContain('configure-network:');
```

- [ ] **Step 9: Run every affected tier**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli
```

Expected: PASS. Then, with WSL2/KVM available (this tier takes 10-20 minutes on a cold image):

```bash
pnpm test:guest
```

Expected: PASS. The `guest` tier's own image is unaffected by the trim — `tests/guest/harness/seed/user-data` installs `nodejs` directly because the suite runs `nn-configure-network.sh` without ever running `01`–`03`.

- [ ] **Step 10: Commit**

```bash
git add -A templates/vm-shared-linux setup-guest.md tests/unit/templates.test.ts tests/unit/initEnv.test.ts tests/cli/init.test.ts tests/cli/updateShares.test.ts tests/guest/guest.test.ts
git commit -m "feat: drop 04-configure-tools.sh and decouple configure-network from its number"
```

---

## Task 10: Delete the VS Code home settings transform

**Files:**

- Delete: `templates/home-jq-transforms/vscode-settings.jq`
- Modify: `templates/home-jq-transforms/manifest.yaml:4-6`
- Modify: `tests/unit/templates.test.ts:40` and the manifest-consistency describe block
- Modify: `tests/cli/updateShares.test.ts:41`, `:73`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks.

The transform sets `files.autoSave`, `editor.formatOnSave`, `chat.disableAIFeatures`, and `editor.defaultFormatter` to `esbenp.prettier-vscode` and `csharpier.csharpier-vscode`. Leaving it would ship settings configuring formatters for two extensions Task 8/9 stop installing, in an editor they stop installing.

**This is the one place the changeset touches Windows behavior.** The manifest entry carries a `windows:` target as well as a `linux:` one, so Windows guests lose the transform too. That is deliberate: splitting the entry to keep a Windows-only half would leave a transform naming extensions only the Windows templates install, which is a worse thing to hand to the later Windows cleanup than a clean deletion.

`claude-onboarding.jq` and `pi-openai-codex-auth.jq` stay — both configure agents the templates still install, against credential channels the product owns.

The two test files below use `vscode-settings.jq` as a convenient stand-in for "some transform" rather than testing it specifically, so each is **re-pointed at a surviving transform**, not deleted.

- [ ] **Step 1: Write the failing test**

In `tests/unit/templates.test.ts`, inside `describe('home settings transform manifest', ...)`, add before the existing consistency test:

```typescript
    it('ships no VS Code settings transform', () => {
      // Removed with the VS Code install itself: it configured formatters for
      // two extensions the templates no longer install, in an editor they no
      // longer install. The manifest/.jq consistency test below then covers two
      // entries instead of three.
      expect(existsSync(join(templatesDir(), 'home-jq-transforms', 'vscode-settings.jq'))).toBe(
        false,
      );
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — `expected true to be false`.

- [ ] **Step 3: Delete the transform and its manifest entry**

```bash
git rm templates/home-jq-transforms/vscode-settings.jq
```

In `templates/home-jq-transforms/manifest.yaml`, delete lines 4-6:

```yaml
- transform: vscode-settings.jq
  linux: ~/.config/Code/User/settings.json
  windows: "%APPDATA%/Code/User/settings.json"
```

leaving:

```yaml
# Each entry applies a jq transform to a settings file in the guest's home.
# transform: a .jq file in this folder. linux/windows: target paths (either may
# be omitted to skip that OS). A leading ~ is the home dir; %NAME% is an env var.
- transform: claude-onboarding.jq
  linux: ~/.claude.json
  windows: ~/.claude.json
- transform: pi-openai-codex-auth.jq
  linux: ~/.pi/agent/auth.json
  windows: ~/.pi/agent/auth.json
```

- [ ] **Step 4: Drop the inventory entry**

In `tests/unit/templates.test.ts`, delete line 40 from `expectedTemplateFiles`:

```typescript
  'home-jq-transforms/vscode-settings.jq',
```

- [ ] **Step 5: Re-point the `update-shares` CLI tests**

In `tests/cli/updateShares.test.ts:41`, replace:

```typescript
      expect(stdout).toContain('vscode-settings.jq');
```

with:

```typescript
      expect(stdout).toContain('pi-openai-codex-auth.jq');
```

In `tests/cli/updateShares.test.ts:73`, replace:

```typescript
      const src = join(dir, '.susentorno', 'home-jq-transforms', 'vscode-settings.jq');
```

with:

```typescript
      const src = join(dir, '.susentorno', 'home-jq-transforms', 'pi-openai-codex-auth.jq');
```

Both use the file as a stand-in for "some transform" — the first asserts a transform name reaches the preview output, the second writes deliberately invalid jq into one to test the error path. `pi-openai-codex-auth.jq` is chosen over `claude-onboarding.jq` so the first test's other assertion (`hasCompletedOnboarding`, which comes from `claude-onboarding.jq`'s `{}` preview) still names a *different* transform and keeps proving that every transform is previewed.

- [ ] **Step 6: Run the affected tiers**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli
```

Expected: PASS. The `update-shares` CLI tests are skipped when `jq` is not on PATH (`describe.skipIf(!hasJq)`) — if they skip, confirm with `jq --version` and install jq before trusting this task's verification.

- [ ] **Step 7: Commit**

```bash
git add -A templates/home-jq-transforms tests/unit/templates.test.ts tests/cli/updateShares.test.ts
git commit -m "feat: drop the VS Code home settings transform with the editor it configured"
```

---

## Task 11: Domain term and architecture records

**Files:**

- Modify: `CONTEXT.md` (under "Network policy", after **Host network**)
- Modify: `docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md` (append one consequence)
- Create: `docs/adr/0024-shipped-guest-templates-carry-only-requirements.md`

**Interfaces:**

- Consumes: everything Tasks 1-10 built. Land this last, so the records describe shipped behavior rather than intent.
- Produces: nothing consumed by later tasks.

[ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md) is deliberately **not** amended: it still accurately describes the tier that exists today, and superseding it belongs to spec 2, when there is an implemented decision to record rather than an intention.

- [ ] **Step 1: Add the domain term**

In `CONTEXT.md`, insert after the **Host network** entry (line 41) and before the **Host-run MCP server** entry:

```markdown
**Isolation name**: The name that selects which parallel host network susentorno's commands act on — the Internal switch and its firewall rules — so a sandboxed installation can coexist with the default one on the same machine. Omitting it selects the unnamed default. _Avoid_: Sandbox name, test name
```

The definition is deliberately confined to the host network, which is all the term scopes once this changeset lands. Spec 2 may extend it to the SMB share account and guest VM names; if it does, it amends this definition then. Writing the broader meaning now would record an intention as domain truth.

- [ ] **Step 2: Add the ADR-0023 consequence**

Append to the `## Consequences` list in `docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md`:

```markdown
- The isolation name is no longer a `create-host-network`/`delete-host-network`-only concept. `run-hosting --isolation-name <name>` binds that network's adapter instead of the default one, and `setup-guest-unix --isolation-name <name>` attaches the guest to that network's switch — replacing `run-hosting --forward-listen <ip>` and `setup-guest-unix --adapter-alias <alias>`, both removed. All four commands take their switch name and adapter alias from the same `resolveHostNetworkNames`, so the two can never disagree, and a hand-made Internal switch not named `susentorno-<name>-internal` is no longer supported.
```

- [ ] **Step 3: Write the new ADR**

Create `docs/adr/0024-shipped-guest-templates-carry-only-requirements.md`:

```markdown
# Shipped guest templates carry only what a susentorno guest requires

The templates susentorno ships install only what a guest needs to *be* a susentorno guest — the packages the product's own scripts call (`curl`, `git`, `jq`, `gh`), the node runtime its home-settings applier needs, and the three coding agents the product has host credential channels and placeholder mounts for. Everything else that had accumulated in `templates/vm-shared-linux/` was one developer's tooling preference — the .NET SDK and its global tools, `okular`, `build-essential`, VS Code and four named extensions, GNOME screensaver settings, and extra MCP wiring — and is removed. Preferences belong on the user side of the line [[user-customizable-committable-environment]] already draws: `pre-scripts/`, `post-scripts/`, and `home-jq-transforms/`, which are exactly the surface a user commits and susentorno weaves in.

The test for "required" is whether removing it breaks a product behavior: `gh` is called by `post-scripts/01-auth-config.sh`; `jq` and node are needed by the home settings transforms; pnpm survives solely as the vehicle for `pnpm runtime set node latest -g`. The three agent installs stay because shipping credential injection ([[credential-injection-at-proxy]], [[pi-agent-reuses-codex-placeholder-literal]]) for an agent the templates do not install would be incoherent. `apt upgrade -y` stays: it is a legitimate step in setting up a real user's guest, and its cost belongs to whoever builds a disposable test image, not to every user.

## Status

accepted (2026-08-15)

## Considered Options

- **Empty the preference scripts but keep the files**, so users have a numbered slot to fill. Rejected: the woven output already gives users their own numbered slots via `pre-scripts/`, so an empty built-in is a file with no reason to exist and a number that shifts everything after it.
- **Keep the VS Code settings transform for Windows only**, splitting its `manifest.yaml` entry. Rejected: it would leave a transform naming extensions only the Windows templates install — a worse thing to hand to the later Windows cleanup than a clean deletion. Deleting the whole entry is the one place this rule's first application reaches a Windows guest.

## Consequences

- `templates/vm-shared-windows/` is a known, deliberate exception on the day this is written: it still ships VS Code, extensions, and .NET tooling. The same treatment is intended there, deferred because the Windows guest path is covered by no test tier — the trim would be unverifiable beyond review, and a Windows guest may enter the test mix later, which would change what "required" means there.
- Users who want the removed tooling add it to their own `pre-scripts/`, which is where it already belonged; nothing about how they do that is new.
- With four built-in Linux pre-scripts reduced to three, `nn-configure-network.sh` weaves out as `04-configure-network.sh` rather than `05-`. Windows keeps four built-ins and stays `05-`, so the two platforms' woven numbering legitimately diverges. The script no longer prints its own number, so nothing downstream can couple to it again.
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm format:check`
Expected: PASS (run `pnpm format` first if it complains).

```bash
git add CONTEXT.md docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md docs/adr/0024-shipped-guest-templates-carry-only-requirements.md
git commit -m "docs: record the isolation name term and the guest-template rule"
```

---

## Final verification

- [ ] **Run the whole pipeline from an elevated terminal with Docker and WSL2 available**

```bash
pnpm test
```

Expected: PASS end to end — `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:cli`, `test:host-network`, `test:proxy-stack`, `test:guest`. The `guest` tier is not retired by this changeset and must be green.

- [ ] **Confirm the removed flags are gone from the built CLI**

```bash
node dist/cli.js run-hosting --help
node dist/cli.js setup-guest-unix --help
```

Expected: `run-hosting` lists `--isolation-name <name>` and no `--forward-listen`; `setup-guest-unix` lists `--isolation-name`, `--vm-name`, `--guest-address`, `--guest-username`, `--share-name`, `--share-account`, `--nat-adapter-alias`, and no `--adapter-alias`.

- [ ] **Confirm the conflicting flag combination fails loudly**

```bash
node dist/cli.js run-hosting --no-forward --isolation-name test; echo "exit=$?"
```

Expected: a message naming both flags, and `exit=1`.

**What remains uncovered, by design:** `run-hosting` actually binding `:53`/`:67` on the sandbox adapter. That is spec 2's work, and this plan does not imply otherwise.

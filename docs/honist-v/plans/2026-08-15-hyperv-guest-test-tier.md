# Hyper-V Guest Test Tier Implementation Plan

**Goal:** Replace the QEMU-in-WSL2 `guest` tier with real Hyper-V VMs on a real Internal switch served by the real `run-hosting`, so the tier drops two of its three substitutions and becomes the first automated coverage of the gateway forwarder, the DNS responder, and the DHCP server.

**Architecture:** A new harness under `tests/guest/` builds its own Ubuntu 26.04 golden VHDX from the live-server ISO via an unattended autoinstall, then boots three per-test guests from differencing disks off that golden parent. Everything the tier touches on the host derives from one isolation name (`test`) so it is sweepable from one string. Every PowerShell-facing module splits into pure `buildXCommand()`/`parseX()` functions plus a thin executor over the existing `powerShellExec.ts` seam — the split `src/guestSetup/hyperVQueries.ts` already establishes — so the interesting logic is unit-testable without Hyper-V.

**Tech Stack:** TypeScript, Vitest (five tiers: `unit`, `cli`, `host-network`, `proxy-stack`, `guest`), Windows PowerShell 5.1 via `powershell.exe` (Hyper-V, Storage, SMB, LocalAccounts modules), Ubuntu 26.04 subiquity autoinstall, OpenSSH (`ssh`/`scp`/`ssh-keygen`/`ssh-add`), Node `node:net` named pipes.

## Global Constraints

- **The isolation name is `test`** everywhere in this tier. Every host object derives from it: switch `susentorno-test-internal`, firewall rules `susentorno-test …`, VMs `susentorno-test-phases` / `-e2e` / `-fresh`, differencing VHDXs `.image-cache/susentorno-test-<role>.vhdx`, golden VHDX `.image-cache/susentorno-test-golden.vhdx`, Windows local account `susentorno-test`, SMB share `susentorno-test-vm-shared-linux`.
- **The guest's Linux account is `vmtest`**, hostname `susentorno-test-guest`. It is deliberately *not* renamed to match the Windows share account — different namespace, different machine.
- **No changes to `src/` beyond one line:** `DEFAULT_SHARE_ACCOUNT` in `src/guestSetup/setupAnswers.ts:24` becomes `susentorno` (Task 15). Nothing else in `src/` may change. If a task appears to need a `src/` change, stop and re-examine — spec 1 already landed every capability this tier requires.
- **No length bound is added to `ISOLATION_NAME_RE`** (`src/hostNetwork/hostNetworkNames.ts:7`). Real problem, different changeset.
- **`templates/vm-shared-windows/` is untouched**, as is the Windows `nn-configure-network.ps1`'s hardcoded script numbering.
- **The tier stays in the default `pnpm test` pipeline.** No opt-in split.
- **Strictly sequential:** `fileParallelism: false` stays in `vitest.guest.config.ts`.
- `node:`-prefixed core imports; flat `tests/unit/**/*.test.ts` layout mirroring the module under test.
- Run `pnpm format && pnpm lint && pnpm typecheck` before every commit. `templates/` and `docs/` are prettier-ignored (`.prettierignore`); `tests/` is not.
- Prerequisites for running the `guest` tier after this lands: an **elevated (Administrator)** terminal, Hyper-V, Docker Desktop running, and a running `ssh-agent`. No WSL2, no KVM, no nested virtualization.
- **File-path names that merely resemble the account name must not be renamed.** `/etc/susentorno-share.cred` (`src/guestSetup/mountShare.ts:66`, `src/guestSetup/fstabLine.ts:33`) is a path, not an account, and stays exactly as it is in Task 15.

### Spec deviations recorded up front

Four places where this plan does something the spec's prose does not literally say. All four are deliberate.

1. **The ESP GPT type is set *last*, not at `New-Partition` time.** The spec says "New-Partition with `-GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'`". A partition created with that type is an EFI System Partition, which Windows hides from volume enumeration — `-AssignDriveLetter` does not reliably give it a letter, and without a letter there is nothing to `Copy-Item` the ISO tree into. So the installer disk is created as basic-data, formatted FAT32, populated, and only then retyped with `Set-Partition -GptType`. The finished on-disk layout is identical, which is what the firmware sees. Task 4's spike is exactly where this gets confirmed.
2. **`startProxyStack`'s signature change touches two call sites, not eight.** The spec says "the eight `proxy-stack` files share this helper". Only `tests/proxy-stack/allowlistEnforcement.test.ts:22` and `tests/proxy-stack/skipAllowList.test.ts:15` call it; the other files (notably `stackLifecycle.test.ts`) spawn `run-hosting` themselves. The risk in §7.7 is correspondingly smaller, but the change is made exactly as specified.
3. **Four modules are added to the spec's §4 module list, and one is split.** `tests/guest/hyperv/imageCache.ts` holds the `.image-cache/` path constants that `isoCache.ts`, `goldenImage.ts`, `testGuest.ts`, and `sweep.ts` all need; `tests/guest/hyperv/vm.ts` holds the `New-VM`/`Set-VMFirmware`/`Set-VMComPort` vocabulary that both `goldenImage.ts` and `testGuest.ts` need — putting either in one consumer would make the others import it for an unrelated reason. `tests/guest/hyperv/goldenStamp.ts` is split out of `goldenImage.ts` so the staleness logic is unit-testable without dragging in the build orchestration. And `tests/guest/autoinstall.ts` holds the `user-data`/`meta-data`/`grub.cfg` **generators**; the spec's `autoinstall/` directory of static files cannot work, because the harness SSH public key and the baked guest host key are generated at run time and must be interpolated in.
4. **The golden-image build's serial log lives at `.image-cache/golden-build-serial.log`**, not under `test-results/`. The spec asks for "a stable path" that survives across runs so a failed build's log is still there next time; `test-results/guest/<timestamp>/` is per-run by construction.
5. **`e2e.test.ts` pre-warms the guest's two DHCP addresses before running the command.** The spec says to trust each guest's host key "immediately after it becomes reachable and before any `ssh` runs against it", which works for `phases` and `fresh` — but the e2e run's two addresses are discovered *inside* the command, by production code, over bare `ssh`. So the guest is booted on both switches first to learn both leases, each is trusted by exact IP, and only then does the command run. Task 14 explains why this is deterministic. The rejected alternative is a subnet wildcard in `known_hosts`, which the design rules out for good reasons.

### Task dependency order

Tasks 1–3 are independent of the Hyper-V work and each leave `pnpm test` green on their own. Task 4 is a spike and **must run before Tasks 5–15** — nothing downstream matters if the installer disk will not boot. Task 13 is the cutover: it deletes the WSL harness and `guest.test.ts` in the same commit that adds the first replacement test file, because `vitest.guest.config.ts` does not set `passWithNoTests` and an empty tier is a failing tier. Tasks 16 and 17 depend only on Task 13 having landed.

---

## Task 1: `.image-cache/`, the shared `checkElevated`, and the strict gateway-port guard

**Files:**

- Create: `tests/checkGatewayPortsFree.ts`
- Create: `tests/checkElevated.ts` (moved from `tests/host-network/checkElevated.ts`)
- Delete: `tests/host-network/checkElevated.ts`
- Modify: `tests/host-network/globalSetup.ts:1`
- Modify: `.gitignore`, `.prettierignore`
- Test: `tests/unit/checkGatewayPortsFree.test.ts`

**Interfaces:**

- Consumes: `createRealPowerShellExec()` from `src/guestSetup/powerShellExec`, `isElevated(exec)` from `src/guestSetup/elevationCheck` (both existing, unchanged).
- Produces:
  ```typescript
  // tests/checkElevated.ts
  export function checkElevated(): Promise<void>;

  // tests/checkGatewayPortsFree.ts
  export function describeHeldGatewayPorts(httpHeld: boolean, httpsHeld: boolean): string | null;
  export function checkGatewayPortsFree(): Promise<void>;
  ```

`checkNoRunningProxy` (`tests/checkNoRunningProxy.ts`) is **not** modified and **not** deleted — `proxy-stack` still uses it, still runs on 18080/18443, and genuinely does not care about a stray `:80`. The two guards coexist deliberately.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/checkGatewayPortsFree.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { describeHeldGatewayPorts } from '../checkGatewayPortsFree';

describe('describeHeldGatewayPorts', () => {
  it('returns null when neither port is held', () => {
    expect(describeHeldGatewayPorts(false, false)).toBeNull();
  });

  it('blames run-hosting when both ports are held', () => {
    const message = describeHeldGatewayPorts(true, true)!;
    expect(message).toContain('run-hosting');
    expect(message).toContain('127.0.0.1:80');
    expect(message).toContain('127.0.0.1:443');
  });

  it('names IIS or a dev server, not run-hosting, when only :80 is held', () => {
    const message = describeHeldGatewayPorts(true, false)!;
    expect(message).toContain('127.0.0.1:80');
    expect(message).not.toContain('127.0.0.1:443');
    expect(message).toContain('IIS');
    expect(message).not.toContain('run-hosting');
  });

  it('names IIS or a dev server, not run-hosting, when only :443 is held', () => {
    const message = describeHeldGatewayPorts(false, true)!;
    expect(message).toContain('127.0.0.1:443');
    expect(message).not.toContain('127.0.0.1:80');
    expect(message).toContain('IIS');
    expect(message).not.toContain('run-hosting');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/checkGatewayPortsFree.test.ts`
Expected: FAIL — `Cannot find module '../checkGatewayPortsFree'`.

- [ ] **Step 3: Write `tests/checkGatewayPortsFree.ts`**

```typescript
import net from 'node:net';

/** Resolve true if a TCP connect to 127.0.0.1:<port> is accepted. */
function loopbackPortAccepts(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The strict variant of checkNoRunningProxy, for the guest tier only.
 *
 * checkNoRunningProxy deliberately requires BOTH ports before failing, so an
 * unrelated :80 listener does not trip the proxy-stack suites — which run on
 * 18080/18443 and genuinely do not care. This tier binds the real :80/:443, so
 * that tolerance becomes a defect here: IIS holding :80 alone would sail past
 * the guard and fail inside startGateway as an opaque EADDRINUSE, which is the
 * "symptom lands a long way from the cause" failure the original comment says
 * it was written to prevent.
 *
 * Two messages, because the two causes have different fixes.
 */
export function describeHeldGatewayPorts(httpHeld: boolean, httpsHeld: boolean): string | null {
  if (httpHeld && httpsHeld) {
    return (
      'Something is already serving both 127.0.0.1:80 and 127.0.0.1:443 — almost certainly ' +
      "'susentorno run-hosting'. It manages the same Envoy containers this suite does, and the " +
      'two will clobber each other. Stop run-hosting and re-run; start it again afterwards to ' +
      "restore the guest's proxy."
    );
  }
  if (httpHeld || httpsHeld) {
    const port = httpHeld ? '127.0.0.1:80' : '127.0.0.1:443';
    return (
      `Something is already serving ${port}. The guest tier's run-hosting binds the real ` +
      ':80 and :443 (the guest resolves every name to the host and connects on the port from ' +
      'the URL), so it cannot start while that port is taken. This is usually IIS ("World Wide ' +
      'Web Publishing Service") or a local dev server, not run-hosting — run ' +
      `\`Get-NetTCPConnection -LocalPort ${httpHeld ? 80 : 443} -State Listen\` to find the ` +
      'owning process, stop it, and re-run.'
    );
  }
  return null;
}

export async function checkGatewayPortsFree(): Promise<void> {
  const [http, https] = await Promise.all([loopbackPortAccepts(80), loopbackPortAccepts(443)]);
  const message = describeHeldGatewayPorts(http, https);
  if (message) throw new Error(message);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/checkGatewayPortsFree.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Move `checkElevated` up to `tests/`**

Two tiers need it now, and `testing.md:81` already says support code used by more than one tier lives at the root of `tests/`.

```bash
git mv tests/host-network/checkElevated.ts tests/checkElevated.ts
```

Then fix the two relative imports inside the moved file — it is one directory shallower now. Replace lines 1-2 of `tests/checkElevated.ts`:

```typescript
import { createRealPowerShellExec } from '../src/guestSetup/powerShellExec';
import { isElevated } from '../src/guestSetup/elevationCheck';
```

and broaden its doc comment, since it no longer belongs to one tier. Replace the comment block (lines 4-9) with:

```typescript
/**
 * Guard: the host-network and guest tiers both create and delete real Hyper-V
 * objects — switches, firewall rules, VMs, VHDs, SMB shares, and a Windows
 * local account — all of which require an elevated process token. Check up
 * front and fail fast with a message that names the fix, rather than letting
 * the first PowerShell call fail deep inside a test.
 */
```

and generalise the thrown message body:

```typescript
    throw new Error(
      'This terminal is not elevated (Administrator). This tier creates and deletes real Hyper-V ' +
        'objects, firewall rules, and Windows local accounts, which requires it. Re-run from an ' +
        'Administrator PowerShell/terminal.',
    );
```

- [ ] **Step 6: Repoint the host-network globalSetup**

Replace `tests/host-network/globalSetup.ts:1`:

```typescript
import { checkElevated } from '../checkElevated';
```

- [ ] **Step 7: Ignore `.image-cache/`**

Append to `.gitignore`, after the `test-results/` line's block (i.e. after line 7's `.susentorno/`):

```
# The guest tier's golden VHDX, its ISO, and its harness keypairs. Repo-local
# rather than under %LOCALAPPDATA% because this project avoids git worktrees
# (its live tiers share one host network adapter, so parallel checkouts could
# not run tests concurrently anyway) — so the usual "every worktree rebuilds
# its own multi-GB image" objection cannot arise.
.image-cache/
```

Append to `.prettierignore`:

```
.image-cache/
```

- [ ] **Step 8: Run the affected tiers and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit`
Then, elevated: `pnpm test:host-network`
Expected: unit PASS (the 4 new tests included); host-network PASS, 4 tests — the move must not change its behaviour.

```bash
git add tests/checkElevated.ts tests/checkGatewayPortsFree.ts tests/host-network/globalSetup.ts tests/unit/checkGatewayPortsFree.test.ts .gitignore .prettierignore
git rm --cached tests/host-network/checkElevated.ts 2>/dev/null || true
git commit -m "test: share checkElevated across tiers and add a strict gateway-port guard"
```

---

## Task 2: `startProxyStack` gains an options object

**Files:**

- Modify: `tests/proxyStack.ts:116-200` (signature, argv, env)
- Modify: `tests/proxy-stack/allowlistEnforcement.test.ts:22`
- Modify: `tests/proxy-stack/skipAllowList.test.ts:15`
- Modify: `tests/guest/guest.test.ts:93` (kept working until Task 12 deletes the file)
- Test: `tests/unit/proxyStackOptions.test.ts`

**Interfaces:**

- Consumes: the existing `HTTP_PORT = 18080` / `HTTPS_PORT = 18443` constants in `tests/proxyStack.ts:11-12`.
- Produces:
  ```typescript
  // tests/proxyStack.ts
  export interface ProxyStackOptions {
    /** Omit for --no-forward on 18080/18443 — today's default, and every proxy-stack caller. */
    forward?: { isolationName: string };
    extraArgs?: string[];
  }
  export function buildForwardArgs(options: ProxyStackOptions): string[];
  export function buildGatewayPortEnv(options: ProxyStackOptions): NodeJS.ProcessEnv;
  export function startProxyStack(options?: ProxyStackOptions): Promise<ProxyStack>;
  ```

Why an options object rather than more positional arguments: `startProxyStack(['--isolation-name', 'test'])` would pass *both* `--no-forward` and `--isolation-name`, which spec 1 made an explicit error (`src/commands/runHosting.ts`'s conflict check), and would still serve 18080/18443 rather than the 80/443 the guest needs. Neither behaviour can change globally, because `pnpm test` runs `test:proxy-stack` **before** `test:guest` and `susentorno-test-internal` does not exist yet when those files run.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxyStackOptions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildForwardArgs, buildGatewayPortEnv, HTTP_PORT, HTTPS_PORT } from '../proxyStack';

describe('buildForwardArgs', () => {
  it('defaults to --no-forward, matching every proxy-stack caller', () => {
    expect(buildForwardArgs({})).toEqual(['--no-forward']);
  });

  it('drops --no-forward and passes --isolation-name when forwarding is requested', () => {
    expect(buildForwardArgs({ forward: { isolationName: 'test' } })).toEqual([
      '--isolation-name',
      'test',
    ]);
  });

  it('never emits both flags — run-hosting rejects that combination', () => {
    const args = buildForwardArgs({ forward: { isolationName: 'test' } });
    expect(args).not.toContain('--no-forward');
  });
});

describe('buildGatewayPortEnv', () => {
  it('pins the gateway to 18080/18443 by default', () => {
    expect(buildGatewayPortEnv({})).toEqual({
      ENVOY_HTTP_PORT: String(HTTP_PORT),
      ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    });
  });

  it('leaves both unset when forwarding, so the gateway takes its 80/443 defaults', () => {
    expect(buildGatewayPortEnv({ forward: { isolationName: 'test' } })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/proxyStackOptions.test.ts`
Expected: FAIL — `buildForwardArgs is not a function`.

- [ ] **Step 3: Add the two pure builders to `tests/proxyStack.ts`**

Insert immediately after the `ProxyStack` interface (after line 38):

```typescript
export interface ProxyStackOptions {
  /** Omit for --no-forward on 18080/18443 — today's default, and every proxy-stack caller. */
  forward?: { isolationName: string };
  extraArgs?: string[];
}

/**
 * --no-forward disables the gateway's non-loopback listener, the DNS responder,
 * and the DHCP server together, and run-hosting rejects it alongside
 * --isolation-name. So the two are alternatives, never both.
 */
export function buildForwardArgs(options: ProxyStackOptions): string[] {
  return options.forward ? ['--isolation-name', options.forward.isolationName] : ['--no-forward'];
}

/**
 * ENVOY_HTTP_PORT/ENVOY_HTTPS_PORT are misleadingly named: they are the
 * *gateway's* listen ports, and startGateway opens one port pair across every
 * address in listenAddresses. A forwarding stack therefore cannot give the
 * adapter :443 and loopback :18443 — it takes the 80/443 defaults on both, and
 * leaving these unset is how it gets them.
 */
export function buildGatewayPortEnv(options: ProxyStackOptions): NodeJS.ProcessEnv {
  return options.forward
    ? {}
    : { ENVOY_HTTP_PORT: String(HTTP_PORT), ENVOY_HTTPS_PORT: String(HTTPS_PORT) };
}
```

- [ ] **Step 4: Rewrite `startProxyStack`'s signature and the two places it used the old inputs**

Replace line 116:

```typescript
export async function startProxyStack(options: ProxyStackOptions = {}): Promise<ProxyStack> {
```

Replace the `composeEnv` block (lines 119-123):

```typescript
  const composeEnv = { ...process.env, ...buildGatewayPortEnv(options) };
```

Replace the flag block inside the `execa` argv (lines 160-170) — `--no-forward` on line 161 goes, `buildForwardArgs` replaces it, and `extraArgs` still appends last:

```typescript
      cliPath,
      'run-hosting',
      '--no-refresh',
      ...buildForwardArgs(options),
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `auth-candidate.test=host.docker.internal:${mockUpstream.port}`,
      ...(options.extraArgs ?? []),
```

- [ ] **Step 5: Update the two `proxy-stack` call sites**

`tests/proxy-stack/allowlistEnforcement.test.ts:22` keeps `startProxyStack()` unchanged — the default is exactly today's behaviour, which is the point of the default.

`tests/proxy-stack/skipAllowList.test.ts:15`:

```typescript
  stack = await startProxyStack({ extraArgs: ['--skip-allow-list'] });
```

`tests/guest/guest.test.ts:93` keeps `startProxyStack()` unchanged too. (Task 12 deletes this file; leaving it untouched here keeps this task's diff to the signature change alone.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm vitest run tests/unit/proxyStackOptions.test.ts`
Expected: PASS, 5 tests.

Then, with Docker running: `pnpm build && pnpm test:proxy-stack`
Expected: PASS. Every proxy-stack file must behave exactly as before — that is the whole requirement of this task.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/proxyStack.ts tests/proxy-stack/skipAllowList.test.ts tests/unit/proxyStackOptions.test.ts
git commit -m "test: give startProxyStack an options object, defaulting to today's behaviour"
```

---

## Task 3: Relocate the three lifecycle assertions into `proxy-stack`

**Files:**

- Create: `tests/proxy-stack/policyReloadLifecycle.test.ts`
- Test: the same file (this tier's tests are the deliverable)

**Interfaces:**

- Consumes: `startProxyStack`, `stopProxyStack`, `waitForProxyLine`, `countProxyLines`, `writeStackCredentials`, `HTTPS_PORT`, `HTTP_PORT`, `PLACEHOLDER_AUTH`, `type ProxyStack` — all existing exports of `tests/proxyStack.ts`.
- Produces: nothing consumed by later tasks.

These three assertions live in `tests/guest/guest.test.ts:382`, `:389`, and `:413` today. They drive host-side traffic and observe host-side log output — `testing.md:29-36` places that in `proxy-stack`, so the current placement is already a tier violation. They land here **before** Task 12 deletes `guest.test.ts`, so there is no window where the behaviour is uncovered.

`tests/proxy-stack/stackLifecycle.test.ts` covers the blue/green swap and token rotation but **not** the allowlist-edit restart, the log-follow re-attachment, or unique-tracking reset/preserve — hence a new file rather than an addition to that one. It also runs its own hand-rolled `run-hosting` on 18543/18180 rather than using `startProxyStack`, so it cannot host these.

The one real cost: today this traffic originates in a guest, so "the follow re-attached" is proven end-to-end through the forwarder. Driven from `127.0.0.1:HTTPS_PORT` it is proven only through Envoy. Accepted — the benefit is two 300-second tests off the expensive tier.

- [ ] **Step 1: Write the failing test**

Create `tests/proxy-stack/policyReloadLifecycle.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import {
  startProxyStack,
  stopProxyStack,
  waitForProxyLine,
  countProxyLines,
  writeStackCredentials,
  HTTPS_PORT,
  PLACEHOLDER_AUTH,
  type ProxyStack,
} from '../proxyStack';

let stack: ProxyStack;

beforeAll(async () => {
  stack = await startProxyStack();
}, 120_000);

afterAll(async () => {
  if (stack) await stopProxyStack(stack);
}, 60_000);

/**
 * HEAD, and the socket forced closed once a response arrives: pypi.org/simple/
 * is a ~44 MB index whose body never completes within a sane window, and it is
 * the connection close that flushes Envoy's tcp_proxy access log — which is the
 * only thing these tests observe.
 */
function passthroughProbe(): Promise<void> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        method: 'HEAD',
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'pypi.org',
        path: '/simple/',
        headers: { host: 'pypi.org' },
      },
      (res) => {
        res.resume();
        req.destroy();
        resolve();
      },
    );
    req.on('error', () => resolve());
    req.end();
  });
}

function claudeProbe(): Promise<void> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: stack.caCertPem,
        path: '/',
        headers: { authorization: PLACEHOLDER_AUTH },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.end();
  });
}

describe('proxy stack policy reload & log follow', () => {
  it('streams a unique tagged line per host+handling', async () => {
    await passthroughProbe();
    await claudeProbe();
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 60_000);
    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 60_000);
  }, 120_000);

  it('an allowlist edit restarts the proxy, re-attaches the follow, and resets unique tracking', async () => {
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');
    expect(pypiBefore).toBeGreaterThan(0);
    const mark = stack.stdoutLines.length;

    // The staged fixture ends with the '#pragma claude authenticated' section, so
    // appending adds a claude-authenticated host — the TLS-terminated host set
    // changes and the leaf-reissue path runs too, not just the config rebuild.
    appendFileSync(stack.allowListPath, 'example.org:443\n');

    await waitForProxyLine(stack, 'restarting proxy — policy changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);

    await passthroughProbe();

    // The same host+handling prints again only because unique tracking was
    // cleared — and the line only reaches us because the follow re-attached to
    // the freshly recreated container.
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 60_000, mark);
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore + 1);
  }, 300_000);

  it('a credential rotation restarts the proxy and preserves unique tracking', async () => {
    const mark = stack.stdoutLines.length;
    writeStackCredentials(stack, 'rotated-proxy-stack-token');

    await waitForProxyLine(stack, 'restarting proxy — claude credentials changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');

    // pypi.org was re-logged after the allowlist restart above, so it is in the
    // preserved unique map: this request must NOT produce a new line.
    await passthroughProbe();
    // api.anthropic.com has NOT been logged since that allowlist reset, so it
    // does print — proving the follow re-attached after this restart too.
    await claudeProbe();

    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 60_000, mark);
    // Envoy logs in request order: the api.anthropic.com line arriving means any
    // pypi line would already be here. It is not: unique was preserved.
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore);
  }, 300_000);
});
```

- [ ] **Step 2: Run the file to verify it passes**

Run (Docker up, `run-hosting` stopped): `pnpm build && pnpm vitest run --config vitest.proxy-stack.config.ts tests/proxy-stack/policyReloadLifecycle.test.ts`
Expected: PASS, 3 tests.

If the first test times out waiting for `ALLOW PASS  pypi.org`, the passthrough probe is not flushing the access log — check that `req.destroy()` is still being called in the response handler, since that is what closes the connection.

- [ ] **Step 3: Delete the three now-duplicated tests from the guest suite**

In `tests/guest/guest.test.ts`, delete the entire `describe('proxy stack access logging & replacement', …)` block (lines 381-436). The imports it was the sole user of — `waitForProxyLine`, `countProxyLines`, `writeStackCredentials` — become unused; remove them from the import list at lines 6-17, leaving:

```typescript
import {
  startProxyStack,
  stopProxyStack,
  HTTP_PORT,
  HTTPS_PORT,
  PLACEHOLDER_AUTH,
  REAL_AUTH,
  type ProxyStack,
} from '../proxyStack';
```

Also delete the `describe('passthrough destination resolution after proxy warmup', …)` block (lines 343-379) and the now-unused `guestProbe` helper (lines 69-85). Per the spec's disposition table, `:364` is an artifact of a closed investigation, not a regression test.

- [ ] **Step 4: Run the full guest suite one last time on the old harness**

Run (WSL2/KVM still set up): `pnpm test:guest`
Expected: PASS. This is the last time the WSL harness runs; a green result here is what makes Task 12's deletion safe.

If the WSL prerequisites are no longer available on this machine, run `pnpm typecheck && pnpm lint` instead and note in the commit message that the guest tier was not re-run. Do not skip Step 2.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/proxy-stack/policyReloadLifecycle.test.ts tests/guest/guest.test.ts
git commit -m "test: move the policy-reload and log-follow assertions to proxy-stack"
```

---

## Task 4: SPIKE — prove a Gen 2 VM boots the extracted-ISO installer disk

**Files:**

- Create: nothing committed except the doc comment in Step 8.
- Modify: nothing (unless Step 7 fails — see its contingency).

**Interfaces:**

- Consumes: nothing.
- Produces: a verified command sequence that Task 5 encodes as `buildXCommand()` functions, and a recorded answer to risk 1.

This is the load-bearing novelty of the whole design and **everything downstream is worthless if it fails**, so it runs by hand before any harness code exists. Run every step in an **elevated PowerShell**. Working directory: anywhere with ~10 GB free; the commands below use `C:\spike`.

Four unknowns settle here at once: whether UEFI boots a hand-assembled FAT32 ESP at all, whether `Set-Partition -GptType` after formatting produces a bootable ESP, whether casper locates its squashfs on a non-ISO9660 volume, and whether `/casper/vmlinuz` and `/casper/initrd` are the right paths for 26.04 live-server.

- [ ] **Step 1: Download and verify the ISO**

```powershell
New-Item -ItemType Directory -Force C:\spike | Out-Null
Invoke-WebRequest -Uri 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso' -OutFile 'C:\spike\ubuntu-26.04-live-server-amd64.iso'
Invoke-WebRequest -Uri 'https://releases.ubuntu.com/26.04/SHA256SUMS' -OutFile 'C:\spike\SHA256SUMS'
$expected = ((Get-Content C:\spike\SHA256SUMS) -match 'ubuntu-26\.04-live-server-amd64\.iso$') -split '\s+' | Select-Object -First 1
$actual = (Get-FileHash C:\spike\ubuntu-26.04-live-server-amd64.iso -Algorithm SHA256).Hash
"$expected`n$actual"
```

Expected: the two hashes match, case-insensitively (`Get-FileHash` returns upper case, `SHA256SUMS` lower). Record the exact `SHA256SUMS` line format you saw — Task 7's parser is written against it.

- [ ] **Step 2: Create and format the installer VHDX as basic data**

```powershell
$vhd = 'C:\spike\installer.vhdx'
New-VHD -Path $vhd -SizeBytes 4GB -Dynamic | Out-Null
$disk = Mount-VHD -Path $vhd -Passthru | Initialize-Disk -PartitionStyle GPT -PassThru
$part = $disk | New-Partition -UseMaximumSize -AssignDriveLetter
Format-Volume -Partition $part -FileSystem FAT32 -NewFileSystemLabel 'INSTALLER' -Confirm:$false | Out-Null
$installerDrive = "$($part.DriveLetter):"
$installerDrive
```

Expected: a drive letter, e.g. `E:`. If `New-Partition` fails with "The size of the extent is less than the minimum", the VHD did not initialize — re-run `Mount-VHD`/`Initialize-Disk`.

**This is deviation 1 from the spec.** The partition is created as basic data on purpose: an EFI System Partition is hidden from Windows volume enumeration, so `-AssignDriveLetter` does not reliably give it a letter, and without a letter there is nothing to copy into. The ESP type is applied in Step 5, after the files are in place.

- [ ] **Step 3: Copy the whole ISO tree onto it**

```powershell
$iso = Mount-DiskImage -ImagePath 'C:\spike\ubuntu-26.04-live-server-amd64.iso' -PassThru
$isoDrive = "$(($iso | Get-Volume).DriveLetter):"
Copy-Item -Path "$isoDrive\*" -Destination "$installerDrive\" -Recurse -Force
Dismount-DiskImage -ImagePath 'C:\spike\ubuntu-26.04-live-server-amd64.iso' | Out-Null
Get-ChildItem "$installerDrive\casper\vmlinuz","$installerDrive\casper\initrd","$installerDrive\EFI\BOOT\BOOTX64.EFI" | Select-Object FullName,Length
```

Expected: all three exist. **Record the exact `casper` filenames** — if 26.04 ships `initrd.lz` or `vmlinuz.efi` rather than the bare names, Task 5's `grub.cfg` generator must use what you actually see here, not what this plan assumes.

If `Copy-Item` fails on a single file with "There is not enough space", check its size: FAT32 caps a single file at 4 GB (risk 2). At a 2.7 GB ISO the largest member is the ~2.5 GB `casper/*.squashfs`, so this should not fire yet.

- [ ] **Step 4: Overwrite `boot/grub/grub.cfg`**

```powershell
@'
set timeout=1
menuentry "autoinstall" {
  linux  /casper/vmlinuz autoinstall console=ttyS0,115200 ---
  initrd /casper/initrd
}
'@ | Set-Content -Path "$installerDrive\boot\grub\grub.cfg" -Encoding ascii -NoNewline:$false
Get-Content "$installerDrive\boot\grub\grub.cfg"
```

Expected: the five lines echoed back. `console=ttyS0,115200` is what makes Step 7 observable rather than a black box.

- [ ] **Step 5: Retype the partition as an EFI System Partition and dismount**

```powershell
$ESP = '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'
Set-Partition -DiskNumber $part.DiskNumber -PartitionNumber $part.PartitionNumber -GptType $ESP
Get-Partition -DiskNumber $part.DiskNumber -PartitionNumber $part.PartitionNumber | Select-Object GptType,Size
Dismount-VHD -Path $vhd
```

Expected: `GptType` reads back as `{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}`.

- [ ] **Step 6: Create the throwaway build VM**

```powershell
New-VM -Name 'spike-installer-boot' -Generation 2 -MemoryStartupBytes 2GB -SwitchName 'Default Switch' -NoVHD | Out-Null
Add-VMHardDiskDrive -VMName 'spike-installer-boot' -Path $vhd
Set-VMFirmware -VMName 'spike-installer-boot' -EnableSecureBoot Off
Set-VMFirmware -VMName 'spike-installer-boot' -FirstBootDevice (Get-VMHardDiskDrive -VMName 'spike-installer-boot')
Set-VMProcessor -VMName 'spike-installer-boot' -Count 2
Set-VMComPort -VMName 'spike-installer-boot' -Number 1 -Path '\\.\pipe\spike-installer-boot'
```

Secure Boot is **off** for the build VM only: it boots a hand-assembled disk — the one place a signature policy could bite — during the step we can least observe. Per-test guests get it back on in Task 9.

- [ ] **Step 7: Boot it and watch the serial console**

Start the VM, then attach a pipe reader in a **second** elevated PowerShell window (Hyper-V creates the pipe only while the VM runs, so the reader must start after `Start-VM` and retry-connect — risk 4):

```powershell
# window 1
Start-VM -Name 'spike-installer-boot'
```

```powershell
# window 2
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream '.', 'spike-installer-boot', 'In'
$pipe.Connect(30000)
$reader = New-Object System.IO.StreamReader $pipe
while (($line = $reader.ReadLine()) -ne $null) { $line | Tee-Object -FilePath C:\spike\serial.log -Append }
```

Expected, in order: GRUB's `autoinstall` menu entry, a Linux kernel boot log, casper mounting the squashfs, and subiquity starting. **Reaching subiquity is the success condition** — it proves the ESP booted, GRUB parsed the hand-written config, the kernel and initrd paths were right, and casper found its squashfs on a non-ISO9660 volume.

Contingencies, in the order they are worth trying:

- **Nothing on serial, VM sits at a firmware screen.** The ESP is not being recognised. Try creating the partition with `-GptType $ESP` at `New-Partition` time and assigning a letter explicitly with `-DriveLetter E`; if that also fails, the fallback is `-GptType $ESP` plus `mountvol E: /S` to mount the ESP for copying. Record which one worked — Task 5 encodes it.
- **GRUB reaches a `grub>` prompt.** `grub.cfg` was written to the wrong path. Check whether 26.04's UEFI loader reads `/boot/grub/grub.cfg` or `/EFI/BOOT/grub.cfg`, and write both.
- **`error: file '/casper/vmlinuz' not found`.** Step 3's recorded filenames are what to use.
- **Kernel panics with "Unable to find a medium containing a live file system".** casper cannot see the volume; add `--- ` after `autoinstall` (already present) and confirm the FAT32 volume label — if casper needs a specific label, set `-NewFileSystemLabel` to the ISO's own volume label from Step 3's `$isoDrive`.

- [ ] **Step 8: Record the findings and tear down**

```powershell
Stop-VM -Name 'spike-installer-boot' -TurnOff -Force
Remove-VM -Name 'spike-installer-boot' -Force
Remove-Item C:\spike\installer.vhdx
```

Keep `C:\spike\ubuntu-26.04-live-server-amd64.iso` — Task 8 needs it, and re-downloading 2.7 GB to prove nothing is wasted time. Move it to the repo's cache instead:

```powershell
New-Item -ItemType Directory -Force <repo>\.image-cache | Out-Null
Move-Item C:\spike\ubuntu-26.04-live-server-amd64.iso <repo>\.image-cache\
```

There is nothing to commit from this task unless a contingency fired. If one did, commit only the corrected knowledge as a doc comment at the top of `tests/guest/hyperv/vhd.ts` in Task 5 — do not leave the finding in a scratch file.

---

## Task 5: `.image-cache` paths and the VHD/partition PowerShell builders

**Files:**

- Create: `tests/guest/hyperv/imageCache.ts`
- Create: `tests/guest/hyperv/vhd.ts`
- Test: `tests/unit/guest/vhd.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` from `src/guestSetup/quoteForPowerShell`; `PowerShellExec` from `src/guestSetup/powerShellExec`; `repoRoot` from `tests/testEnvRoot`.
- Produces:
  ```typescript
  // tests/guest/hyperv/imageCache.ts
  export type GuestRole = 'phases' | 'e2e' | 'fresh';
  export const ISOLATION_NAME = 'test';
  export const NAME_PREFIX = 'susentorno-test';
  export const imageCacheDir: string;
  export const isoUrl: string;
  export const isoPath: string;
  export const sha256SumsUrl: string;
  export const goldenVhdPath: string;
  export const goldenStampPath: string;
  export const goldenBuildSerialLogPath: string;
  export const harnessKeyPath: string;
  export const guestHostKeyPath: string;
  export function roleVhdPath(role: GuestRole): string;
  export function roleVmName(role: GuestRole): string;
  export function rolePipeName(role: GuestRole): string;

  // tests/guest/hyperv/vhd.ts
  export const EFI_SYSTEM_PARTITION_GPT_TYPE: string;
  export function buildNewVhdCommand(path: string, sizeBytes: number): string;
  export function buildNewDifferencingVhdCommand(path: string, parentPath: string): string;
  export function buildCreateFat32VolumeCommand(vhdPath: string, label: string): string;
  export function parsePartitionHandle(stdout: string): { driveLetter: string; diskNumber: number; partitionNumber: number };
  export function buildSetEspTypeCommand(diskNumber: number, partitionNumber: number): string;
  export function buildDismountVhdCommand(vhdPath: string): string;
  export function buildMountIsoCommand(isoPath: string): string;
  export function parseIsoDriveLetter(stdout: string): string;
  export function buildDismountIsoCommand(isoPath: string): string;
  export function buildCopyTreeCommand(fromDrive: string, toDrive: string): string;
  ```

Every builder is a pure string function so it can be asserted in the `unit` tier without Hyper-V; only the executors that feed them to `PowerShellExec` need a real host, and those are covered by the tier running at all — the same bargain `tests/host-network/` already accepts.

The multi-step commands return machine-readable JSON (`ConvertTo-Json -Compress`) rather than formatted text, matching `src/guestSetup/hyperVQueries.ts`'s existing shape, so the parsers are exact rather than regex-scraping.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/vhd.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  EFI_SYSTEM_PARTITION_GPT_TYPE,
  buildNewVhdCommand,
  buildNewDifferencingVhdCommand,
  buildCreateFat32VolumeCommand,
  parsePartitionHandle,
  buildSetEspTypeCommand,
  buildDismountVhdCommand,
  buildMountIsoCommand,
  parseIsoDriveLetter,
  buildDismountIsoCommand,
  buildCopyTreeCommand,
} from '../../guest/hyperv/vhd';

describe('VHD creation commands', () => {
  it('creates a dynamic VHD at an exact byte size', () => {
    expect(buildNewVhdCommand('C:\\x\\installer.vhdx', 4 * 1024 ** 3)).toBe(
      "New-VHD -Path 'C:\\x\\installer.vhdx' -SizeBytes 4294967296 -Dynamic | Out-Null",
    );
  });

  it('creates a differencing VHD against a parent', () => {
    expect(
      buildNewDifferencingVhdCommand('C:\\x\\susentorno-test-e2e.vhdx', 'C:\\x\\golden.vhdx'),
    ).toBe(
      "New-VHD -Path 'C:\\x\\susentorno-test-e2e.vhdx' -ParentPath 'C:\\x\\golden.vhdx' " +
        '-Differencing | Out-Null',
    );
  });

  it("doubles embedded single quotes rather than breaking out of PowerShell's string", () => {
    expect(buildNewVhdCommand("C:\\o'brien\\d.vhdx", 1024)).toContain("'C:\\o''brien\\d.vhdx'");
  });
});

describe('buildCreateFat32VolumeCommand', () => {
  const command = buildCreateFat32VolumeCommand('C:\\x\\installer.vhdx', 'CIDATA');

  it('initializes GPT, takes the maximum size, and formats FAT32 with the label', () => {
    expect(command).toContain("Mount-VHD -Path 'C:\\x\\installer.vhdx' -Passthru");
    expect(command).toContain('Initialize-Disk -PartitionStyle GPT -PassThru');
    expect(command).toContain('New-Partition -UseMaximumSize -AssignDriveLetter');
    expect(command).toContain('-FileSystem FAT32');
    expect(command).toContain("-NewFileSystemLabel 'CIDATA'");
    expect(command).toContain('-Confirm:$false');
  });

  it('creates a basic-data partition, NOT an ESP — the type is applied after copying', () => {
    expect(command).not.toContain(EFI_SYSTEM_PARTITION_GPT_TYPE);
  });

  it('returns the drive letter and the disk/partition numbers as compressed JSON', () => {
    expect(command).toContain('ConvertTo-Json -Compress');
    expect(command).toContain('DriveLetter');
    expect(command).toContain('DiskNumber');
    expect(command).toContain('PartitionNumber');
  });
});

describe('parsePartitionHandle', () => {
  it('parses the JSON the create command emits', () => {
    expect(
      parsePartitionHandle('{"DriveLetter":"E","DiskNumber":3,"PartitionNumber":1}'),
    ).toEqual({ driveLetter: 'E', diskNumber: 3, partitionNumber: 1 });
  });

  it('throws with the raw output when no drive letter came back', () => {
    expect(() => parsePartitionHandle('{"DriveLetter":null,"DiskNumber":3,"PartitionNumber":1}')).toThrow(
      /no drive letter/,
    );
  });

  it('throws with the raw output when nothing came back at all', () => {
    expect(() => parsePartitionHandle('   ')).toThrow(/no drive letter/);
  });
});

describe('buildSetEspTypeCommand', () => {
  it('retypes the partition as an EFI System Partition by disk and partition number', () => {
    expect(buildSetEspTypeCommand(3, 1)).toBe(
      "Set-Partition -DiskNumber 3 -PartitionNumber 1 -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'",
    );
  });

  it('uses the EFI System Partition GUID, not New-Partitions default basic-data type', () => {
    expect(EFI_SYSTEM_PARTITION_GPT_TYPE).toBe('{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}');
  });
});

describe('ISO mounting', () => {
  it('mounts an ISO and reports its drive letter as JSON', () => {
    const command = buildMountIsoCommand('C:\\x\\ubuntu.iso');
    expect(command).toContain("Mount-DiskImage -ImagePath 'C:\\x\\ubuntu.iso' -PassThru");
    expect(command).toContain('Get-Volume');
    expect(command).toContain('ConvertTo-Json -Compress');
  });

  it('parses the mounted drive letter', () => {
    expect(parseIsoDriveLetter('{"DriveLetter":"F"}')).toBe('F');
  });

  it('throws when the ISO mounted with no drive letter', () => {
    expect(() => parseIsoDriveLetter('{"DriveLetter":null}')).toThrow(/no drive letter/);
  });

  it('dismounts by image path, which is the only handle Dismount-DiskImage takes', () => {
    expect(buildDismountIsoCommand('C:\\x\\ubuntu.iso')).toBe(
      "Dismount-DiskImage -ImagePath 'C:\\x\\ubuntu.iso' | Out-Null",
    );
  });
});

describe('buildCopyTreeCommand', () => {
  it('copies the whole tree recursively, contents-first', () => {
    expect(buildCopyTreeCommand('F', 'E')).toBe(
      "Copy-Item -Path 'F:\\*' -Destination 'E:\\' -Recurse -Force",
    );
  });
});

describe('buildDismountVhdCommand', () => {
  it('dismounts by path', () => {
    expect(buildDismountVhdCommand('C:\\x\\installer.vhdx')).toBe(
      "Dismount-VHD -Path 'C:\\x\\installer.vhdx'",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/vhd.test.ts`
Expected: FAIL — `Cannot find module '../../guest/hyperv/vhd'`.

- [ ] **Step 3: Write `tests/guest/hyperv/imageCache.ts`**

```typescript
import { join } from 'node:path';
import { repoRoot } from '../../testEnvRoot';

/** The three per-test guests. One differencing disk and one VM each. */
export type GuestRole = 'phases' | 'e2e' | 'fresh';

/**
 * One isolation name derives everything this tier touches on the host — the
 * Internal switch and its firewall rules (create-host-network's), plus the VM
 * names, differencing disks, Windows local account, and SMB share below. That
 * is what makes all of it discoverable and sweepable from one string.
 */
export const ISOLATION_NAME = 'test';
export const NAME_PREFIX = `susentorno-${ISOLATION_NAME}`;

/**
 * Repo-local rather than under %LOCALAPPDATA%: this project avoids git
 * worktrees (its live tiers act on one shared host network adapter, so
 * parallel checkouts could not run tests concurrently anyway), so the usual
 * "every worktree rebuilds its own multi-GB image" objection cannot arise.
 * Gitignored and prettier-ignored. No environment-variable override — there is
 * no second consumer.
 */
export const imageCacheDir = join(repoRoot, '.image-cache');

export const isoUrl = 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso';
export const sha256SumsUrl = 'https://releases.ubuntu.com/26.04/SHA256SUMS';
export const isoPath = join(imageCacheDir, 'ubuntu-26.04-live-server-amd64.iso');

export const goldenVhdPath = join(imageCacheDir, `${NAME_PREFIX}-golden.vhdx`);
export const goldenStampPath = `${goldenVhdPath}.stamp`;
/**
 * Deliberately not under test-results/<timestamp>/: a failed build's log has to
 * still be there on the next run, and a per-run directory cannot do that.
 */
export const goldenBuildSerialLogPath = join(imageCacheDir, 'golden-build-serial.log');

/** The client key ssh-agent gets; its public half is baked into the image. */
export const harnessKeyPath = join(imageCacheDir, 'harness_ed25519');
/** The guest's own SSH host key, generated here and installed into the image. */
export const guestHostKeyPath = join(imageCacheDir, 'guest_host_ed25519');

export function roleVhdPath(role: GuestRole): string {
  return join(imageCacheDir, `${NAME_PREFIX}-${role}.vhdx`);
}

export function roleVmName(role: GuestRole): string {
  return `${NAME_PREFIX}-${role}`;
}

export function rolePipeName(role: GuestRole): string {
  return `${NAME_PREFIX}-${role}`;
}
```

- [ ] **Step 4: Write `tests/guest/hyperv/vhd.ts`**

```typescript
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/**
 * A Generation 2 VM's UEFI firmware boots through an EFI System Partition, and
 * New-Partition creates a basic-data partition by default. Some firmware will
 * scan the fallback \EFI\BOOT\BOOTX64.EFI path on a basic-data FAT32 partition,
 * but the golden build must not rest on that.
 *
 * The type is nonetheless applied LAST, by buildSetEspTypeCommand, not at
 * New-Partition time: Windows hides an ESP from volume enumeration, so
 * -AssignDriveLetter does not reliably give it a letter — and without a letter
 * there is nothing to Copy-Item the ISO tree into. Create as basic data, format,
 * populate, then retype. The finished on-disk layout is identical, which is all
 * the firmware sees.
 */
export const EFI_SYSTEM_PARTITION_GPT_TYPE = '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}';

export function buildNewVhdCommand(path: string, sizeBytes: number): string {
  return `New-VHD -Path ${quoteForPowerShell(path)} -SizeBytes ${sizeBytes} -Dynamic | Out-Null`;
}

/**
 * Hyper-V stamps parent identity into each child, so the golden VHDX must never
 * be booted or modified after the build — touching it invalidates every overlay.
 */
export function buildNewDifferencingVhdCommand(path: string, parentPath: string): string {
  return (
    `New-VHD -Path ${quoteForPowerShell(path)} -ParentPath ${quoteForPowerShell(parentPath)} ` +
    `-Differencing | Out-Null`
  );
}

/**
 * Mount, GPT-initialize, take the whole disk as one basic-data partition, format
 * FAT32, and report back the handle the caller needs for both halves of what
 * follows: the drive letter to copy into, and the disk/partition numbers
 * Set-Partition takes (it has no -DriveLetter parameter).
 */
export function buildCreateFat32VolumeCommand(vhdPath: string, label: string): string {
  return (
    `$d = Mount-VHD -Path ${quoteForPowerShell(vhdPath)} -Passthru | ` +
    `Initialize-Disk -PartitionStyle GPT -PassThru; ` +
    `$p = $d | New-Partition -UseMaximumSize -AssignDriveLetter; ` +
    `Format-Volume -Partition $p -FileSystem FAT32 ` +
    `-NewFileSystemLabel ${quoteForPowerShell(label)} -Confirm:$false | Out-Null; ` +
    `[PSCustomObject]@{ DriveLetter = $p.DriveLetter; DiskNumber = $p.DiskNumber; ` +
    `PartitionNumber = $p.PartitionNumber } | ConvertTo-Json -Compress`
  );
}

export interface PartitionHandle {
  driveLetter: string;
  diskNumber: number;
  partitionNumber: number;
}

interface RawPartitionHandle {
  DriveLetter?: unknown;
  DiskNumber?: unknown;
  PartitionNumber?: unknown;
}

export function parsePartitionHandle(stdout: string): PartitionHandle {
  const trimmed = stdout.trim();
  const raw = (trimmed ? (JSON.parse(trimmed) as RawPartitionHandle) : {}) as RawPartitionHandle;
  if (typeof raw.DriveLetter !== 'string' || raw.DriveLetter === '') {
    throw new Error(`vhd: the new FAT32 volume came back with no drive letter: ${stdout || '<empty>'}`);
  }
  return {
    driveLetter: raw.DriveLetter,
    diskNumber: Number(raw.DiskNumber),
    partitionNumber: Number(raw.PartitionNumber),
  };
}

export function buildSetEspTypeCommand(diskNumber: number, partitionNumber: number): string {
  return (
    `Set-Partition -DiskNumber ${diskNumber} -PartitionNumber ${partitionNumber} ` +
    `-GptType ${quoteForPowerShell(EFI_SYSTEM_PARTITION_GPT_TYPE)}`
  );
}

export function buildDismountVhdCommand(vhdPath: string): string {
  return `Dismount-VHD -Path ${quoteForPowerShell(vhdPath)}`;
}

export function buildMountIsoCommand(isoPath: string): string {
  return (
    `$i = Mount-DiskImage -ImagePath ${quoteForPowerShell(isoPath)} -PassThru; ` +
    `[PSCustomObject]@{ DriveLetter = ($i | Get-Volume).DriveLetter } | ConvertTo-Json -Compress`
  );
}

export function parseIsoDriveLetter(stdout: string): string {
  const trimmed = stdout.trim();
  const raw = (trimmed ? (JSON.parse(trimmed) as { DriveLetter?: unknown }) : {}) as {
    DriveLetter?: unknown;
  };
  if (typeof raw.DriveLetter !== 'string' || raw.DriveLetter === '') {
    throw new Error(`vhd: the ISO mounted with no drive letter: ${stdout || '<empty>'}`);
  }
  return raw.DriveLetter;
}

/** Dismount-DiskImage takes the image path, never a drive letter or a handle. */
export function buildDismountIsoCommand(isoPath: string): string {
  return `Dismount-DiskImage -ImagePath ${quoteForPowerShell(isoPath)} | Out-Null`;
}

/** `X:\*`, not `X:\` — copying the drive root itself would nest a directory. */
export function buildCopyTreeCommand(fromDrive: string, toDrive: string): string {
  return (
    `Copy-Item -Path ${quoteForPowerShell(`${fromDrive}:\\*`)} ` +
    `-Destination ${quoteForPowerShell(`${toDrive}:\\`)} -Recurse -Force`
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/vhd.test.ts`
Expected: PASS, 17 tests.

If Task 4's Step 7 hit a contingency, change the implementation to match what actually booted and change these assertions with it — the spike's result wins over this plan's assumption.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/hyperv/imageCache.ts tests/guest/hyperv/vhd.ts tests/unit/guest/vhd.test.ts
git commit -m "test: VHD, partition, and ISO PowerShell builders for the Hyper-V guest harness"
```

---

## Task 6: Harness keypairs and the autoinstall seed generators

**Files:**

- Create: `tests/guest/harnessKeys.ts`
- Create: `tests/guest/autoinstall.ts`
- Test: `tests/unit/guest/autoinstall.test.ts`

**Interfaces:**

- Consumes: `harnessKeyPath`, `guestHostKeyPath`, `imageCacheDir` from `tests/guest/hyperv/imageCache`.
- Produces:
  ```typescript
  // tests/guest/harnessKeys.ts
  export interface HarnessKeys {
    harnessPrivateKeyPath: string;
    harnessPublicKey: string;
    guestHostPrivateKey: string;
    guestHostPublicKey: string;
  }
  export function ensureHarnessKeys(): Promise<HarnessKeys>;

  // tests/guest/autoinstall.ts
  export const GUEST_USERNAME = 'vmtest';
  export const GUEST_HOSTNAME = 'susentorno-test-guest';
  export function buildGrubCfg(): string;
  export function buildMetaData(): string;
  export interface AutoinstallInputs {
    harnessPublicKey: string;
    guestHostPrivateKey: string;
    guestHostPublicKey: string;
  }
  export function buildUserData(inputs: AutoinstallInputs): string;
  ```

**Two keypairs, generated on the Windows side, both baked into the image.** The *client* key's public half goes into `authorized_keys` so ~20 `ssh`/`scp` calls per run do not prompt. The *host* key is generated here and installed into `/target/etc/ssh/`, which is the whole reason `knownHosts.ts` (Task 10) can write an exact `known_hosts` entry rather than trusting whatever answers first — the harness **knows** the key rather than discovering it.

`autoinstall.ts` is a set of generators, not the `autoinstall/` directory of static files the spec's module list implies: both public keys are generated at run time and must be interpolated in (deviation 3).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/autoinstall.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import {
  GUEST_USERNAME,
  GUEST_HOSTNAME,
  buildGrubCfg,
  buildMetaData,
  buildUserData,
} from '../../guest/autoinstall';

const inputs = {
  harnessPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHARNESS harness@susentorno',
  guestHostPrivateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
  guestHostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOSTKEY susentorno-test-guest',
};

describe('buildGrubCfg', () => {
  it('carries the autoinstall kernel parameter, without which subiquity stops at a prompt', () => {
    expect(buildGrubCfg()).toBe(
      [
        'set timeout=1',
        'menuentry "autoinstall" {',
        '  linux  /casper/vmlinuz autoinstall console=ttyS0,115200 ---',
        '  initrd /casper/initrd',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('puts the kernel console on ttyS0 so the build is observable over the COM pipe', () => {
    expect(buildGrubCfg()).toContain('console=ttyS0,115200');
  });
});

describe('buildMetaData', () => {
  it('is valid YAML naming the instance and the hostname', () => {
    expect(parse(buildMetaData())).toEqual({
      'instance-id': 'susentorno-test-golden',
      'local-hostname': GUEST_HOSTNAME,
    });
  });
});

describe('buildUserData', () => {
  const yaml = buildUserData(inputs);
  const parsed = parse(yaml) as any;
  const ai = parsed.autoinstall;

  it('is a #cloud-config document with an autoinstall section', () => {
    expect(yaml.startsWith('#cloud-config\n')).toBe(true);
    expect(ai.version).toBe(1);
  });

  it('supplies all three identity fields autoinstall requires, with a locked password', () => {
    expect(ai.identity.username).toBe(GUEST_USERNAME);
    expect(ai.identity.hostname).toBe(GUEST_HOSTNAME);
    // '!' is the crypt(3) locked marker. Nothing ever prompts for it: allow-pw
    // is false and sudo is NOPASSWD.
    expect(ai.identity.password).toBe('!');
  });

  it('installs the harness public key and disables password auth', () => {
    expect(ai.ssh['install-server']).toBe(true);
    expect(ai.ssh['allow-pw']).toBe(false);
    expect(ai.ssh['authorized-keys']).toEqual([inputs.harnessPublicKey]);
  });

  it('disambiguates the three build disks by size, never by device name', () => {
    expect(ai.storage.layout).toEqual({ name: 'direct', match: { size: 'largest' } });
  });

  it('bakes in the packages that cannot be installed later', () => {
    // network-manager: production guests are Desktop, which uses it as the
    // netplan renderer. jq: nn-configure-network.sh's firefox policies merge.
    // linux-cloud-tools-virtual: KVP, and KVP cannot be installed before the
    // guest is reachable, which is what discovers its address.
    expect(ai.packages).toEqual(
      expect.arrayContaining(['network-manager', 'jq', 'linux-cloud-tools-virtual']),
    );
  });

  it('deliberately omits cifs-utils, node, pnpm, and dnsmasq', () => {
    // cifs-utils absent so mountShare really installs it; node/pnpm absent so
    // the e2e test really bootstraps a bare Ubuntu; dnsmasq absent because the
    // assertion it existed to fail is deleted with the old harness.
    for (const absent of ['cifs-utils', 'nodejs', 'npm', 'pnpm', 'dnsmasq']) {
      expect(ai.packages).not.toContain(absent);
    }
  });

  it('makes every persistent change either in-target or against an explicit /target path', () => {
    // late-commands run in the LIVE INSTALLER, not the installed system. A bare
    // `apt upgrade`, `systemctl mask`, or `update-grub` would configure the
    // throwaway environment and leave the golden image untouched, silently.
    for (const command of ai['late-commands'] as string[]) {
      expect(
        command.includes('curtin in-target') || command.includes('/target/'),
        command,
      ).toBe(true);
    }
  });

  it('upgrades packages in-target, which is what makes the per-run apt upgrade usually a no-op', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    expect(commands).toContain('curtin in-target --target=/target -- apt-get upgrade -y');
  });

  it('masks systemd-networkd in-target so only NetworkManager owns the link', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    expect(commands).toContain(
      'curtin in-target --target=/target -- systemctl mask systemd-networkd.service',
    );
  });

  it('masks apt-daily and unattended-upgrades in-target', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    expect(commands).toContain('apt-daily.timer');
    expect(commands).toContain('unattended-upgrades.service');
  });

  it('writes a NetworkManager-rendered netplan profile into the target', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    expect(commands).toContain('/target/etc/netplan/01-network-manager-all.yaml');
    expect(commands).toContain('renderer: NetworkManager');
  });

  it('gives the guest user NOPASSWD sudo, since ssh -t gives every command a fresh pty', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    expect(commands).toContain(`${GUEST_USERNAME} ALL=(ALL) NOPASSWD:ALL`);
    expect(commands).toContain('/target/etc/sudoers.d/90-vmtest-nopasswd');
  });

  it('installs the harness-generated host key and removes the installer-generated ones', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    const privB64 = Buffer.from(inputs.guestHostPrivateKey, 'utf8').toString('base64');
    const pubB64 = Buffer.from(inputs.guestHostPublicKey, 'utf8').toString('base64');
    expect(commands).toContain(privB64);
    expect(commands).toContain(pubB64);
    expect(commands).toContain('/target/etc/ssh/ssh_host_ed25519_key');
    // Only ed25519 survives, so which key answers is not left to algorithm
    // negotiation order.
    expect(commands).toContain('/target/etc/ssh/ssh_host_rsa_key');
    expect(commands).toContain('/target/etc/ssh/ssh_host_ecdsa_key');
  });

  it('puts the serial console on the installed system s kernel command line, in-target', () => {
    const commands = (ai['late-commands'] as string[]).join('\n');
    expect(commands).toContain('GRUB_CMDLINE_LINUX_DEFAULT="console=ttyS0,115200"');
    expect(commands).toContain('/target/etc/default/grub');
    expect(commands).toContain('curtin in-target --target=/target -- update-grub');
  });

  it('powers off at the end, which is how the build detects completion', () => {
    expect(ai.shutdown).toBe('poweroff');
  });

  it('moves when any input moves, so the stamp can hash it', () => {
    const other = buildUserData({ ...inputs, harnessPublicKey: 'ssh-ed25519 AAAADIFFERENT x@y' });
    expect(other).not.toBe(yaml);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/autoinstall.test.ts`
Expected: FAIL — `Cannot find module '../../guest/autoinstall'`.

`yaml` is already a production dependency (`package.json:43`), so no install is needed.

- [ ] **Step 3: Write `tests/guest/autoinstall.ts`**

```typescript
export const GUEST_USERNAME = 'vmtest';
export const GUEST_HOSTNAME = 'susentorno-test-guest';

/**
 * Subiquity checks for the `autoinstall` KERNEL PARAMETER before destructively
 * modifying disks; without it the installer stops at a confirmation prompt no
 * matter how the config was delivered. A CIDATA volume supplies the config, but
 * not the consent — which is why the harness authors this file rather than
 * booting the stock ISO with only a seed disk.
 *
 * console=ttyS0,115200 is what makes the 20-minute build observable over the
 * VM's COM1 named pipe rather than a black box.
 */
export function buildGrubCfg(): string {
  return [
    'set timeout=1',
    'menuentry "autoinstall" {',
    '  linux  /casper/vmlinuz autoinstall console=ttyS0,115200 ---',
    '  initrd /casper/initrd',
    '}',
    '',
  ].join('\n');
}

export function buildMetaData(): string {
  return [`instance-id: susentorno-test-golden`, `local-hostname: ${GUEST_HOSTNAME}`, ''].join('\n');
}

export interface AutoinstallInputs {
  harnessPublicKey: string;
  guestHostPrivateKey: string;
  guestHostPublicKey: string;
}

/**
 * Writes a file into the installed system from base64, avoiding YAML block
 * scalars entirely — an OpenSSH private key's indentation and trailing newline
 * survive base64 unambiguously and do not survive a folded scalar.
 */
function writeTargetFileFromBase64(contents: string, targetPath: string, mode: string): string[] {
  const b64 = Buffer.from(contents, 'utf8').toString('base64');
  return [
    `sh -c 'printf %s "${b64}" | base64 -d > ${targetPath}'`,
    `chmod ${mode} ${targetPath}`,
  ];
}

/**
 * The autoinstall config the CIDATA seed volume carries.
 *
 * The single rule that governs late-commands: they run in the LIVE INSTALLER
 * environment, not the installed system, with the target mounted at /target. So
 * every persistent change must go through `curtin in-target -- …` or write an
 * explicit /target/… path. A bare `apt upgrade`, `systemctl mask`,
 * /etc/default/grub edit, or `update-grub` would configure the throwaway
 * installer environment and leave the golden image untouched, silently.
 */
export function buildUserData(inputs: AutoinstallInputs): string {
  const lateCommands: string[] = [
    'curtin in-target --target=/target -- apt-get update',
    // spec 1's lever: doing the upgrade once here means the per-run
    // `01-apt-packages.sh` upgrade usually finds nothing to do.
    'curtin in-target --target=/target -- apt-get upgrade -y',

    // Production guests are Ubuntu Desktop, which renders netplan through
    // NetworkManager; Server defaults to the networkd renderer. The
    // netplan-merge-under-NetworkManager regression class is the reason a real
    // guest is needed at all, so stock Server would be a fidelity REGRESSION
    // against the harness being replaced.
    `sh -c 'printf %s "${Buffer.from(
      [
        'network:',
        '  version: 2',
        '  renderer: NetworkManager',
        '  ethernets:',
        '    all-en:',
        '      match:',
        '        name: "en*"',
        '      dhcp4: true',
        '',
      ].join('\n'),
      'utf8',
    ).toString('base64')}" | base64 -d > /target/etc/netplan/01-network-manager-all.yaml'`,
    'chmod 600 /target/etc/netplan/01-network-manager-all.yaml',
    // Two renderers fighting over one link is what the historical LinkBusy
    // failures were.
    'curtin in-target --target=/target -- systemctl mask systemd-networkd.service systemd-networkd.socket systemd-networkd-wait-online.service',

    // These hold the dpkg lock shortly after boot, and the e2e test's real
    // `apt install` would otherwise sit squarely in that window. This is
    // deliberate AVOIDANCE of the race, not coverage of it.
    'curtin in-target --target=/target -- systemctl mask apt-daily.service apt-daily.timer apt-daily-upgrade.service apt-daily-upgrade.timer unattended-upgrades.service',

    // buildSshRunArgv passes -t, so every remote command gets a fresh pty and
    // sudo's per-tty timestamp never carries. Without NOPASSWD a single run
    // means roughly twenty sudo prompts with nobody to answer them.
    `sh -c 'printf "%s\\n" "${GUEST_USERNAME} ALL=(ALL) NOPASSWD:ALL" > /target/etc/sudoers.d/90-vmtest-nopasswd'`,
    'chmod 440 /target/etc/sudoers.d/90-vmtest-nopasswd',

    // The host key is generated on the Windows side and installed here, so the
    // harness KNOWS the guest's host key by construction and can write an exact
    // known_hosts entry instead of trusting whatever answers first. Generated
    // once, at install — never per guest, which is what makes one known_hosts
    // entry cover all three roles.
    ...writeTargetFileFromBase64(
      inputs.guestHostPrivateKey,
      '/target/etc/ssh/ssh_host_ed25519_key',
      '600',
    ),
    ...writeTargetFileFromBase64(
      inputs.guestHostPublicKey,
      '/target/etc/ssh/ssh_host_ed25519_key.pub',
      '644',
    ),
    // Leaving the installer's RSA/ECDSA host keys in place would make "which key
    // answers" depend on algorithm negotiation order. Only ed25519 survives.
    "sh -c 'rm -f /target/etc/ssh/ssh_host_rsa_key /target/etc/ssh/ssh_host_rsa_key.pub /target/etc/ssh/ssh_host_ecdsa_key /target/etc/ssh/ssh_host_ecdsa_key.pub'",

    // update-grub must run IN-TARGET or console=ttyS0 never reaches the
    // installed system's boot configuration at all — every per-test guest then
    // boots as a black box.
    `sh -c 'sed -i \\'s/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="console=ttyS0,115200"/\\' /target/etc/default/grub'`,
    'curtin in-target --target=/target -- update-grub',
  ];

  return [
    '#cloud-config',
    'autoinstall:',
    '  version: 1',
    '  interactive-sections: []',
    '  locale: en_US.UTF-8',
    '  keyboard:',
    '    layout: us',
    '  identity:',
    '    realname: susentorno test guest',
    `    username: ${GUEST_USERNAME}`,
    `    hostname: ${GUEST_HOSTNAME}`,
    // autoinstall's identity section requires all three fields. '!' is crypt(3)'s
    // locked marker: nothing ever prompts for this password, because allow-pw is
    // false and sudo is NOPASSWD.
    "    password: '!'",
    '  ssh:',
    '    install-server: true',
    '    allow-pw: false',
    '    authorized-keys:',
    `      - ${JSON.stringify(inputs.harnessPublicKey)}`,
    '  storage:',
    '    layout:',
    '      name: direct',
    '      match:',
    '        size: largest',
    '  packages:',
    '    - network-manager',
    '    - jq',
    '    - linux-cloud-tools-virtual',
    '  late-commands:',
    ...lateCommands.map((c) => `    - ${JSON.stringify(c)}`),
    '  shutdown: poweroff',
    '',
  ].join('\n');
}
```

Two details in that generator are load-bearing:

- **`storage.layout.match.size: largest`** is how autoinstall picks the 40 GB target rather than the 4 GB installer or the 64 MB seed. Those three sizes are design constraints, not arbitrary numbers.
- **Every `late-commands` entry is emitted through `JSON.stringify`**, so a command containing quotes, backslashes, or a `#` is a valid YAML double-quoted scalar rather than a parse error or a silently truncated line.

- [ ] **Step 4: Write `tests/guest/harnessKeys.ts`**

```typescript
import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { imageCacheDir, harnessKeyPath, guestHostKeyPath } from './hyperv/imageCache';

export interface HarnessKeys {
  /** Passed to ssh-add; never named ~/.ssh/id_ed25519, which would clobber the developer's. */
  harnessPrivateKeyPath: string;
  harnessPublicKey: string;
  guestHostPrivateKey: string;
  guestHostPublicKey: string;
}

async function ensureKeyPair(path: string, comment: string): Promise<void> {
  if (existsSync(path) && existsSync(`${path}.pub`)) return;
  // -N '' : no passphrase. This key only grants what the throwaway guest's own
  // account already allows, and a passphrase would defeat the unattended run.
  await execa('ssh-keygen', ['-t', 'ed25519', '-f', path, '-N', '', '-C', comment, '-q']);
}

/**
 * Generates (or locates) the two keypairs the tier is built on.
 *
 * Both public keys feed the golden-image stamp, which is why this must run
 * BEFORE ensureGoldenImage: deriving a stamp from a key that does not exist yet
 * is not a thing.
 */
export async function ensureHarnessKeys(): Promise<HarnessKeys> {
  mkdirSync(imageCacheDir, { recursive: true });
  await ensureKeyPair(harnessKeyPath, 'susentorno-guest-tier-harness');
  await ensureKeyPair(guestHostKeyPath, 'susentorno-test-guest-host-key');
  return {
    harnessPrivateKeyPath: harnessKeyPath,
    harnessPublicKey: readFileSync(`${harnessKeyPath}.pub`, 'utf8').trim(),
    guestHostPrivateKey: readFileSync(guestHostKeyPath, 'utf8'),
    guestHostPublicKey: readFileSync(`${guestHostKeyPath}.pub`, 'utf8').trim(),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/autoinstall.test.ts`
Expected: PASS, 19 tests.

If the `sed`-in-`sh -c` late-command fails the "valid YAML" parse, the backslash escaping in the template literal is wrong — check that the emitted YAML line reads `- "sh -c 'sed -i \\'s/...'"` and simplify by moving that one command to a base64 write of a whole `/target/etc/default/grub` line if escaping proves fragile.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/harnessKeys.ts tests/guest/autoinstall.ts tests/unit/guest/autoinstall.test.ts
git commit -m "test: harness keypairs and the Ubuntu autoinstall seed generators"
```

---

## Task 7: The ISO cache and the golden-image stamp

**Files:**

- Create: `tests/guest/hyperv/isoCache.ts`
- Create: `tests/guest/hyperv/goldenStamp.ts`
- Test: `tests/unit/guest/isoCache.test.ts`, `tests/unit/guest/goldenStamp.test.ts`

**Interfaces:**

- Consumes: `isoUrl`, `sha256SumsUrl`, `isoPath`, `imageCacheDir` from `tests/guest/hyperv/imageCache`.
- Produces:
  ```typescript
  // tests/guest/hyperv/isoCache.ts
  export function parseSha256Sums(text: string, filename: string): string;
  export function ensureIso(): Promise<string>;

  // tests/guest/hyperv/goldenStamp.ts
  export const BUILD_ALGORITHM_VERSION: number;
  export interface GoldenStampInputs {
    userData: string;
    metaData: string;
    grubCfg: string;
    isoUrl: string;
    harnessPublicKey: string;
    guestHostPublicKey: string;
    buildAlgorithmVersion: number;
  }
  export function computeGoldenStamp(inputs: GoldenStampInputs): string;
  export function readGoldenStamp(): string | null;
  export function writeGoldenStamp(stamp: string): void;
  export function clearGoldenStamp(): void;
  ```

The stamp is the cache-validity mechanism, ported in spirit from `tests/guest/harness/build-image.sh:14-19,31,93-95`. An existence check alone cannot see that a cached image was built from different inputs; it silently reuses an image whose config no longer matches the tree, which surfaces as guests behaving like an older revision of the harness rather than as an obvious failure.

`buildAlgorithmVersion` is hand-bumped, and it is the part the other fields cannot cover: a change to the *pipeline* — a different partition layout, a different VM shape — moves nothing hashed from the seed files, so without it a stale image would be vouched for.

**No maximum image age.** The e2e test still runs `01-apt-packages.sh`'s real `apt upgrade -y`, so a stale golden image costs time, never correctness.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guest/isoCache.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseSha256Sums } from '../../guest/hyperv/isoCache';

// Exactly the format releases.ubuntu.com/26.04/SHA256SUMS uses: lowercase hex,
// two spaces, then '*' plus the filename.
const sums = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef *ubuntu-26.04-desktop-amd64.iso',
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100 *ubuntu-26.04-live-server-amd64.iso',
  '',
].join('\n');

describe('parseSha256Sums', () => {
  it('finds the digest for an exact filename', () => {
    expect(parseSha256Sums(sums, 'ubuntu-26.04-live-server-amd64.iso')).toBe(
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
    );
  });

  it('does not confuse one image for another', () => {
    expect(parseSha256Sums(sums, 'ubuntu-26.04-desktop-amd64.iso')).toBe(
      'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef',
    );
  });

  it('tolerates a plain space instead of the binary-mode asterisk', () => {
    expect(parseSha256Sums('abc123  some-file.iso\n', 'some-file.iso')).toBe('abc123');
  });

  it('throws naming the file when it is not listed, rather than returning undefined', () => {
    expect(() => parseSha256Sums(sums, 'ubuntu-27.04-live-server-amd64.iso')).toThrow(
      /ubuntu-27\.04-live-server-amd64\.iso/,
    );
  });

  it('does not match a filename that is only a suffix of a listed one', () => {
    expect(() => parseSha256Sums(sums, 'server-amd64.iso')).toThrow();
  });
});
```

Create `tests/unit/guest/goldenStamp.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeGoldenStamp, type GoldenStampInputs } from '../../guest/hyperv/goldenStamp';

const base: GoldenStampInputs = {
  userData: '#cloud-config\nautoinstall:\n  version: 1\n',
  metaData: 'instance-id: susentorno-test-golden\n',
  grubCfg: 'set timeout=1\n',
  isoUrl: 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso',
  harnessPublicKey: 'ssh-ed25519 AAAAHARNESS',
  guestHostPublicKey: 'ssh-ed25519 AAAAHOSTKEY',
  buildAlgorithmVersion: 1,
};

describe('computeGoldenStamp', () => {
  it('is a lowercase sha-256 hex digest', () => {
    expect(computeGoldenStamp(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for identical inputs', () => {
    expect(computeGoldenStamp(base)).toBe(computeGoldenStamp({ ...base }));
  });

  it('moves when EVERY input moves — including meta-data and the build version', () => {
    const stamp = computeGoldenStamp(base);
    const mutations: GoldenStampInputs[] = [
      { ...base, userData: base.userData + '# changed\n' },
      { ...base, metaData: base.metaData + '# changed\n' },
      { ...base, grubCfg: base.grubCfg + '# changed\n' },
      { ...base, isoUrl: base.isoUrl.replace('26.04', '26.10') },
      { ...base, harnessPublicKey: 'ssh-ed25519 AAAADIFFERENT' },
      { ...base, guestHostPublicKey: 'ssh-ed25519 AAAADIFFERENT' },
      { ...base, buildAlgorithmVersion: base.buildAlgorithmVersion + 1 },
    ];
    for (const mutated of mutations) {
      expect(computeGoldenStamp(mutated), JSON.stringify(mutated).slice(0, 80)).not.toBe(stamp);
    }
  });

  it('cannot be collided by shifting content across field boundaries', () => {
    // Without a separator between fields, 'ab' + 'c' and 'a' + 'bc' would hash
    // the same and two genuinely different configs would share a stamp.
    expect(
      computeGoldenStamp({ ...base, userData: 'ab', metaData: 'c' }),
    ).not.toBe(computeGoldenStamp({ ...base, userData: 'a', metaData: 'bc' }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/guest/isoCache.test.ts tests/unit/guest/goldenStamp.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write `tests/guest/hyperv/goldenStamp.ts`**

```typescript
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { goldenStampPath } from './imageCache';

/**
 * Hand-bumped when the BUILD PIPELINE changes rather than its inputs — a
 * different partition layout, a different build-VM shape, a different disk
 * size. Nothing else in the stamp would move for those, so without this a
 * genuinely stale image would be vouched for.
 */
export const BUILD_ALGORITHM_VERSION = 1;

export interface GoldenStampInputs {
  userData: string;
  metaData: string;
  grubCfg: string;
  isoUrl: string;
  harnessPublicKey: string;
  guestHostPublicKey: string;
  buildAlgorithmVersion: number;
}

/**
 * Everything baked into the image at build time, hashed together. Each field is
 * length-prefixed so content cannot shift across a field boundary and produce
 * the same digest for two genuinely different configurations.
 */
export function computeGoldenStamp(inputs: GoldenStampInputs): string {
  const hash = createHash('sha256');
  const fields = [
    inputs.userData,
    inputs.metaData,
    inputs.grubCfg,
    inputs.isoUrl,
    inputs.harnessPublicKey,
    inputs.guestHostPublicKey,
    String(inputs.buildAlgorithmVersion),
  ];
  for (const field of fields) {
    hash.update(`${Buffer.byteLength(field, 'utf8')}:`);
    hash.update(field, 'utf8');
  }
  return hash.digest('hex');
}

export function readGoldenStamp(): string | null {
  if (!existsSync(goldenStampPath)) return null;
  return readFileSync(goldenStampPath, 'utf8').trim();
}

/** Written only after a clean finish, so a half-built image can never be vouched for. */
export function writeGoldenStamp(stamp: string): void {
  writeFileSync(goldenStampPath, `${stamp}\n`);
}

/** Dropped before the build, so a build that dies part-way always retries next run. */
export function clearGoldenStamp(): void {
  rmSync(goldenStampPath, { force: true });
}
```

- [ ] **Step 4: Write `tests/guest/hyperv/isoCache.ts`**

```typescript
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename } from 'node:path';
import { imageCacheDir, isoPath, isoUrl, sha256SumsUrl } from './imageCache';

/**
 * SHA256SUMS lines are `<64 hex>  <mode><filename>`, where <mode> is '*' for
 * binary and ' ' for text. Anchored on the exact filename so 'server-amd64.iso'
 * cannot match 'ubuntu-26.04-live-server-amd64.iso'.
 */
export function parseSha256Sums(text: string, filename: string): string {
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]+)\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  throw new Error(`isoCache: ${sha256SumsUrl} does not list '${filename}'`);
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`isoCache: GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  const temp = `${destination}.partial`;
  rmSync(temp, { force: true });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
  renameSync(temp, destination);
}

/**
 * Returns the path to a verified ISO, downloading it if absent.
 *
 * The digest check is not ceremony: a truncated 2.7 GB download otherwise
 * surfaces as an inscrutable install hang twenty minutes later rather than as a
 * download error. A file that fails verification is deleted, so the next run
 * re-downloads rather than re-failing.
 *
 * The ISO is kept across sweeps: rebuilds happen exactly when someone is
 * iterating on the autoinstall config, which is the worst time to add a 2.7 GB
 * download to the loop.
 */
export async function ensureIso(): Promise<string> {
  mkdirSync(imageCacheDir, { recursive: true });
  const sumsResponse = await fetch(sha256SumsUrl);
  if (!sumsResponse.ok) {
    throw new Error(`isoCache: GET ${sha256SumsUrl} failed with ${sumsResponse.status}`);
  }
  const expected = parseSha256Sums(await sumsResponse.text(), basename(isoPath));

  if (existsSync(isoPath) && (await sha256File(isoPath)) === expected) return isoPath;

  if (existsSync(isoPath)) {
    console.log(`guest: cached ISO does not match ${sha256SumsUrl} — re-downloading`);
    rmSync(isoPath, { force: true });
  }
  console.log(`guest: downloading ${isoUrl} (2.7 GB, first run only)...`);
  await download(isoUrl, isoPath);

  const actual = await sha256File(isoPath);
  if (actual !== expected) {
    rmSync(isoPath, { force: true });
    throw new Error(
      `isoCache: ${isoUrl} downloaded with digest ${actual}, expected ${expected} per ` +
        `${sha256SumsUrl}. The partial file was deleted; re-run to retry.`,
    );
  }
  return isoPath;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/guest/isoCache.test.ts tests/unit/guest/goldenStamp.test.ts`
Expected: PASS, 9 tests.

If `parseSha256Sums` fails against the real file, use the exact line format recorded in Task 4 Step 1 rather than the assumed one.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/hyperv/isoCache.ts tests/guest/hyperv/goldenStamp.ts tests/unit/guest/isoCache.test.ts tests/unit/guest/goldenStamp.test.ts
git commit -m "test: verified ISO cache and golden-image staleness stamp"
```

---

## Task 8: VM PowerShell builders and the serial-console reader

**Files:**

- Create: `tests/guest/hyperv/vm.ts`
- Create: `tests/guest/hyperv/serialLog.ts`
- Test: `tests/unit/guest/vm.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell` from `src/guestSetup/quoteForPowerShell`.
- Produces:
  ```typescript
  // tests/guest/hyperv/vm.ts
  export const SECURE_BOOT_UEFI_CA_TEMPLATE = 'MicrosoftUEFICertificateAuthority';
  export interface NewVmOptions { memoryStartupBytes: number; switchName: string }
  export function buildNewVmCommand(name: string, opts: NewVmOptions): string;
  export function buildAddVmHardDiskCommand(name: string, vhdPath: string): string;
  export function buildSetVmProcessorCommand(name: string, count: number): string;
  export function buildSetVmDynamicMemoryCommand(name: string, minBytes: number, maxBytes: number): string;
  export function buildDisableSecureBootCommand(name: string): string;
  export function buildEnableSecureBootCommand(name: string): string;
  export function buildSetFirstBootDeviceCommand(name: string, vhdPath: string): string;
  export function buildSetVmComPortCommand(name: string, pipeName: string): string;
  export function buildRemoveVmCommand(name: string): string;
  export function buildGetVmNamesCommand(pattern: string): string;
  export function parseVmNames(stdout: string): string[];
  export function buildTurnOffVmCommand(name: string): string;

  // tests/guest/hyperv/serialLog.ts
  export interface SerialLogHandle { stop(): Promise<void> }
  export function startSerialLog(pipeName: string, filePath: string): SerialLogHandle;
  ```

`vm.ts` is a third module beyond the spec's §4 list, for the same reason `imageCache.ts` is: both `goldenImage.ts` (Task 9, the build VM) and `testGuest.ts` (Task 10, the three per-test guests) need the identical `New-VM`/`Set-VMFirmware`/`Set-VMComPort` vocabulary, and putting it in either one would make the other import it for an unrelated reason.

`Stop-VM`/`Start-VM` for the *normal* lifecycle are **not** redefined here — `src/guestSetup/hyperVOperations.ts` already exports `buildStartVmCommand` and `buildStopVmCommand`, and `buildGetVmCommand`/`parseGetVmResult` in `src/guestSetup/hyperVQueries.ts` already do state polling. Only the force-kill variant (`-TurnOff`, which a graceful stop is not) and the sweep query are new.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/vm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SECURE_BOOT_UEFI_CA_TEMPLATE,
  buildNewVmCommand,
  buildAddVmHardDiskCommand,
  buildSetVmProcessorCommand,
  buildSetVmDynamicMemoryCommand,
  buildDisableSecureBootCommand,
  buildEnableSecureBootCommand,
  buildSetFirstBootDeviceCommand,
  buildSetVmComPortCommand,
  buildRemoveVmCommand,
  buildGetVmNamesCommand,
  parseVmNames,
  buildTurnOffVmCommand,
} from '../../guest/hyperv/vm';

describe('buildNewVmCommand', () => {
  const command = buildNewVmCommand('susentorno-test-e2e', {
    memoryStartupBytes: 2048 * 1024 ** 2,
    switchName: 'Default Switch',
  });

  it('creates a Generation 2 VM on the named switch', () => {
    expect(command).toContain("New-VM -Name 'susentorno-test-e2e'");
    expect(command).toContain('-Generation 2');
    expect(command).toContain("-SwitchName 'Default Switch'");
    expect(command).toContain('-MemoryStartupBytes 2147483648');
  });

  it('creates no disk of its own — the differencing VHDX is attached separately', () => {
    expect(command).toContain('-NoVHD');
  });
});

describe('disk attachment and boot order', () => {
  it('attaches a VHDX by path', () => {
    expect(buildAddVmHardDiskCommand('vm', 'C:\\x\\a.vhdx')).toBe(
      "Add-VMHardDiskDrive -VMName 'vm' -Path 'C:\\x\\a.vhdx' | Out-Null",
    );
  });

  it('sets the first boot device to the drive holding a specific VHDX', () => {
    // The build VM has three disks; booting the wrong one wastes twenty minutes
    // before failing, so the boot device is selected by path, not by ordinal.
    const command = buildSetFirstBootDeviceCommand('vm', 'C:\\x\\installer.vhdx');
    expect(command).toContain("Get-VMHardDiskDrive -VMName 'vm'");
    expect(command).toContain("'C:\\x\\installer.vhdx'");
    expect(command).toContain('-FirstBootDevice');
  });
});

describe('sizing', () => {
  it('sets the processor count', () => {
    expect(buildSetVmProcessorCommand('vm', 2)).toBe("Set-VMProcessor -VMName 'vm' -Count 2");
  });

  it('enables dynamic memory between a floor and a ceiling', () => {
    const command = buildSetVmDynamicMemoryCommand('vm', 2048 * 1024 ** 2, 4096 * 1024 ** 2);
    expect(command).toContain('-DynamicMemoryEnabled $true');
    expect(command).toContain('-MinimumBytes 2147483648');
    expect(command).toContain('-MaximumBytes 4294967296');
  });
});

describe('secure boot', () => {
  it('turns Secure Boot OFF for the build VM, which boots a hand-assembled disk', () => {
    expect(buildDisableSecureBootCommand('vm')).toBe(
      "Set-VMFirmware -VMName 'vm' -EnableSecureBoot Off",
    );
  });

  it('turns Secure Boot ON with the UEFI CA template for per-test guests, matching setup-guest.md', () => {
    expect(buildEnableSecureBootCommand('vm')).toBe(
      "Set-VMFirmware -VMName 'vm' -EnableSecureBoot On " +
        "-SecureBootTemplate 'MicrosoftUEFICertificateAuthority'",
    );
    expect(SECURE_BOOT_UEFI_CA_TEMPLATE).toBe('MicrosoftUEFICertificateAuthority');
  });
});

describe('serial console', () => {
  it('points COM1 at a named pipe', () => {
    expect(buildSetVmComPortCommand('vm', 'susentorno-test-e2e')).toBe(
      "Set-VMComPort -VMName 'vm' -Number 1 -Path '\\\\.\\pipe\\susentorno-test-e2e'",
    );
  });
});

describe('teardown and discovery', () => {
  it('turns a VM off hard, which a graceful Stop-VM is not', () => {
    expect(buildTurnOffVmCommand('vm')).toContain('-TurnOff');
    expect(buildTurnOffVmCommand('vm')).toContain('-Force');
    // A guest wedged mid-boot never honours a graceful shutdown, and the sweep
    // must not hang on one.
    expect(buildTurnOffVmCommand('vm')).toContain('-ErrorAction SilentlyContinue');
  });

  it('removes a VM without prompting', () => {
    expect(buildRemoveVmCommand('vm')).toContain('Remove-VM');
    expect(buildRemoveVmCommand('vm')).toContain('-Force');
  });

  it('lists VM names matching a wildcard pattern as JSON', () => {
    const command = buildGetVmNamesCommand('susentorno-test-*');
    expect(command).toContain("Get-VM -Name 'susentorno-test-*'");
    expect(command).toContain('-ErrorAction SilentlyContinue');
    expect(command).toContain('ConvertTo-Json -Compress');
  });
});

describe('parseVmNames', () => {
  it('parses a list', () => {
    expect(parseVmNames('[{"Name":"susentorno-test-e2e"},{"Name":"susentorno-test-fresh"}]')).toEqual(
      ['susentorno-test-e2e', 'susentorno-test-fresh'],
    );
  });

  it('parses a single object, which is what ConvertTo-Json emits for one match', () => {
    expect(parseVmNames('{"Name":"susentorno-test-e2e"}')).toEqual(['susentorno-test-e2e']);
  });

  it('returns an empty array for no output', () => {
    expect(parseVmNames('')).toEqual([]);
    expect(parseVmNames('   \n')).toEqual([]);
  });

  it('drops entries with no usable name rather than emitting undefined', () => {
    expect(parseVmNames('[{"Name":"a"},{"Name":null},{}]')).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/vm.test.ts`
Expected: FAIL — `Cannot find module '../../guest/hyperv/vm'`.

- [ ] **Step 3: Write `tests/guest/hyperv/vm.ts`**

```typescript
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/** Matches setup-guest.md:39's documented Ubuntu guest setting. */
export const SECURE_BOOT_UEFI_CA_TEMPLATE = 'MicrosoftUEFICertificateAuthority';

export interface NewVmOptions {
  memoryStartupBytes: number;
  switchName: string;
}

/**
 * -NoVHD on purpose: every VM in this tier attaches disks that already exist —
 * the build VM's three, or a per-test guest's single differencing overlay — so
 * letting New-VM create one would leave an unused, unwanted disk behind.
 */
export function buildNewVmCommand(name: string, opts: NewVmOptions): string {
  return (
    `New-VM -Name ${quoteForPowerShell(name)} -Generation 2 ` +
    `-MemoryStartupBytes ${opts.memoryStartupBytes} ` +
    `-SwitchName ${quoteForPowerShell(opts.switchName)} -NoVHD | Out-Null`
  );
}

export function buildAddVmHardDiskCommand(name: string, vhdPath: string): string {
  return (
    `Add-VMHardDiskDrive -VMName ${quoteForPowerShell(name)} ` +
    `-Path ${quoteForPowerShell(vhdPath)} | Out-Null`
  );
}

export function buildSetVmProcessorCommand(name: string, count: number): string {
  return `Set-VMProcessor -VMName ${quoteForPowerShell(name)} -Count ${count}`;
}

export function buildSetVmDynamicMemoryCommand(
  name: string,
  minBytes: number,
  maxBytes: number,
): string {
  return (
    `Set-VMMemory -VMName ${quoteForPowerShell(name)} -DynamicMemoryEnabled $true ` +
    `-MinimumBytes ${minBytes} -MaximumBytes ${maxBytes}`
  );
}

/**
 * The build VM only. It boots a hand-assembled disk — the one place a signature
 * policy could bite — during the step we can least observe, and what the
 * installer WRITES (signed shim, GRUB, signed kernel) is identical either way.
 */
export function buildDisableSecureBootCommand(name: string): string {
  return `Set-VMFirmware -VMName ${quoteForPowerShell(name)} -EnableSecureBoot Off`;
}

/** Per-test guests, matching what a real user configures by hand. */
export function buildEnableSecureBootCommand(name: string): string {
  return (
    `Set-VMFirmware -VMName ${quoteForPowerShell(name)} -EnableSecureBoot On ` +
    `-SecureBootTemplate ${quoteForPowerShell(SECURE_BOOT_UEFI_CA_TEMPLATE)}`
  );
}

/** Selected by VHDX path, never by ordinal: the build VM has three disks. */
export function buildSetFirstBootDeviceCommand(name: string, vhdPath: string): string {
  const quotedName = quoteForPowerShell(name);
  return (
    `$drive = Get-VMHardDiskDrive -VMName ${quotedName} | ` +
    `Where-Object { $_.Path -eq ${quoteForPowerShell(vhdPath)} }; ` +
    `Set-VMFirmware -VMName ${quotedName} -FirstBootDevice $drive`
  );
}

export function buildSetVmComPortCommand(name: string, pipeName: string): string {
  return (
    `Set-VMComPort -VMName ${quoteForPowerShell(name)} -Number 1 ` +
    `-Path ${quoteForPowerShell(`\\\\.\\pipe\\${pipeName}`)}`
  );
}

/**
 * -TurnOff, not a graceful Stop-VM: this is teardown and sweep, where a guest
 * wedged mid-boot would never honour a shutdown request and must not be allowed
 * to hang the run. SilentlyContinue because "already off" is a success here.
 */
export function buildTurnOffVmCommand(name: string): string {
  return `Stop-VM -Name ${quoteForPowerShell(name)} -TurnOff -Force -ErrorAction SilentlyContinue`;
}

export function buildRemoveVmCommand(name: string): string {
  return `Remove-VM -Name ${quoteForPowerShell(name)} -Force -ErrorAction SilentlyContinue`;
}

export function buildGetVmNamesCommand(pattern: string): string {
  return (
    `Get-VM -Name ${quoteForPowerShell(pattern)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ Name = $_.Name } } | ConvertTo-Json -Compress`
  );
}

export function parseVmNames(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as { Name?: unknown }[];
  return list.map((v) => v?.Name).filter((n): n is string => typeof n === 'string' && n !== '');
}
```

- [ ] **Step 4: Write `tests/guest/hyperv/serialLog.ts`**

```typescript
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import net from 'node:net';

export interface SerialLogHandle {
  stop(): Promise<void>;
}

/**
 * Streams a VM's COM1 named pipe to a file.
 *
 * Hyper-V creates the pipe only while the VM is running, and destroys it when
 * the VM stops — so this retry-connects rather than failing on the first
 * ECONNREFUSED/ENOENT, and reconnects if the pipe drops mid-run (which happens
 * on the guest reboot every isolation performs). The earliest bytes can be lost
 * in the gap between Start-VM and the first successful connect; that is
 * accepted, since firmware output before GRUB is not what anyone reads this log
 * for.
 *
 * Never awaited by a caller: this is a diagnostic side channel, and a failure
 * to attach must not fail a test that would otherwise pass. `stop()` is the
 * only synchronisation point, called from afterAll.
 */
export function startSerialLog(pipeName: string, filePath: string): SerialLogHandle {
  mkdirSync(dirname(filePath), { recursive: true });
  const out: WriteStream = createWriteStream(filePath, { flags: 'a' });
  let socket: net.Socket | null = null;
  let stopped = false;

  const attach = () => {
    if (stopped) return;
    socket = net.connect({ path: `\\\\.\\pipe\\${pipeName}` });
    socket.on('data', (chunk) => out.write(chunk));
    socket.on('error', () => {
      socket?.destroy();
      socket = null;
      if (!stopped) setTimeout(attach, 500);
    });
    socket.on('close', () => {
      socket = null;
      if (!stopped) setTimeout(attach, 500);
    });
  };
  attach();

  return {
    stop(): Promise<void> {
      stopped = true;
      socket?.destroy();
      socket = null;
      return new Promise((resolve) => out.end(resolve));
    },
  };
}
```

No unit test: it is a thin `net`/`fs` wrapper with no branching logic worth asserting, the same treatment `createRealPowerShellExec` and `createSshRemoteExec` already get (`src/guestSetup/powerShellExec.ts:22-27`). It is exercised — and its output read — by every guest boot in Tasks 9, 13, 14, and 15.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/vm.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/hyperv/vm.ts tests/guest/hyperv/serialLog.ts tests/unit/guest/vm.test.ts
git commit -m "test: Hyper-V VM command builders and a COM-port serial log reader"
```

---

## Task 9: `ensureGoldenImage` and the first real build

**Files:**

- Create: `tests/guest/hyperv/goldenImage.ts`
- Test: verified by an actual cold build (Step 5), not by a unit test — the pure halves are already covered by Tasks 5–8.

**Interfaces:**

- Consumes: `PowerShellExec` from `src/guestSetup/powerShellExec`; `buildGetVmCommand`/`parseGetVmResult` from `src/guestSetup/hyperVQueries`; `buildStartVmCommand` from `src/guestSetup/hyperVOperations`; everything Tasks 5–8 produced; `HarnessKeys` from `tests/guest/harnessKeys`.
- Produces:
  ```typescript
  export function ensureGoldenImage(
    exec: PowerShellExec,
    keys: HarnessKeys,
    opts?: { force?: boolean },
  ): Promise<string>;
  ```
  Resolves to `goldenVhdPath`. Every other part of the tier treats it as a cached fact.

The three disk sizes are design constraints, not arbitrary numbers: `storage.layout.match.size: largest` is what stops autoinstall installing onto the installer disk, so 40 GB target / 4 GB installer / 64 MB seed must stay ordered that way.

- [ ] **Step 1: Write `tests/guest/hyperv/goldenImage.ts`**

```typescript
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { buildGetVmCommand, parseGetVmResult } from '../../../src/guestSetup/hyperVQueries';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';
import type { HarnessKeys } from '../harnessKeys';
import { buildGrubCfg, buildMetaData, buildUserData } from '../autoinstall';
import {
  BUILD_ALGORITHM_VERSION,
  clearGoldenStamp,
  computeGoldenStamp,
  readGoldenStamp,
  writeGoldenStamp,
} from './goldenStamp';
import { ensureIso } from './isoCache';
import {
  goldenBuildSerialLogPath,
  goldenVhdPath,
  imageCacheDir,
  isoPath,
  isoUrl,
  NAME_PREFIX,
} from './imageCache';
import { startSerialLog } from './serialLog';
import {
  buildCopyTreeCommand,
  buildCreateFat32VolumeCommand,
  buildDismountIsoCommand,
  buildDismountVhdCommand,
  buildMountIsoCommand,
  buildNewVhdCommand,
  buildSetEspTypeCommand,
  parseIsoDriveLetter,
  parsePartitionHandle,
} from './vhd';
import {
  buildAddVmHardDiskCommand,
  buildDisableSecureBootCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetFirstBootDeviceCommand,
  buildSetVmComPortCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

const BUILD_VM_NAME = `${NAME_PREFIX}-golden-build`;
const BUILD_PIPE_NAME = `${NAME_PREFIX}-golden-build`;
const installerVhdPath = join(imageCacheDir, `${NAME_PREFIX}-golden-installer.vhdx`);
const seedVhdPath = join(imageCacheDir, `${NAME_PREFIX}-golden-seed.vhdx`);

/**
 * Sizes are load-bearing: autoinstall disambiguates the three disks with
 * `storage.layout.match.size: largest`, so the target must be the biggest and
 * the seed the smallest, by a margin no future edit can erode.
 */
const TARGET_SIZE_BYTES = 40 * 1024 ** 3;
const INSTALLER_SIZE_BYTES = 4 * 1024 ** 3;
const SEED_SIZE_BYTES = 64 * 1024 ** 2;
const BUILD_TIMEOUT_MS = 45 * 60_000;

async function run(exec: PowerShellExec, command: string, what: string): Promise<string> {
  const { exitCode, stdout } = await exec.run(command);
  if (exitCode !== 0) {
    throw new Error(`goldenImage: ${what} failed (exit ${exitCode}): ${stdout || command}`);
  }
  return stdout;
}

/** Writes `contents` to `<drive>:\<relativePath>`, creating parent directories. */
function buildWriteFileCommand(drive: string, relativePath: string, contents: string): string {
  const target = `${drive}:\\${relativePath.replace(/\//g, '\\')}`;
  const b64 = Buffer.from(contents, 'utf8').toString('base64');
  return (
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${quoteForPowerShell(target)}) | Out-Null; ` +
    `[System.IO.File]::WriteAllBytes(${quoteForPowerShell(target)}, ` +
    `[System.Convert]::FromBase64String(${quoteForPowerShell(b64)}))`
  );
}

async function buildInstallerDisk(exec: PowerShellExec, grubCfg: string): Promise<void> {
  rmSync(installerVhdPath, { force: true });
  await run(exec, buildNewVhdCommand(installerVhdPath, INSTALLER_SIZE_BYTES), 'create installer VHDX');
  const handle = parsePartitionHandle(
    await run(exec, buildCreateFat32VolumeCommand(installerVhdPath, 'INSTALLER'), 'format installer VHDX'),
  );
  const isoDrive = parseIsoDriveLetter(await run(exec, buildMountIsoCommand(isoPath), 'mount ISO'));
  try {
    await run(exec, buildCopyTreeCommand(isoDrive, handle.driveLetter), 'copy the ISO tree');
  } finally {
    await exec.run(buildDismountIsoCommand(isoPath));
  }
  // The overwrite is the whole mechanism: it is what puts `autoinstall` on the
  // kernel command line, which is the consent subiquity requires before it will
  // destructively modify disks. A seed disk supplies the config, not the consent.
  await run(
    exec,
    buildWriteFileCommand(handle.driveLetter, 'boot/grub/grub.cfg', grubCfg),
    'write grub.cfg',
  );
  await run(exec, buildSetEspTypeCommand(handle.diskNumber, handle.partitionNumber), 'set ESP type');
  await run(exec, buildDismountVhdCommand(installerVhdPath), 'dismount installer VHDX');
}

async function buildSeedDisk(
  exec: PowerShellExec,
  userData: string,
  metaData: string,
): Promise<void> {
  rmSync(seedVhdPath, { force: true });
  await run(exec, buildNewVhdCommand(seedVhdPath, SEED_SIZE_BYTES), 'create seed VHDX');
  // Volume label CIDATA is what cloud-init's NoCloud datasource looks for.
  const handle = parsePartitionHandle(
    await run(exec, buildCreateFat32VolumeCommand(seedVhdPath, 'CIDATA'), 'format seed VHDX'),
  );
  await run(exec, buildWriteFileCommand(handle.driveLetter, 'user-data', userData), 'write user-data');
  await run(exec, buildWriteFileCommand(handle.driveLetter, 'meta-data', metaData), 'write meta-data');
  await run(exec, buildDismountVhdCommand(seedVhdPath), 'dismount seed VHDX');
}

async function waitForVmOff(exec: PowerShellExec, name: string): Promise<void> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  for (;;) {
    const { stdout } = await exec.run(buildGetVmCommand(name));
    const vm = parseGetVmResult(stdout, name);
    // autoinstall ends with `shutdown: poweroff`, so Off IS the success signal.
    if (vm?.state === 'Off') return;
    if (Date.now() >= deadline) {
      throw new Error(
        `goldenImage: the build VM did not power off within ${BUILD_TIMEOUT_MS / 60_000} minutes ` +
          `(state '${vm?.state ?? 'unknown'}'). The autoinstall output is at ${goldenBuildSerialLogPath}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

async function removeBuildVm(exec: PowerShellExec): Promise<void> {
  await exec.run(buildTurnOffVmCommand(BUILD_VM_NAME));
  await exec.run(buildRemoveVmCommand(BUILD_VM_NAME));
}

/**
 * Returns the path to a golden VHDX matching the current inputs, building it if
 * it does not exist or is stale.
 *
 * The stamp is dropped before the build and written only after a clean finish,
 * so a half-built image can never be vouched for — a failed build always retries
 * next run rather than half-vouching. There is deliberately no maximum image
 * age: the e2e test still runs a real `apt upgrade`, so a stale image costs
 * time, never correctness.
 */
export async function ensureGoldenImage(
  exec: PowerShellExec,
  keys: HarnessKeys,
  opts: { force?: boolean } = {},
): Promise<string> {
  const grubCfg = buildGrubCfg();
  const metaData = buildMetaData();
  const userData = buildUserData({
    harnessPublicKey: keys.harnessPublicKey,
    guestHostPrivateKey: keys.guestHostPrivateKey,
    guestHostPublicKey: keys.guestHostPublicKey,
  });
  const stamp = computeGoldenStamp({
    userData,
    metaData,
    grubCfg,
    isoUrl,
    harnessPublicKey: keys.harnessPublicKey,
    guestHostPublicKey: keys.guestHostPublicKey,
    buildAlgorithmVersion: BUILD_ALGORITHM_VERSION,
  });

  if (!opts.force && existsSync(goldenVhdPath) && readGoldenStamp() === stamp) {
    console.log(`guest: golden image is up to date at ${goldenVhdPath}`);
    return goldenVhdPath;
  }
  if (existsSync(goldenVhdPath)) {
    console.log('guest: golden-image inputs changed since it was built — rebuilding');
  }

  clearGoldenStamp();
  await ensureIso();
  // A leftover build VM from a killed run would hold the disks open.
  await removeBuildVm(exec);
  rmSync(goldenVhdPath, { force: true });
  rmSync(goldenBuildSerialLogPath, { force: true });

  await buildInstallerDisk(exec, grubCfg);
  await buildSeedDisk(exec, userData, metaData);
  await run(exec, buildNewVhdCommand(goldenVhdPath, TARGET_SIZE_BYTES), 'create the golden VHDX');

  console.log('guest: building the golden image (20-30 minutes on a cold cache)...');
  // Default Switch, not the Internal one: autoinstall needs real internet
  // through ICS. This is also why globalSetup can create the host network AFTER
  // this step — the build never touches it.
  await run(
    exec,
    buildNewVmCommand(BUILD_VM_NAME, {
      memoryStartupBytes: 4096 * 1024 ** 2,
      switchName: 'Default Switch',
    }),
    'create the build VM',
  );
  const serial = startSerialLog(BUILD_PIPE_NAME, goldenBuildSerialLogPath);
  try {
    await run(exec, buildAddVmHardDiskCommand(BUILD_VM_NAME, goldenVhdPath), 'attach the target disk');
    await run(exec, buildAddVmHardDiskCommand(BUILD_VM_NAME, installerVhdPath), 'attach the installer disk');
    await run(exec, buildAddVmHardDiskCommand(BUILD_VM_NAME, seedVhdPath), 'attach the seed disk');
    await run(exec, buildSetVmProcessorCommand(BUILD_VM_NAME, 2), 'set the build VM processor count');
    await run(exec, buildDisableSecureBootCommand(BUILD_VM_NAME), 'disable Secure Boot');
    await run(
      exec,
      buildSetFirstBootDeviceCommand(BUILD_VM_NAME, installerVhdPath),
      'set the boot device to the installer disk',
    );
    await run(exec, buildSetVmComPortCommand(BUILD_VM_NAME, BUILD_PIPE_NAME), 'attach COM1');
    await run(exec, buildStartVmCommand(BUILD_VM_NAME), 'start the build VM');
    await waitForVmOff(exec, BUILD_VM_NAME);
  } finally {
    await serial.stop();
    await removeBuildVm(exec);
  }

  // Pure derivations, seconds to regenerate — deleted as soon as the build
  // succeeds. The ISO is kept: re-acquiring it is a 2.7 GB download, and
  // rebuilds happen exactly when someone is iterating on the autoinstall
  // config, which is the worst time to add a download to the loop.
  rmSync(installerVhdPath, { force: true });
  rmSync(seedVhdPath, { force: true });

  writeGoldenStamp(stamp);
  console.log(`guest: golden image ready at ${goldenVhdPath}`);
  return goldenVhdPath;
}
```

- [ ] **Step 2: Write a temporary driver so the build can be run on demand**

The `guest` tier's `globalSetup` does not exist yet (Task 13), so drive the build from the `host-network` tier, whose only prerequisite is exactly what this needs: an elevated shell and real Hyper-V. Create `tests/host-network/goldenImageBuild.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { ensureHarnessKeys } from '../guest/harnessKeys';
import { ensureGoldenImage } from '../guest/hyperv/goldenImage';
import { goldenVhdPath } from '../guest/hyperv/imageCache';

describe('golden image build', () => {
  it('builds an Ubuntu 26.04 golden VHDX from the live-server ISO', async () => {
    const keys = await ensureHarnessKeys();
    const path = await ensureGoldenImage(createRealPowerShellExec(), keys);
    expect(path).toBe(goldenVhdPath);
    expect(existsSync(goldenVhdPath)).toBe(true);
  }, 3_600_000);

  it('is a cached fact on the second call — no rebuild', async () => {
    const keys = await ensureHarnessKeys();
    const started = Date.now();
    await ensureGoldenImage(createRealPowerShellExec(), keys);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
```

This file is **deleted in Task 13**, once `tests/guest/globalSetup.ts` calls `ensureGoldenImage` for real. It is scaffolding for this task's verification, and the plan says so up front rather than leaving it to be discovered later.

- [ ] **Step 3: Run the cold build**

Run (elevated, ~30 minutes): `pnpm vitest run --config vitest.host-network.config.ts tests/host-network/goldenImageBuild.test.ts`

Watch `.image-cache/golden-build-serial.log` from a second terminal while it runs:

```powershell
Get-Content .image-cache\golden-build-serial.log -Wait -Tail 40
```

Expected: GRUB's `autoinstall` entry, subiquity's progress output, the `late-commands` running, then a clean poweroff. Then PASS, 2 tests.

- [ ] **Step 4: Read the diagnosis table if it fails**

| Symptom in `golden-build-serial.log` | Cause | Fix |
| --- | --- | --- |
| Nothing at all, VM never powers off | The installer disk did not boot | Task 4's contingencies — this is risk 1 resurfacing |
| Subiquity stops asking to confirm the destructive install | `autoinstall` is not on the kernel command line | `grub.cfg` was written to the wrong path or the wrong disk; check the `buildWriteFileCommand` target |
| "no autoinstall config found" | The seed volume label is not `CIDATA`, or `user-data`/`meta-data` are not at the volume root | Check `buildSeedDisk`'s `buildWriteFileCommand` relative paths — they must be bare filenames |
| The install lands on the wrong disk / "no candidate devices" | `size: largest` did not disambiguate | Confirm the three sizes are 40 GB / 4 GB / 64 MB and that all three attached |
| Installs cleanly, but a later task finds `systemd-networkd` running or no serial console | A `late-command` ran in the installer, not in-target | Re-check that entry against Task 6's "every persistent change is in-target" test |
| Schema validation error naming `identity`, `storage`, or a `late-commands` entry | Risk 3: 26.04's autoinstall schema differs from what this plan assumed | Correct `buildUserData` and its unit test together; for `identity.password`, generate a real hash with `ssh vmtest@… 'openssl passwd -6'` on any Linux box, or `docker run --rm alpine sh -c "openssl passwd -6 $(openssl rand -hex 16)"`, and inline the result |

- [ ] **Step 5: Verify the image is what it claims to be**

The build is only half-verified by finishing. Boot it once by hand and check the five things the autoinstall was supposed to bake in:

```powershell
New-VHD -Path .\.image-cache\verify.vhdx -ParentPath .\.image-cache\susentorno-test-golden.vhdx -Differencing | Out-Null
New-VM -Name 'golden-verify' -Generation 2 -MemoryStartupBytes 2GB -SwitchName 'Default Switch' -NoVHD | Out-Null
Add-VMHardDiskDrive -VMName 'golden-verify' -Path (Resolve-Path .\.image-cache\verify.vhdx)
Set-VMFirmware -VMName 'golden-verify' -EnableSecureBoot On -SecureBootTemplate 'MicrosoftUEFICertificateAuthority'
Start-VM -Name 'golden-verify'
Start-Sleep -Seconds 90
(Get-VMNetworkAdapter -VMName 'golden-verify').IPAddresses
```

Then, against the address it reports:

```powershell
ssh -i .\.image-cache\harness_ed25519 -o StrictHostKeyChecking=no vmtest@<ip> "systemctl is-enabled systemd-networkd; systemctl is-enabled apt-daily.timer; sudo -n true && echo nopasswd-ok; which jq; dpkg -s linux-cloud-tools-virtual | head -1; dpkg -s cifs-utils 2>&1 | head -1; ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
```

Expected: `masked`, `masked`, `nopasswd-ok`, `/usr/bin/jq`, `Package: linux-cloud-tools-virtual`, a *not-installed* line for `cifs-utils`, and a host-key fingerprint matching `ssh-keygen -lf .image-cache\guest_host_ed25519.pub`. That last one is the load-bearing check — Task 11's `known_hosts` handling is built on the harness knowing this key.

Tear down:

```powershell
Stop-VM -Name 'golden-verify' -TurnOff -Force; Remove-VM -Name 'golden-verify' -Force
Remove-Item .\.image-cache\verify.vhdx
```

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/guest/hyperv/goldenImage.ts tests/host-network/goldenImageBuild.test.ts
git commit -m "test: build the guest tier's Ubuntu golden image from an unattended autoinstall"
```

---

## Task 10: The Windows local account, the SMB share, and its NTFS ACE

**Files:**

- Create: `tests/guest/testShare.ts`
- Test: `tests/unit/guest/testShare.test.ts`

**Interfaces:**

- Consumes: `quoteForPowerShell`, `PowerShellExec`.
- Produces:
  ```typescript
  export const SHARE_ACCOUNT = 'susentorno-test';
  export const SHARE_NAME = 'susentorno-test-vm-shared-linux';
  export function generateSharePassword(): string;
  export function buildRemoveLocalUserCommand(name: string): string;
  export function buildNewLocalUserCommand(name: string, password: string): string;
  export function buildRemoveSmbShareCommand(name: string): string;
  export function buildNewSmbShareCommand(name: string, path: string, account: string): string;
  export function buildGrantNtfsReadExecuteCommand(path: string, account: string): string;
  export function buildRevokeNtfsAceCommand(path: string, account: string): string;
  export interface TestShare { account: string; shareName: string; password: string }
  export function createTestShare(exec: PowerShellExec, sharePath: string): Promise<TestShare>;
  export function removeTestShare(exec: PowerShellExec, sharePath: string): Promise<void>;
  ```

Three things about these names are forced rather than chosen:

- **`susentorno-test`, not `susentorno-test-share`.** `New-LocalUser -Name` caps at 20 characters and `susentorno-test-share` is 21. That cap is what drives the whole naming scheme: `susentorno-<isolation>` leaves comfortable headroom while `susentorno-<isolation>-share` does not.
- **`susentorno-test-vm-shared-linux`, not `vm-shared-linux`.** An SMB share name is machine-global and would otherwise collide with a developer's real one. The guest therefore mounts `/mnt/susentorno-test-vm-shared-linux`; every guest script resolves its own directory relatively (`script_dir`/`dirname`), so nothing breaks.
- **An explicit NTFS ACE is required, not optional.** `New-SmbShare -ReadAccess` sets *share* permissions, and effective access is the intersection of share and NTFS permissions. The share path is inside the repository checkout, whose inherited ACLs the suite does not control and which grant this account nothing. Without the ACE the guest authenticates successfully and *then* gets access denied — a failure that presents as a credential problem and is not one.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/testShare.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SHARE_ACCOUNT,
  SHARE_NAME,
  generateSharePassword,
  buildRemoveLocalUserCommand,
  buildNewLocalUserCommand,
  buildRemoveSmbShareCommand,
  buildNewSmbShareCommand,
  buildGrantNtfsReadExecuteCommand,
  buildRevokeNtfsAceCommand,
} from '../../guest/testShare';

describe('names', () => {
  it('keeps the account inside New-LocalUser -Name s 20-character cap', () => {
    // 'susentorno-test-share' would be 21 — this cap is what drives the whole
    // susentorno-<isolation> scheme rather than susentorno-<isolation>-share.
    expect(SHARE_ACCOUNT).toBe('susentorno-test');
    expect(SHARE_ACCOUNT.length).toBeLessThanOrEqual(20);
  });

  it('prefixes the share name, because an SMB share name is machine-global', () => {
    expect(SHARE_NAME).toBe('susentorno-test-vm-shared-linux');
  });
});

describe('generateSharePassword', () => {
  it('is long and mixes character classes, so it satisfies any local password policy', () => {
    const password = generateSharePassword();
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  it('is different every call', () => {
    expect(generateSharePassword()).not.toBe(generateSharePassword());
  });
});

describe('local account commands', () => {
  it('removes without failing when the account is absent', () => {
    expect(buildRemoveLocalUserCommand('susentorno-test')).toBe(
      "Remove-LocalUser -Name 'susentorno-test' -ErrorAction SilentlyContinue",
    );
  });

  it('creates the account with a secure string, never a plaintext -Password', () => {
    const command = buildNewLocalUserCommand('susentorno-test', "pa'ss1!");
    expect(command).toContain('ConvertTo-SecureString');
    expect(command).toContain('-AsPlainText -Force');
    // The password still has to reach PowerShell, but it must be quoted, not
    // splatted — a stray quote would otherwise end the string and inject.
    expect(command).toContain("'pa''ss1!'");
    expect(command).toContain('-PasswordNeverExpires');
    expect(command).toContain('-UserMayNotChangePassword');
  });
});

describe('share commands', () => {
  it('removes without prompting and without failing when the share is absent', () => {
    const command = buildRemoveSmbShareCommand('susentorno-test-vm-shared-linux');
    expect(command).toContain("Remove-SmbShare -Name 'susentorno-test-vm-shared-linux'");
    expect(command).toContain('-Force');
    expect(command).toContain('-ErrorAction SilentlyContinue');
  });

  it('creates a read-only share scoped to exactly one account', () => {
    const command = buildNewSmbShareCommand(
      'susentorno-test-vm-shared-linux',
      'C:\\repo\\test-results\\.susentorno\\vm-shared-linux',
      'susentorno-test',
    );
    expect(command).toContain("-Name 'susentorno-test-vm-shared-linux'");
    expect(command).toContain("-Path 'C:\\repo\\test-results\\.susentorno\\vm-shared-linux'");
    expect(command).toContain("-ReadAccess 'susentorno-test'");
  });
});

describe('NTFS ACE commands', () => {
  it('grants read-and-execute, inheriting to files and subdirectories', () => {
    const command = buildGrantNtfsReadExecuteCommand('C:\\repo\\share', 'susentorno-test');
    expect(command).toContain('icacls');
    expect(command).toContain("'C:\\repo\\share'");
    expect(command).toContain('(OI)(CI)(RX)');
    expect(command).toContain('susentorno-test');
  });

  it('revokes every ACE for the account, so teardown leaves the checkout as it found it', () => {
    const command = buildRevokeNtfsAceCommand('C:\\repo\\share', 'susentorno-test');
    expect(command).toContain('/remove:g');
    expect(command).toContain('susentorno-test');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/testShare.test.ts`
Expected: FAIL — `Cannot find module '../../guest/testShare'`.

- [ ] **Step 3: Write `tests/guest/testShare.ts`**

```typescript
import { randomBytes } from 'node:crypto';
import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';

/**
 * 'susentorno-test-share' would be 21 characters, one over New-LocalUser
 * -Name's 20-character cap. That cap is what drives the whole naming scheme:
 * susentorno-<isolation> has headroom, susentorno-<isolation>-share does not.
 */
export const SHARE_ACCOUNT = 'susentorno-test';

/**
 * An SMB share name is machine-global, so an unprefixed 'vm-shared-linux' would
 * collide with a developer's real share. The guest consequently mounts at
 * /mnt/susentorno-test-vm-shared-linux; every guest script resolves its own
 * directory relatively, so nothing downstream cares.
 */
export const SHARE_NAME = 'susentorno-test-vm-shared-linux';

/**
 * Never persisted and never printed. The account exists only for the lifetime of
 * one test file, and only the in-process value is ever passed to mountShare.
 */
export function generateSharePassword(): string {
  // base64url avoids characters PowerShell or the CIFS credential file would
  // have to escape; the fixed suffix guarantees all four character classes
  // regardless of what the random half happened to produce.
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

export function buildRemoveLocalUserCommand(name: string): string {
  return `Remove-LocalUser -Name ${quoteForPowerShell(name)} -ErrorAction SilentlyContinue`;
}

export function buildNewLocalUserCommand(name: string, password: string): string {
  return (
    `New-LocalUser -Name ${quoteForPowerShell(name)} ` +
    `-Password (ConvertTo-SecureString ${quoteForPowerShell(password)} -AsPlainText -Force) ` +
    `-PasswordNeverExpires -UserMayNotChangePassword | Out-Null`
  );
}

export function buildRemoveSmbShareCommand(name: string): string {
  return `Remove-SmbShare -Name ${quoteForPowerShell(name)} -Force -ErrorAction SilentlyContinue`;
}

export function buildNewSmbShareCommand(name: string, path: string, account: string): string {
  return (
    `New-SmbShare -Name ${quoteForPowerShell(name)} -Path ${quoteForPowerShell(path)} ` +
    `-ReadAccess ${quoteForPowerShell(account)} | Out-Null`
  );
}

/**
 * New-SmbShare -ReadAccess sets SHARE permissions; effective access is the
 * intersection of share and NTFS permissions. The share path sits inside the
 * repository checkout, whose inherited ACLs this suite does not control and
 * which grant this account nothing — so without this the guest authenticates
 * successfully and THEN gets access denied, a failure that presents as a
 * credential problem and is not one.
 *
 * (OI)(CI) so the grant inherits to files and subdirectories; (RX) is
 * read-and-execute, which is what traversing pre-scripts/ and running them
 * needs and is the ceiling of what the guest should ever have.
 */
export function buildGrantNtfsReadExecuteCommand(path: string, account: string): string {
  return `icacls ${quoteForPowerShell(path)} /grant ${quoteForPowerShell(`${account}:(OI)(CI)(RX)`)} | Out-Null`;
}

export function buildRevokeNtfsAceCommand(path: string, account: string): string {
  return `icacls ${quoteForPowerShell(path)} /remove:g ${quoteForPowerShell(account)} | Out-Null`;
}

export interface TestShare {
  account: string;
  shareName: string;
  password: string;
}

/**
 * Remove-if-exists, then create. Each test file creates and removes the same
 * account and share names, and teardown is best-effort — so a failed
 * Remove-SmbShare in the first file would make the second file's New-SmbShare
 * fail on a name collision. The origin-blind sweep only runs once, in
 * globalSetup, not between files, so both creators reconcile for themselves.
 */
export async function createTestShare(
  exec: PowerShellExec,
  sharePath: string,
): Promise<TestShare> {
  const password = generateSharePassword();
  await exec.run(buildRemoveSmbShareCommand(SHARE_NAME));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));

  const created = await exec.run(buildNewLocalUserCommand(SHARE_ACCOUNT, password));
  if (created.exitCode !== 0) {
    throw new Error(`testShare: could not create '${SHARE_ACCOUNT}': ${created.stdout}`);
  }
  const granted = await exec.run(buildGrantNtfsReadExecuteCommand(sharePath, SHARE_ACCOUNT));
  if (granted.exitCode !== 0) {
    throw new Error(`testShare: could not grant NTFS access on '${sharePath}': ${granted.stdout}`);
  }
  const shared = await exec.run(buildNewSmbShareCommand(SHARE_NAME, sharePath, SHARE_ACCOUNT));
  if (shared.exitCode !== 0) {
    throw new Error(`testShare: could not create share '${SHARE_NAME}': ${shared.stdout}`);
  }
  return { account: SHARE_ACCOUNT, shareName: SHARE_NAME, password };
}

/** Best-effort and independent: one failure must not strand the rest. */
export async function removeTestShare(exec: PowerShellExec, sharePath: string): Promise<void> {
  await exec.run(buildRemoveSmbShareCommand(SHARE_NAME));
  await exec.run(buildRevokeNtfsAceCommand(sharePath, SHARE_ACCOUNT));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/testShare.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Smoke-test it against real Windows**

The executors touch real machine state, so confirm the round trip by hand before a test file depends on it (elevated PowerShell, from the repo root):

```powershell
$p = Read-Host -AsSecureString "throwaway"
New-Item -ItemType Directory -Force .\test-results\smoke-share | Out-Null
New-LocalUser -Name 'susentorno-test' -Password $p -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
icacls (Resolve-Path .\test-results\smoke-share) /grant 'susentorno-test:(OI)(CI)(RX)'
New-SmbShare -Name 'susentorno-test-vm-shared-linux' -Path (Resolve-Path .\test-results\smoke-share) -ReadAccess 'susentorno-test'
Get-SmbShareAccess -Name 'susentorno-test-vm-shared-linux'
(Get-Acl .\test-results\smoke-share).Access | Where-Object IdentityReference -like '*susentorno-test'
```

Expected: `Get-SmbShareAccess` shows `susentorno-test` with `Read`, and the ACL query shows a `ReadAndExecute` entry — **both**, which is the point of the task.

Clean up:

```powershell
Remove-SmbShare -Name 'susentorno-test-vm-shared-linux' -Force
icacls (Resolve-Path .\test-results\smoke-share) /remove:g 'susentorno-test'
Remove-LocalUser -Name 'susentorno-test'
Remove-Item -Recurse -Force .\test-results\smoke-share
```

If `New-LocalUser` fails with a password-policy complaint, `generateSharePassword`'s character classes are not enough for this machine's policy — widen it rather than shortening the password.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/testShare.ts tests/unit/guest/testShare.test.ts
git commit -m "test: per-file SMB share, local account, and NTFS ACE for the guest tier"
```

---

## Task 11: The residue sweep, per-test guests, and the IP candidate filter

**Files:**

- Create: `tests/guest/hyperv/sweep.ts`
- Create: `tests/guest/hyperv/testGuest.ts`
- Test: `tests/unit/guest/sweep.test.ts`, `tests/unit/guest/testGuest.test.ts`

**Interfaces:**

- Consumes: everything from `vm.ts`, `imageCache.ts`, `vhd.ts`, `serialLog.ts`; `SHARE_ACCOUNT`, `SHARE_NAME`, `buildRemoveLocalUserCommand`, `buildRemoveSmbShareCommand` from `tests/guest/testShare`; `getVmIpAddresses` from `src/guestSetup/hyperVQueries`; `waitForReachable` from `src/guestSetup/reachabilityWait`; `realTcpConnect` from `src/guestSetup/tcpConnect`; `networkAddress` from `src/runHosting/ip`.
- Produces:
  ```typescript
  // tests/guest/hyperv/sweep.ts
  export function isSweepableChildVhd(filename: string): boolean;
  export function sweepIsolationResidue(exec: PowerShellExec): Promise<void>;

  // tests/guest/hyperv/testGuest.ts
  export interface ExpectedNetwork { address: string; netmask: string }
  export function filterCandidateAddresses(addresses: string[], expected: ExpectedNetwork): string[];
  export interface TestGuest { role: GuestRole; vmName: string; address: string; serial: SerialLogHandle }
  export function createTestGuest(exec: PowerShellExec, role: GuestRole, switchName: string, expected: ExpectedNetwork, artifactsDir: string): Promise<TestGuest>;
  export function destroyTestGuest(exec: PowerShellExec, guest: TestGuest): Promise<void>;
  ```

`sweepIsolationResidue` is **name-driven and origin-blind**, the same discipline `delete-host-network` already applies to firewall rules ([ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md)). It runs at startup *and* teardown: startup makes a Ctrl-C'd run recoverable, teardown keeps a passing run from leaving a local account and three VMs on the machine.

The candidate filter exists because `getVmIpAddresses` (`src/guestSetup/hyperVQueries.ts:83-85`) `flatMap`s every reported address across every adapter with no address-family or subnet filtering, and `waitForReachable` returns the first candidate that accepts a connection. During a switch transition that set can include a stale Default-Switch address or a link-local IPv6 address. Production tolerates the unfiltered list because a human supplies the address it actually uses; the harness has no such backstop.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guest/sweep.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isSweepableChildVhd } from '../../guest/hyperv/sweep';

describe('isSweepableChildVhd', () => {
  it('sweeps the three per-role differencing disks', () => {
    expect(isSweepableChildVhd('susentorno-test-phases.vhdx')).toBe(true);
    expect(isSweepableChildVhd('susentorno-test-e2e.vhdx')).toBe(true);
    expect(isSweepableChildVhd('susentorno-test-fresh.vhdx')).toBe(true);
  });

  it('sweeps a half-built golden installer or seed disk', () => {
    expect(isSweepableChildVhd('susentorno-test-golden-installer.vhdx')).toBe(true);
    expect(isSweepableChildVhd('susentorno-test-golden-seed.vhdx')).toBe(true);
  });

  it('NEVER sweeps the golden image itself — it is a cache, not residue', () => {
    expect(isSweepableChildVhd('susentorno-test-golden.vhdx')).toBe(false);
  });

  it('never sweeps the ISO, the stamp, the serial log, or the keypairs', () => {
    for (const name of [
      'ubuntu-26.04-live-server-amd64.iso',
      'susentorno-test-golden.vhdx.stamp',
      'golden-build-serial.log',
      'harness_ed25519',
      'harness_ed25519.pub',
      'guest_host_ed25519',
      'guest_host_ed25519.pub',
    ]) {
      expect(isSweepableChildVhd(name), name).toBe(false);
    }
  });

  it("never sweeps another installation's disks", () => {
    expect(isSweepableChildVhd('susentorno-internal.vhdx')).toBe(false);
    expect(isSweepableChildVhd('susentorno-other-e2e.vhdx')).toBe(false);
    expect(isSweepableChildVhd('my-vm.vhdx')).toBe(false);
  });
});
```

Create `tests/unit/guest/testGuest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { filterCandidateAddresses } from '../../guest/hyperv/testGuest';

const internal = { address: '192.168.68.1', netmask: '255.255.255.0' };

describe('filterCandidateAddresses', () => {
  it('keeps only IPv4 addresses inside the subnet currently expected', () => {
    expect(
      filterCandidateAddresses(['172.28.144.31', '192.168.68.42', 'fe80::215:5dff:fe01:203'], internal),
    ).toEqual(['192.168.68.42']);
  });

  it('drops a stale Default-Switch address during a switch transition', () => {
    // This is the bug the filter exists for: waitForReachable returns the FIRST
    // candidate that answers, and a guest mid-isolation can still be reachable
    // on its old lease for a few seconds.
    expect(filterCandidateAddresses(['172.28.144.31'], internal)).toEqual([]);
  });

  it('drops link-local IPv6, which getVmIpAddresses reports unfiltered', () => {
    expect(filterCandidateAddresses(['fe80::215:5dff:fe01:203'], internal)).toEqual([]);
  });

  it('returns an empty set rather than throwing when KVP has not caught up', () => {
    expect(filterCandidateAddresses([], internal)).toEqual([]);
  });

  it('honours a netmask that is not a /24', () => {
    const narrow = { address: '192.168.68.1', netmask: '255.255.255.128' };
    expect(filterCandidateAddresses(['192.168.68.42', '192.168.68.200'], narrow)).toEqual([
      '192.168.68.42',
    ]);
  });

  it('keeps every in-subnet address, in order, rather than picking one', () => {
    expect(
      filterCandidateAddresses(['192.168.68.9', '10.0.0.1', '192.168.68.42'], internal),
    ).toEqual(['192.168.68.9', '192.168.68.42']);
  });

  it('ignores malformed entries instead of letting them through', () => {
    expect(filterCandidateAddresses(['', 'not-an-ip', '192.168.68.5'], internal)).toEqual([
      '192.168.68.5',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/guest/sweep.test.ts tests/unit/guest/testGuest.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write `tests/guest/hyperv/sweep.ts`**

```typescript
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { buildRemoveLocalUserCommand, buildRemoveSmbShareCommand } from '../testShare';
import { SHARE_ACCOUNT, SHARE_NAME } from '../testShare';
import { imageCacheDir, NAME_PREFIX } from './imageCache';
import { buildGetVmNamesCommand, buildRemoveVmCommand, buildTurnOffVmCommand, parseVmNames } from './vm';

/**
 * Everything named `susentorno-test-*.vhdx` EXCEPT the golden image, which is a
 * cache rather than residue and is what makes a warm run fast. The keypairs, the
 * ISO, the stamp, and the build serial log are not .vhdx files at all, so they
 * fall out for free — but they are asserted explicitly, because a future
 * loosening of this predicate would silently cost a 30-minute rebuild.
 */
export function isSweepableChildVhd(filename: string): boolean {
  if (!filename.endsWith('.vhdx')) return false;
  if (!filename.startsWith(`${NAME_PREFIX}-`)) return false;
  return filename !== `${NAME_PREFIX}-golden.vhdx`;
}

/**
 * Name-driven and origin-blind: it does not care whether this run created the
 * residue, only that the name says it belongs to this isolation. The same
 * discipline delete-host-network already applies to firewall rules (ADR-0023).
 *
 * Runs at startup AND teardown. Startup makes a Ctrl-C'd run recoverable;
 * teardown keeps a passing run from leaving a local account and three VMs on
 * the machine. Every step is independently best-effort — one failure must not
 * strand the rest.
 */
export async function sweepIsolationResidue(exec: PowerShellExec): Promise<void> {
  const { stdout } = await exec.run(buildGetVmNamesCommand(`${NAME_PREFIX}-*`));
  for (const name of parseVmNames(stdout)) {
    await exec.run(buildTurnOffVmCommand(name));
    await exec.run(buildRemoveVmCommand(name));
  }

  if (existsSync(imageCacheDir)) {
    for (const entry of readdirSync(imageCacheDir)) {
      if (isSweepableChildVhd(entry)) rmSync(join(imageCacheDir, entry), { force: true });
    }
  }

  await exec.run(buildRemoveSmbShareCommand(SHARE_NAME));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
}
```

Merge the two `../testShare` import lines into one before committing; they are split above only to show which symbols come from where, and `pnpm lint` flags the duplicate.

- [ ] **Step 4: Write `tests/guest/hyperv/testGuest.ts`**

```typescript
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { getVmIpAddresses } from '../../../src/guestSetup/hyperVQueries';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import { waitForReachable } from '../../../src/guestSetup/reachabilityWait';
import { realTcpConnect } from '../../../src/guestSetup/tcpConnect';
import { networkAddress } from '../../../src/runHosting/ip';
import {
  goldenVhdPath,
  rolePipeName,
  roleVhdPath,
  roleVmName,
  type GuestRole,
} from './imageCache';
import { buildNewDifferencingVhdCommand } from './vhd';
import {
  buildAddVmHardDiskCommand,
  buildEnableSecureBootCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetVmComPortCommand,
  buildSetVmDynamicMemoryCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';
import { startSerialLog, type SerialLogHandle } from './serialLog';

export interface ExpectedNetwork {
  address: string;
  netmask: string;
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * getVmIpAddresses flatMaps every reported address across every adapter with no
 * address-family or subnet filtering, and waitForReachable returns the FIRST
 * candidate that accepts a connection. During a switch transition that set can
 * include a stale Default-Switch address (still briefly reachable) or a
 * link-local IPv6 address. Production tolerates the unfiltered list because a
 * human supplies the address it actually uses; the harness has no such backstop.
 *
 * An empty result means "KVP has not caught up yet", not failure — the caller
 * polls.
 */
export function filterCandidateAddresses(
  addresses: string[],
  expected: ExpectedNetwork,
): string[] {
  const wanted = networkAddress(expected.address, expected.netmask);
  return addresses.filter((address) => {
    if (!IPV4_RE.test(address)) return false;
    if (address.split('.').some((octet) => Number(octet) > 255)) return false;
    return networkAddress(address, expected.netmask) === wanted;
  });
}

export interface TestGuest {
  role: GuestRole;
  vmName: string;
  address: string;
  serial: SerialLogHandle;
}

/**
 * One guest, on one copy-on-write overlay of the golden image — the direct
 * analogue of the old harness's `qemu-img create -b "$GOLDEN"`. Three
 * independent overlays, no test able to see another's writes. The golden VHDX
 * is never booted or modified after the build: Hyper-V stamps parent identity
 * into each child, so touching the parent invalidates all of them.
 */
export async function createTestGuest(
  exec: PowerShellExec,
  role: GuestRole,
  switchName: string,
  expected: ExpectedNetwork,
  artifactsDir: string,
): Promise<TestGuest> {
  const vmName = roleVmName(role);
  const vhdPath = roleVhdPath(role);

  await exec.run(buildTurnOffVmCommand(vmName));
  await exec.run(buildRemoveVmCommand(vmName));
  rmSync(vhdPath, { force: true });

  const commands: [string, string][] = [
    [buildNewDifferencingVhdCommand(vhdPath, goldenVhdPath), 'create the differencing disk'],
    [
      buildNewVmCommand(vmName, { memoryStartupBytes: 2048 * 1024 ** 2, switchName }),
      'create the VM',
    ],
    [buildAddVmHardDiskCommand(vmName, vhdPath), 'attach the differencing disk'],
    [buildSetVmProcessorCommand(vmName, 2), 'set the processor count'],
    // Production uses 12288 MB, but only one guest runs at a time and nothing
    // here is memory-hungry.
    [
      buildSetVmDynamicMemoryCommand(vmName, 2048 * 1024 ** 2, 4096 * 1024 ** 2),
      'enable dynamic memory',
    ],
    // ON, with the UEFI CA template — matching setup-guest.md:39, i.e. what a
    // real user configures. Only the build VM runs with it off.
    [buildEnableSecureBootCommand(vmName), 'enable Secure Boot'],
    [buildSetVmComPortCommand(vmName, rolePipeName(role)), 'attach COM1'],
  ];
  for (const [command, what] of commands) {
    const { exitCode, stdout } = await exec.run(command);
    if (exitCode !== 0) {
      throw new Error(`testGuest(${role}): could not ${what} (exit ${exitCode}): ${stdout || command}`);
    }
  }

  const serialLogPath = join(artifactsDir, role, 'serial.log');
  const serial = startSerialLog(rolePipeName(role), serialLogPath);

  const started = await exec.run(buildStartVmCommand(vmName));
  if (started.exitCode !== 0) {
    await serial.stop();
    throw new Error(`testGuest(${role}): Start-VM failed: ${started.stdout}`);
  }

  const reachability = await waitForReachable({
    getCandidates: async () =>
      filterCandidateAddresses(await getVmIpAddresses(exec, vmName), expected),
    connect: realTcpConnect,
    timeoutMs: 600_000,
    onProgress: (elapsedMs) =>
      console.log(`guest(${role}): waiting for :22... (${Math.round(elapsedMs / 1000)}s)`),
  });
  if (!reachability.reachable) {
    await serial.stop();
    throw new Error(
      `testGuest(${role}): '${vmName}' never became reachable on port 22 in the ` +
        `${expected.address}/${expected.netmask} network. The boot log is the entire ` +
        `diagnostic here: see ${serialLogPath}.`,
    );
  }

  return { role, vmName, address: reachability.address, serial };
}

/** Best-effort and independent, so one failure does not strand the rest. */
export async function destroyTestGuest(exec: PowerShellExec, guest: TestGuest): Promise<void> {
  await guest.serial.stop().catch(() => {});
  await exec.run(buildTurnOffVmCommand(guest.vmName));
  await exec.run(buildRemoveVmCommand(guest.vmName));
  rmSync(roleVhdPath(guest.role), { force: true });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/guest/sweep.test.ts tests/unit/guest/testGuest.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/hyperv/sweep.ts tests/guest/hyperv/testGuest.ts tests/unit/guest/sweep.test.ts tests/unit/guest/testGuest.test.ts
git commit -m "test: origin-blind residue sweep and differencing-disk guest lifecycle"
```

---

## Task 12: Host-key trust, the harness `RemoteExec`, and the `ssh-agent` probe

**Files:**

- Create: `tests/guest/knownHosts.ts`
- Create: `tests/guest/guestExec.ts`
- Create: `tests/sshAgentIdentity.ts`
- Test: `tests/unit/guest/knownHosts.test.ts`, `tests/unit/sshAgentIdentity.test.ts`

**Interfaces:**

- Consumes: `RemoteExec`, `RemoteExecResult`, `SshTarget` from `src/guestSetup/remoteExec`; `quoteForRemoteShell` from `src/guestSetup/quoteForRemoteShell`; `harnessKeyPath`, `imageCacheDir` from `tests/guest/hyperv/imageCache`.
- Produces:
  ```typescript
  // tests/guest/knownHosts.ts
  export function knownHostsPath(): string;
  export function buildKnownHostsLine(ip: string, hostPublicKey: string): string;
  export function appendKnownHostsLine(contents: string, line: string): string;
  export function trustGuestHostKey(ip: string, hostPublicKey: string): Promise<void>;
  export function untrustGuestHostKey(ip: string): Promise<void>;

  // tests/guest/guestExec.ts
  export const HARNESS_KNOWN_HOSTS_PATH: string;
  export function buildHarnessSshOptions(): string[];
  export function createHarnessRemoteExec(target: SshTarget): RemoteExec;

  // tests/sshAgentIdentity.ts
  export function parseFingerprint(stdout: string): string | null;
  export function parseAgentFingerprints(stdout: string): string[];
  export function ensureSshAgentIdentity(privateKeyPath: string): Promise<void>;
  export function removeSshAgentIdentity(privateKeyPath: string): Promise<void>;
  ```

Three mechanisms, one problem: `src/guestSetup/remoteExec.ts:52,58` spawns bare `ssh`/`scp` with **no `-o` options**, inheriting the developer's `~/.ssh/config` and `known_hosts` under OpenSSH's default `StrictHostKeyChecking=ask`. Both failure directions matter — a *stale* entry for a recycled IP after a golden rebuild gives a hard `REMOTE HOST IDENTIFICATION HAS CHANGED`, and a *missing* entry gives an interactive authenticity prompt the e2e run cannot answer, because its piped stdin carries only the SMB password, which `promptMasked` consumes ([ADR-0022](../../adr/0022-promptmasked-releases-stdin-explicitly.md)).

**`known_hosts` is handled per exact IP, never per subnet.** An earlier draft of the design swept every entry in the Internal- and Default-Switch subnets; that is both under-specified and over-destructive — `resolveForwardListenAddress` returns an address and no netmask, so the Default Switch subnet is not derivable from it at all, a textual prefix match would miss hashed entries, and wiping a whole Default-Switch subnet would delete trust records for a developer's *other* Hyper-V VMs, which are not this tier's residue by any definition.

`phases` and `fresh` build their own `RemoteExec` through `createHarnessRemoteExec` and pass explicit `-o` options, so **only the e2e path depends on the real `known_hosts` at all** — but that one path is the whole reason the guest host key is baked into the image.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guest/knownHosts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildKnownHostsLine, appendKnownHostsLine } from '../../guest/knownHosts';

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOSTKEY susentorno-test-guest';

describe('buildKnownHostsLine', () => {
  it('pairs the exact IP with the key type and blob', () => {
    expect(buildKnownHostsLine('192.168.68.42', publicKey)).toBe(
      '192.168.68.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOSTKEY',
    );
  });

  it('drops the trailing comment, which known_hosts does not use', () => {
    expect(buildKnownHostsLine('192.168.68.42', publicKey)).not.toContain('susentorno-test-guest');
  });

  it('tolerates a public key with no comment at all', () => {
    expect(buildKnownHostsLine('10.0.0.1', 'ssh-ed25519 AAAAB')).toBe('10.0.0.1 ssh-ed25519 AAAAB');
  });

  it('never emits a wildcard or a subnet pattern', () => {
    const line = buildKnownHostsLine('192.168.68.42', publicKey);
    expect(line).not.toContain('*');
    expect(line).not.toContain('/');
  });

  it('rejects a public key that is not a two-field key', () => {
    expect(() => buildKnownHostsLine('10.0.0.1', 'garbage')).toThrow(/not an ssh public key/);
  });
});

describe('appendKnownHostsLine', () => {
  const line = buildKnownHostsLine('192.168.68.42', publicKey);

  it('appends to an empty file without a leading blank line', () => {
    expect(appendKnownHostsLine('', line)).toBe(`${line}\n`);
  });

  it('appends after existing content, preserving it exactly', () => {
    expect(appendKnownHostsLine('github.com ssh-ed25519 AAAAOTHER\n', line)).toBe(
      `github.com ssh-ed25519 AAAAOTHER\n${line}\n`,
    );
  });

  it('inserts the missing newline when the file did not end with one', () => {
    expect(appendKnownHostsLine('github.com ssh-ed25519 AAAAOTHER', line)).toBe(
      `github.com ssh-ed25519 AAAAOTHER\n${line}\n`,
    );
  });

  it('is idempotent, so a retried trustGuestHostKey does not duplicate the entry', () => {
    const once = appendKnownHostsLine('', line);
    expect(appendKnownHostsLine(once, line)).toBe(once);
  });

  it('round-trips: the appended line is exactly what a reader gets back', () => {
    const contents = appendKnownHostsLine('existing.example ssh-rsa AAAAOLD\n', line);
    expect(contents.split('\n').filter(Boolean)).toEqual([
      'existing.example ssh-rsa AAAAOLD',
      line,
    ]);
  });

  it('round-trips through a real file, leaving unrelated entries byte-identical', () => {
    // Against a fixture file, not just strings: this is the shape trustGuestHostKey
    // uses — read, append, write — and the property that matters is that a
    // developer's own trust records survive it untouched.
    const dir = mkdtempSync(join(tmpdir(), 'known-hosts-'));
    const path = join(dir, 'known_hosts');
    const existing = '|1|hashedbase64==|alsohashed== ssh-ed25519 AAAAHASHED\ngithub.com ssh-rsa AAAAGH\n';
    try {
      writeFileSync(path, existing);
      writeFileSync(path, appendKnownHostsLine(readFileSync(path, 'utf8'), line));
      expect(readFileSync(path, 'utf8')).toBe(`${existing}${line}\n`);

      // A second trust of the same host must not duplicate it.
      writeFileSync(path, appendKnownHostsLine(readFileSync(path, 'utf8'), line));
      expect(readFileSync(path, 'utf8')).toBe(`${existing}${line}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Add the Node imports this last test needs at the top of the file:

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Create `tests/unit/sshAgentIdentity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseFingerprint, parseAgentFingerprints } from '../sshAgentIdentity';

describe('parseFingerprint', () => {
  it('extracts the SHA256 fingerprint from ssh-keygen -lf output', () => {
    expect(
      parseFingerprint('256 SHA256:abc123DEF/ghi+jkl susentorno-guest-tier-harness (ED25519)\n'),
    ).toBe('SHA256:abc123DEF/ghi+jkl');
  });

  it('returns null when nothing looks like a fingerprint', () => {
    expect(parseFingerprint('is not a public key file\n')).toBeNull();
    expect(parseFingerprint('')).toBeNull();
  });
});

describe('parseAgentFingerprints', () => {
  it('lists every identity the agent holds', () => {
    expect(
      parseAgentFingerprints(
        [
          '256 SHA256:aaa/AAA+111 personal@laptop (ED25519)',
          '3072 SHA256:bbb/BBB+222 work@laptop (RSA)',
          '',
        ].join('\n'),
      ),
    ).toEqual(['SHA256:aaa/AAA+111', 'SHA256:bbb/BBB+222']);
  });

  it('returns an empty list for an agent with no identities', () => {
    expect(parseAgentFingerprints('The agent has no identities.\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/guest/knownHosts.test.ts tests/unit/sshAgentIdentity.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write `tests/guest/knownHosts.ts`**

```typescript
import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function knownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts');
}

/**
 * `<exact ip> <keytype> <blob>`. Exact IPs only, never a wildcard or a subnet
 * pattern: this file also holds a developer's trust records for their own
 * machines and their other Hyper-V VMs, and none of that is this tier's residue
 * by any definition.
 *
 * The comment field is dropped — known_hosts ignores it, and keeping it would
 * make the idempotency check in appendKnownHostsLine sensitive to it.
 */
export function buildKnownHostsLine(ip: string, hostPublicKey: string): string {
  const [keyType, blob] = hostPublicKey.trim().split(/\s+/);
  if (!keyType || !blob) {
    throw new Error(`knownHosts: '${hostPublicKey}' is not an ssh public key`);
  }
  return `${ip} ${keyType} ${blob}`;
}

export function appendKnownHostsLine(contents: string, line: string): string {
  if (contents.split('\n').some((existing) => existing.trim() === line)) return contents;
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n';
  return `${contents}${separator}${line}\n`;
}

/**
 * Drop any stale entry for this exact IP, then write the key we generated —
 * trust by construction rather than trust-on-first-use. Possible only because
 * the guest's host key is baked into the golden image, so the harness KNOWS it.
 *
 * `ssh-keygen -R` rather than a text filter: it is the only thing that also
 * removes HASHED entries, which a prefix match would silently miss.
 */
export async function trustGuestHostKey(ip: string, hostPublicKey: string): Promise<void> {
  await untrustGuestHostKey(ip);
  const path = knownHostsPath();
  mkdirSync(dirname(path), { recursive: true });
  const contents = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, appendKnownHostsLine(contents, buildKnownHostsLine(ip, hostPublicKey)));
}

export async function untrustGuestHostKey(ip: string): Promise<void> {
  // Exit code is ignored on purpose: "no such entry" is a success for teardown,
  // and ssh-keygen -R reports it as a failure.
  await execa('ssh-keygen', ['-R', ip], { reject: false });
}
```

- [ ] **Step 4: Write `tests/guest/guestExec.ts`**

```typescript
import { execa } from 'execa';
import { join } from 'node:path';
import {
  buildScpArgv,
  buildSshRunArgv,
  type RemoteExec,
  type RemoteExecResult,
  type SshTarget,
} from '../../src/guestSetup/remoteExec';
import { harnessKeyPath, imageCacheDir } from './hyperv/imageCache';

/**
 * A file of the harness's own, never the developer's ~/.ssh/known_hosts. The
 * phases and fresh tests do not need the real one — only e2e does, because only
 * e2e runs production's createSshRemoteExec.
 */
export const HARNESS_KNOWN_HOSTS_PATH = join(imageCacheDir, 'harness-known-hosts');

/**
 * The explicit options production deliberately does not pass, mirroring what
 * the old harness's SSH_OPTS did:
 *
 * - StrictHostKeyChecking=no + a private UserKnownHostsFile: a fresh
 *   differencing disk per file means a recycled IP with a "new" host is normal
 *   here, and there is nobody to answer an authenticity prompt.
 * - IdentityFile + IdentitiesOnly: the harness key, and nothing the developer's
 *   ~/.ssh/config might otherwise offer first.
 * - BatchMode=yes: fail rather than prompt for anything, ever.
 */
export function buildHarnessSshOptions(): string[] {
  return [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${HARNESS_KNOWN_HOSTS_PATH}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-i',
    harnessKeyPath,
  ];
}

/**
 * The harness's RemoteExec. Deliberately a sibling of production's
 * createSshRemoteExec rather than a replacement: it reuses buildSshRunArgv and
 * buildScpArgv so the command-quoting semantics under test stay identical, and
 * only prepends transport options production leaves to the developer's config.
 */
export function createHarnessRemoteExec(target: SshTarget): RemoteExec {
  const options = buildHarnessSshOptions();
  return {
    async run(remoteCommand: string): Promise<RemoteExecResult> {
      const result = await execa('ssh', [...options, ...buildSshRunArgv(target, remoteCommand)], {
        reject: false,
        all: true,
      });
      if (result.exitCode !== 0) {
        console.log(`guest| ${remoteCommand}\nguest| ${result.all ?? ''}`);
      }
      return { exitCode: result.exitCode ?? 1 };
    },
    async copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult> {
      const result = await execa(
        'scp',
        [...options, ...buildScpArgv(target, localPath, remoteDestPath)],
        { reject: false, all: true },
      );
      return { exitCode: result.exitCode ?? 1 };
    },
  };
}

/**
 * Same transport, but returning stdout as well — the test files assert on guest
 * output, which RemoteExec's exit-code-only contract deliberately does not
 * carry.
 */
export async function guestCapture(
  target: SshTarget,
  remoteCommand: string,
): Promise<{ stdout: string; exitCode: number }> {
  const result = await execa(
    'ssh',
    [...buildHarnessSshOptions(), ...buildSshRunArgv(target, remoteCommand)],
    { reject: false, all: true },
  );
  return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
}
```

- [ ] **Step 5: Write `tests/sshAgentIdentity.ts`**

```typescript
import { execa } from 'execa';

const FINGERPRINT_RE = /\bSHA256:[A-Za-z0-9+/=]+/;

export function parseFingerprint(stdout: string): string | null {
  return FINGERPRINT_RE.exec(stdout)?.[0] ?? null;
}

export function parseAgentFingerprints(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => parseFingerprint(line))
    .filter((f): f is string => f !== null);
}

/**
 * Adds the harness key to ssh-agent, then PROVES the agent production's `ssh`
 * would talk to can see it.
 *
 * The probe is not ceremony. remoteExec.ts:54,61 resolves `ssh` and `scp` as
 * bare names through PATH, and a Windows box commonly has two OpenSSH
 * installations — the Windows one (which talks to the ssh-agent SERVICE) and
 * Git for Windows' (which expects SSH_AUTH_SOCK). Confirming a service is
 * running proves nothing about whether the `ssh` production actually invokes
 * can see the identity. So resolve `ssh-add` the same way — bare name through
 * PATH — add the key, then list and assert the fingerprint appears.
 *
 * ssh-agent is the only non-invasive answer to key delivery at all: the e2e test
 * runs the real createSshRemoteExec, so `ssh` must FIND the private key, and the
 * harness can neither write IdentityFile into the developer's ~/.ssh/config nor
 * name the key ~/.ssh/id_ed25519 and clobber theirs.
 *
 * What this cannot catch, and the risks section says so: a user ~/.ssh/config
 * with `IdentitiesOnly yes` scoped to the test subnet defeats agent identities
 * entirely, and nothing short of a full connection test would see it.
 */
export async function ensureSshAgentIdentity(privateKeyPath: string): Promise<void> {
  const listed = await execa('ssh-keygen', ['-lf', `${privateKeyPath}.pub`], { reject: false });
  const fingerprint = parseFingerprint(listed.stdout ?? '');
  if (!fingerprint) {
    throw new Error(
      `ssh-agent: could not read a fingerprint from ${privateKeyPath}.pub — ` +
        `is 'ssh-keygen' on PATH? (\`${listed.stdout ?? ''}\`)`,
    );
  }

  const added = await execa('ssh-add', [privateKeyPath], { reject: false, all: true });
  if (added.exitCode !== 0) {
    throw new Error(
      `ssh-agent: \`ssh-add ${privateKeyPath}\` failed: ${added.all ?? ''}\n` +
        'The guest tier needs a running ssh-agent, because the e2e test runs the real ' +
        "setup-guest-unix and its bare `ssh` has to find the harness key without editing your " +
        '~/.ssh/config. Start it with (elevated PowerShell):\n' +
        '  Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent',
    );
  }

  const agent = await execa('ssh-add', ['-l'], { reject: false, all: true });
  if (!parseAgentFingerprints(agent.stdout ?? '').includes(fingerprint)) {
    throw new Error(
      `ssh-agent: added ${privateKeyPath} but \`ssh-add -l\` does not list ${fingerprint}.\n` +
        'This usually means two OpenSSH installations are on PATH — Windows\' (which uses the ' +
        "ssh-agent service) and Git for Windows' (which expects SSH_AUTH_SOCK) — and the one " +
        '`ssh-add` resolved to is not the one `ssh` will resolve to. Put ' +
        'C:\\Windows\\System32\\OpenSSH ahead of Git\\usr\\bin on PATH and re-run.\n' +
        `\`ssh-add -l\` said: ${agent.all ?? ''}`,
    );
  }
}

/** Teardown. Best-effort: a missing identity is not a failure. */
export async function removeSshAgentIdentity(privateKeyPath: string): Promise<void> {
  await execa('ssh-add', ['-d', privateKeyPath], { reject: false });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/guest/knownHosts.test.ts tests/unit/sshAgentIdentity.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 7: Confirm the agent probe works on this machine**

The probe's whole value is failing loudly for the right reason, so check both directions by hand:

```powershell
ssh-add -l
ssh-add .\.image-cache\harness_ed25519
ssh-add -l
ssh-keygen -lf .\.image-cache\harness_ed25519.pub
```

Expected: the fingerprint from the last command appears in the second `ssh-add -l`. If `ssh-add` reports "Error connecting to agent", run `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent` elevated and retry — that is exactly the fix the thrown message names.

```powershell
ssh-add -d .\.image-cache\harness_ed25519
```

- [ ] **Step 8: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/knownHosts.ts tests/guest/guestExec.ts tests/sshAgentIdentity.ts tests/unit/guest/knownHosts.test.ts tests/unit/sshAgentIdentity.test.ts
git commit -m "test: per-IP host-key trust, a harness RemoteExec, and an ssh-agent identity probe"
```

---

## Task 13: The cutover — new `globalSetup`, the WSL harness deleted, and `phases.test.ts`

**Files:**

- Create: `tests/guest/diagnostics.ts`
- Rewrite: `tests/guest/globalSetup.ts`
- Create: `tests/guest/phases.test.ts`
- Delete: `tests/guest/guest.test.ts`, `tests/guest/wsl.ts`, `tests/guest/harness/` (all nine files, including `seed/`)
- Delete: `tests/host-network/goldenImageBuild.test.ts` (Task 9's scaffolding)
- Modify: `vitest.guest.config.ts`

**Interfaces:**

- Consumes: everything Tasks 1 and 5–12 produced; `createHostNetwork`/`deleteHostNetwork` from `src/hostNetwork/`; `detectTakenRanges`/`findFreeSubnet` from `src/hostNetwork/subnetSelection`; `resolveIsolationNetwork` from `src/runHosting/isolationNetwork`; `resolveInternalSwitchNetwork`/`DEFAULT_NAT_ADAPTER` from `src/runHosting/forwarder`; `mountShare`, `runPreScripts`, `listScripts`, `isolateVmToSwitch` from `src/guestSetup/`.
- Produces:
  ```typescript
  // tests/guest/diagnostics.ts
  export const artifactsDir: string;
  export function collectDiagnostics(target: SshTarget, role: GuestRole): Promise<void>;

  // tests/guest/globalSetup.ts
  export function setup(): Promise<void>;
  export function teardown(): Promise<void>;
  ```

This is the one commit where the tier changes runtime, and it has to be one commit: `vitest.guest.config.ts` sets no `passWithNoTests`, so deleting `guest.test.ts` without adding a replacement leaves a failing tier.

**`globalSetup` must export a named `teardown`**, not return one from `setup`. Vitest only registers a *returned* teardown once `setup` resolves, so a rejection inside `setup` would leave anything it had already created stranded. A named export is loaded up front and runs regardless. Today's `tests/guest/globalSetup.ts` has no teardown at all, so this is new ground rather than a change.

**The host network is created last, after the golden build.** `ensureGoldenImage` is the one step that can plausibly fail for half an hour, and reordering costs nothing because the build VM attaches to the Default Switch and never touches the Internal one — so a failed build leaves no switch or firewall rules behind. That is a mitigation, not a guarantee, which is why the named `teardown` matters too.

- [ ] **Step 1: Write `tests/guest/diagnostics.ts`**

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { repoRoot } from '../testEnvRoot';
import { guestCapture } from './guestExec';
import type { GuestRole } from './hyperv/imageCache';

/**
 * test-results/guest/<timestamp>/<role>/, unchanged from the old harness's
 * layout, and gaining serial.log alongside journal.txt and network.txt —
 * startSerialLog writes straight into it as the guest boots, so a guest that
 * never reaches :22 still leaves the one diagnostic that matters.
 */
export const artifactsDir = join(
  repoRoot,
  'test-results',
  'guest',
  new Date().toISOString().replace(/[:.]/g, '-'),
);

/**
 * Collected BEFORE teardown, and every step independently best-effort: a guest
 * that has already fallen over must still yield whatever it can, and a failed
 * dump must not mask the real failure.
 */
export async function collectDiagnostics(target: SshTarget, role: GuestRole): Promise<void> {
  const dir = join(artifactsDir, role);
  mkdirSync(dir, { recursive: true });
  const dumps: [string, string][] = [
    ['journal.txt', 'sudo journalctl -u NetworkManager -u systemd-resolved --no-pager'],
    [
      'network.txt',
      'ip addr; echo; ip -4 route; echo; sudo iptables -t nat -S; echo; resolvectl status; echo; mount | grep cifs',
    ],
  ];
  for (const [filename, command] of dumps) {
    try {
      const { stdout } = await guestCapture(target, command);
      writeFileSync(join(dir, filename), stdout);
    } catch (error) {
      writeFileSync(join(dir, filename), `diagnostics: '${command}' failed: ${String(error)}\n`);
    }
  }
  console.log(`guest(${role}): diagnostics in ${dir}`);
}
```

- [ ] **Step 2: Rewrite `tests/guest/globalSetup.ts`**

```typescript
import { homedir } from 'node:os';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { createHostNetwork } from '../../src/hostNetwork/createHostNetwork';
import { deleteHostNetwork } from '../../src/hostNetwork/deleteHostNetwork';
import { detectTakenRanges, findFreeSubnet } from '../../src/hostNetwork/subnetSelection';
import { DEFAULT_NAT_ADAPTER } from '../../src/runHosting/forwarder';
import { checkDockerRunning } from '../checkDockerRunning';
import { checkElevated } from '../checkElevated';
import { checkGatewayPortsFree } from '../checkGatewayPortsFree';
import { ensureSshAgentIdentity, removeSshAgentIdentity } from '../sshAgentIdentity';
import { ensureHarnessKeys } from './harnessKeys';
import { ensureGoldenImage } from './hyperv/goldenImage';
import { ISOLATION_NAME } from './hyperv/imageCache';
import { sweepIsolationResidue } from './hyperv/sweep';
import { harnessKeyPath } from './hyperv/imageCache';

const exec = createRealPowerShellExec();

/**
 * Cheapest guard first, slowest work last — the ordering rationale the old
 * globalSetup already carried, extended to a tier that can now spend half an
 * hour before its first assertion.
 *
 * Two orderings inside it are load-bearing rather than incidental:
 *
 * - Keys come BEFORE the image, because the golden stamp hashes both public
 *   keys. Deriving a stamp from a key that does not exist yet is not a thing.
 * - The host network is created LAST, after the build, so a failed
 *   ensureGoldenImage leaves no switch or firewall rules behind. It costs
 *   nothing: the build VM attaches to the Default Switch and never touches the
 *   Internal one.
 */
export async function setup(): Promise<void> {
  await checkElevated();
  await checkDockerRunning();
  await checkGatewayPortsFree();

  const keys = await ensureHarnessKeys();
  // Before the 30-minute build, so an agent problem is not discovered at the
  // end of it.
  await ensureSshAgentIdentity(harnessKeyPath);

  // Startup as well as teardown: this is what makes a Ctrl-C'd run recoverable.
  await sweepIsolationResidue(exec);

  await ensureGoldenImage(exec, keys);

  // The MODULES, not the CLI — the CLI would prompt for a subnet, while the
  // module takes an injectable promptSubnet. Same call shape
  // tests/host-network/createDeleteHostNetwork.test.ts:38-48 already uses.
  //
  // The tier owning its host network rather than requiring one is what keeps
  // the bootstrappable-from-clean property: requiring it would be the
  // "documented one-time manual prerequisite" already rejected for the SMB
  // share, and rejecting it there while accepting it here would be incoherent.
  await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() });
  const subnet = findFreeSubnet(detectTakenRanges());
  if (subnet === null) {
    throw new Error(
      'guest: no free 192.168.x.0/24 subnet is available for the test host network. ' +
        'Free one up, or delete a stale susentorno Internal switch, and re-run.',
    );
  }
  const { hostIp } = await createHostNetwork({
    exec,
    isolationName: ISOLATION_NAME,
    subnet,
    natAdapterAlias: DEFAULT_NAT_ADAPTER,
    homedir: homedir(),
    promptSubnet: async () => subnet,
  });
  console.log(`guest: host network ready — susentorno-test-internal at ${hostIp}`);
}

/**
 * A NAMED export, not a function returned from setup(): Vitest only registers a
 * returned teardown once setup resolves, so a rejection inside setup would
 * strand everything it had already created. A named export is loaded up front
 * and runs regardless.
 *
 * Every step independently best-effort, so one failure does not strand the rest.
 */
export async function teardown(): Promise<void> {
  await sweepIsolationResidue(exec).catch((error) =>
    console.error(`guest teardown: sweep failed: ${String(error)}`),
  );
  await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() }).catch(
    (error) => console.error(`guest teardown: delete-host-network failed: ${String(error)}`),
  );
  await removeSshAgentIdentity(harnessKeyPath).catch(() => {});
}
```

Merge the two `./hyperv/imageCache` import lines before committing.

- [ ] **Step 3: Point the config at the named exports and widen the timeouts**

Replace `vitest.guest.config.ts` in full:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/guest/**/*.test.ts'],
    globalSetup: ['tests/guest/globalSetup.ts'],
    // A guest boot, a reboot through isolation, and the e2e file's real apt /
    // pnpm / agent installers are all minutes each; the beforeAll hooks bring up
    // an entire stack (run-hosting, SMB share, a VM) on top of that.
    testTimeout: 900_000,
    hookTimeout: 1_800_000,
    // Concurrency would put two guests on one DHCP server and one SMB share,
    // and DHCP-lease and IP-discovery races are exactly the bug class this tier
    // exists to catch — the harness must not be generating them.
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Write `tests/guest/phases.test.ts`**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { listScripts } from '../../src/guestSetup/listScripts';
import { mountShare } from '../../src/guestSetup/mountShare';
import { runPreScripts } from '../../src/guestSetup/runPreScripts';
import { isolateVmToSwitch } from '../../src/guestSetup/vmReconcile';
import { getVmIpAddresses } from '../../src/guestSetup/hyperVQueries';
import { waitForReachable } from '../../src/guestSetup/reachabilityWait';
import { realTcpConnect } from '../../src/guestSetup/tcpConnect';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import {
  startProxyStack,
  stopProxyStack,
  PLACEHOLDER_AUTH,
  REAL_AUTH,
  type ProxyStack,
} from '../proxyStack';
import { envRoot } from '../testEnvRoot';
import { collectDiagnostics, artifactsDir } from './diagnostics';
import { createHarnessRemoteExec, guestCapture } from './guestExec';
import { GUEST_USERNAME } from './autoinstall';
import { ISOLATION_NAME } from './hyperv/imageCache';
import {
  createTestGuest,
  destroyTestGuest,
  filterCandidateAddresses,
  type TestGuest,
} from './hyperv/testGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';

const exec = createRealPowerShellExec();
const sharePath = join(envRoot, 'vm-shared-linux');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

let stack: ProxyStack;
let share: TestShare;
let guest: TestGuest;
let target: SshTarget;
let internalHostIp: string;
let defaultSwitchHostIp: string;

async function waitForIsolatedAddress(vmName: string): Promise<string> {
  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`phases: ${internal.adapterAlias} has no IPv4 address`);
  const reachability = await waitForReachable({
    getCandidates: async () => filterCandidateAddresses(await getVmIpAddresses(exec, vmName), internal),
    connect: realTcpConnect,
    timeoutMs: 600_000,
    onProgress: (ms) => console.log(`phases: waiting for the isolated guest... (${Math.round(ms / 1000)}s)`),
  });
  if (!reachability.reachable) {
    throw new Error(
      `phases: '${vmName}' never became reachable on the isolated network. ` +
        `Boot log: ${join(artifactsDir, 'phases', 'serial.log')}`,
    );
  }
  return reachability.address;
}

beforeAll(async () => {
  // Real forwarding on the real :80/:443, with the real DNS responder and DHCP
  // server. This is the single edit the whole design is organised around.
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });

  // After startProxyStack, never in globalSetup: startProxyStack calls
  // rmEnvRoot(envRoot) and re-runs init, so a share created earlier would point
  // at a directory deleted underneath it.
  share = await createTestShare(exec, sharePath);

  const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
  if (!natNetwork) throw new Error(`phases: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
  defaultSwitchHostIp = natNetwork.address;

  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`phases: ${internal.adapterAlias} has no IPv4 address`);
  internalHostIp = internal.address;

  guest = await createTestGuest(exec, 'phases', 'Default Switch', natNetwork, artifactsDir);
  target = { address: guest.address, username: GUEST_USERNAME };

  // Guard, not an assertion: the setup phase's resolver is Hyper-V's ICS, which
  // is a precondition of everything below rather than a claim about the product.
  // (The old suite asserted the harness's own bridge IP here — that tested the
  // harness's topology, so it is deleted rather than ported.)
  const icsProbe = await guestCapture(target, 'getent ahostsv4 archive.ubuntu.com');
  if (icsProbe.exitCode !== 0 || icsProbe.stdout.trim() === '') {
    throw new Error(
      'phases: the guest cannot resolve names on the Default Switch, so Hyper-V ICS is not ' +
        'serving it. Nothing below can pass. Check that the Default Switch exists and that ICS ' +
        `is running.\n${icsProbe.stdout}`,
    );
  }

  const remoteExec = createHarnessRemoteExec(target);
  await mountShare(remoteExec, {
    shareName: share.shareName,
    accountName: share.account,
    password: share.password,
    hostIp: defaultSwitchHostIp,
    onStep: (message) => console.log(`phases: mountShare — ${message}`),
  });

  // configure-network only, as the old suite did: running the full set is e2e's
  // job and paying for it twice would be the dominant cost in the tier.
  const scripts = listScripts(join(sharePath, 'pre-scripts')).filter(
    (s) => s.slug === 'configure-network',
  );
  expect(scripts).toHaveLength(1);
  await runPreScripts(remoteExec, {
    scripts,
    shareName: share.shareName,
    internalSwitchHostIp: internalHostIp,
  });
}, 1_800_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'phases').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  if (share) await removeTestShare(exec, sharePath).catch(() => {});
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('the SMB share against a real CIFS client', () => {
  // These four are the tier's genuinely new coverage. mountShare's orchestration
  // is already proven by eleven unit tests against a fake RemoteExec
  // (tests/unit/guestSetup/mountShare.test.ts), including the stale-unwind
  // regression at :207 — what no test does today is EXECUTE those commands
  // against a real Ubuntu CIFS client, a real systemd automount unit, and a real
  // Windows SMB server. The old harness's 9p virtfs mount shares nothing with
  // that path.
  it('installed the credentials file root-owned and mode 600', async () => {
    const { stdout } = await guestCapture(target, 'stat -c "%a %U %G" /etc/susentorno-share.cred');
    expect(stdout.trim()).toBe('600 root root');
  });

  it('created a live systemd automount unit for the mount point', async () => {
    const unit = `mnt-${share.shareName}.automount`;
    const { stdout } = await guestCapture(target, `systemctl is-active ${unit}`);
    expect(stdout.trim()).toBe('active');
  });

  it('mounted the share read-only over cifs', async () => {
    const { stdout } = await guestCapture(target, `findmnt -no FSTYPE,OPTIONS /mnt/${share.shareName}`);
    expect(stdout).toContain('cifs');
    expect(stdout).toContain('ro');
  });

  it('serves the environment s real generated files through it', async () => {
    const { stdout } = await guestCapture(
      target,
      `test -f /mnt/${share.shareName}/cert.pem && echo present`,
    );
    expect(stdout.trim()).toBe('present');
  });
});

describe('provisioning during the setup phase', () => {
  it('runPreScripts installed and trusted the proxy CA', async () => {
    const { stdout } = await guestCapture(
      target,
      'test -f /usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt && echo present',
    );
    expect(stdout.trim()).toBe('present');
  });

  it('runs 04-configure-network.sh directly from the VM share', async () => {
    const { stdout } = await guestCapture(
      target,
      `bash /mnt/${share.shareName}/pre-scripts/04-configure-network.sh ${internalHostIp}`,
    );
    expect(stdout).toContain('configure-network:');
  });

  it('installed no DNAT rules', async () => {
    const { stdout } = await guestCapture(target, 'sudo iptables -t nat -S OUTPUT');
    expect(stdout).not.toContain('DNAT');
  });

  it('left the DHCP default route untouched', async () => {
    const { stdout } = await guestCapture(target, 'ip -4 route show default');
    // Still DHCP's route — the guarded `ip route replace` must not have fired.
    expect(stdout).toContain('proto dhcp');
  });

  it('configured NODE_EXTRA_CA_CERTS for login shells', async () => {
    const { stdout } = await guestCapture(target, `bash -lc 'echo $NODE_EXTRA_CA_CERTS'`);
    expect(stdout).toContain('susentorno-proxy-certificate-authority.crt');
  });
});

describe('transition to the isolated phase', () => {
  it('re-points the live automount at the internal-switch host IP', async () => {
    await isolateVmToSwitch({ exec, vmName: guest.vmName }, internalSwitchName);
    const address = await waitForIsolatedAddress(guest.vmName);
    guest = { ...guest, address };
    target = { address, username: GUEST_USERNAME };

    // The prize. The fstab entry uses x-systemd.automount, so after isolation
    // the OLD autofs mount is still live at this path pointing at a
    // now-unreachable Default-Switch host IP — and merely stat'ing it (which
    // `mkdir -p` does) trips ENODEV. mountShare's check-and-unmount runs before
    // anything touches the path; this is the first time that unwind has ever run
    // against a real CIFS client rather than a fake RemoteExec.
    await mountShare(createHarnessRemoteExec(target), {
      shareName: share.shareName,
      accountName: share.account,
      password: share.password,
      hostIp: internalHostIp,
      onStep: (message) => console.log(`phases: re-mountShare — ${message}`),
    });

    const { stdout } = await guestCapture(target, `findmnt -no SOURCE /mnt/${share.shareName}`);
    expect(stdout.trim()).toBe(`//${internalHostIp}/${share.shareName}`);
  }, 900_000);

  it('takes its default route from the real DHCP server, not a guest-side unit', async () => {
    const { stdout } = await guestCapture(target, 'ip -4 route show default');
    expect(stdout).toContain(`default via ${internalHostIp}`);
    // The route ARRIVES via DHCP option 3. run-hosting's own DHCP server is what
    // supplies it — this is the first automated coverage of ADR-0014's host-side
    // DHCP against a real guest.
    expect(stdout).toContain('proto dhcp');
  });

  it('takes the host as its resolver from the real DNS responder', async () => {
    const { stdout } = await guestCapture(target, 'getent ahostsv4 example.com');
    expect(stdout.trim().split(/\s+/)[0]).toBe(internalHostIp);
  });

  it('terminated :443 host: CA trusted, unexpected auth passes through, placeholder injected', async () => {
    // Any response arriving at all proves the TLS handshake succeeded, i.e. the
    // pre-script installed and trusted the proxy CA. api.anthropic.com is
    // redirected to the stack's mock upstream, which returns 200 for every
    // request and records the Authorization header it received — and the traffic
    // now travels through the REAL gateway forwarder (ADR-0011), not a socat
    // stand-in.
    const beforeWrong = stack.mockUpstream.receivedAuthorizationHeaders.length;
    const wrongAuth = await guestCapture(
      target,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/`,
    );
    expect(wrongAuth.stdout.trim()).toBe('200');
    expect(stack.mockUpstream.receivedAuthorizationHeaders.slice(beforeWrong)).toEqual([
      'Bearer not-the-placeholder',
    ]);

    const beforePlaceholder = stack.mockUpstream.receivedAuthorizationHeaders.length;
    const withAuth = await guestCapture(
      target,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: ${PLACEHOLDER_AUTH}' https://api.anthropic.com/`,
    );
    expect(withAuth.stdout.trim()).toBe('200');
    expect(stack.mockUpstream.receivedAuthorizationHeaders.slice(beforePlaceholder)).toEqual([
      REAL_AUTH,
    ]);
  });

  it('passthrough :443 host works end-to-end', async () => {
    // HEAD, not GET: pypi.org/simple/ is a ~44 MB index whose full download can
    // exceed the timeout. A HEAD proves the passthrough TLS handshake to the real
    // pypi.org succeeds without transferring the body.
    const { stdout } = await guestCapture(
      target,
      `curl -sI -o /dev/null -w '%{http_code}' --max-time 30 https://pypi.org/simple/`,
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('allow-listed :80 host works', async () => {
    const { stdout } = await guestCapture(
      target,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/`,
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('non-allow-listed :443 connection is dropped', async () => {
    const { stdout } = await guestCapture(
      target,
      `curl -s -o /dev/null --max-time 20 https://blocked.example.com/ ; echo exit=$?`,
    );
    expect(stdout).toContain('exit=');
    expect(stdout.trim()).not.toBe('exit=0');
  });

  it('non-allow-listed :80 gets the default-deny 403', async () => {
    const { stdout } = await guestCapture(
      target,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://blocked.example.com/`,
    );
    expect(stdout.trim()).toBe('403');
  });
});
```

- [ ] **Step 5: Delete the WSL harness**

```bash
git rm -r tests/guest/harness tests/guest/wsl.ts tests/guest/guest.test.ts tests/host-network/goldenImageBuild.test.ts
```

That removes `build-image.sh`, `cleanup.sh`, `forward.sh`, `guest.sh`, `lib.sh`, `net.sh`, `preflight.sh`, `setup-wsl.sh`, `share.sh`, and `seed/{user-data,meta-data}` — roughly 430 lines of shell plus the cloud-init seed. `tests/host-network/goldenImageBuild.test.ts` goes with them: it was Task 9's scaffolding, and `globalSetup` now calls `ensureGoldenImage` for real.

- [ ] **Step 6: Run the tier**

Run (elevated, Docker up, `run-hosting` stopped, `ssh-agent` running):

```
pnpm build && pnpm vitest run --config vitest.guest.config.ts
```

Expected: PASS, 17 tests. Roughly 10–15 minutes on a warm golden image.

Diagnosis, in the order failures are likely:

| Failure | Where to look |
| --- | --- |
| `checkGatewayPortsFree` throws | Exactly as designed — stop whatever holds `:80`/`:443` |
| The guest never reaches `:22` | `test-results/guest/<ts>/phases/serial.log` is the entire diagnostic, which is why the thrown error names it |
| `mountShare` fails at 'install cifs-utils' | The setup-phase guest has no internet: ICS on the Default Switch. The `beforeAll` guard should have caught this first — if it did not, widen the guard |
| `mountShare` fails at 'mount share' with a permission error | The NTFS ACE, not the credential. Re-check Task 10's `icacls` grant against `Get-Acl` |
| The isolated re-mount fails at 'create mount point' with ENODEV | The stale-autofs unwind did not run before `mkdir -p` — this is the exact regression the test exists for, so investigate `mountShare.ts:76-95` rather than the test |
| Isolated `curl` returns 000 for everything | `run-hosting`'s gateway is not reachable on the adapter. Check the Windows Firewall "allow node.exe on public networks?" `Query User{…}` rule described in `setup-guest.md:198` |

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit
git add tests/guest/diagnostics.ts tests/guest/globalSetup.ts tests/guest/phases.test.ts vitest.guest.config.ts
git commit -m "test: run the guest tier against real Hyper-V, retiring the WSL2/QEMU harness

The tier now boots an Ubuntu guest from a differencing disk off its own golden
image, on a real Internal switch, served by the real run-hosting — so the
gateway forwarder, the DNS responder, and the DHCP server get their first
automated coverage. dnsmasq and socat are gone; only gh is still substituted."
```

---

## Task 14: `e2e.test.ts` — the real `setup-guest-unix` against a bare Ubuntu

**Files:**

- Create: `tests/guest/e2e.test.ts`

**Interfaces:**

- Consumes: everything `phases.test.ts` consumes, plus `trustGuestHostKey`/`untrustGuestHostKey` from `tests/guest/knownHosts`, `reconcileVmToSwitch` from `src/guestSetup/vmReconcile`, `GITHUB_PLACEHOLDER_PAT` from `src/githubPlaceholder`, and `envParent`/`repoRoot` from `tests/testEnvRoot`.
- Produces: nothing consumed by later tasks.

This is the file spec 1 was built for: every answer flag in one call, with the SMB password piped into stdin — the mechanism [ADR-0022](../../adr/0022-promptmasked-releases-stdin-explicitly.md) exists to guarantee. It runs the **real, untrimmed** script set: real `apt upgrade`, real pnpm, real Codex/Claude/Pi installers, real `runPostScripts`.

**One substitution, and only one: `gh`.** `post-scripts/01-auth-config.sh` hard-exits without `github-config.txt` (`:10-13`) and then runs `gh auth login --with-token` against real GitHub (`:25`); no clean-machine test can supply a valid GitHub token. `/usr/local/bin` precedes `/usr/bin`, so the stub shadows the real `gh` that `01-apt-packages.sh:6` installs. Pointing `api.github.com` at `mockUpstream` was considered and rejected: `gh auth login` validates a token by parsing `/user` and reading `X-Oauth-Scopes`, so the mock would have to imitate a real API and would break whenever a third-party CLI's internals change.

**Deviation 5, recorded here: the guest's two DHCP addresses are pre-warmed before the command runs.** The e2e path is the only one that uses production's `createSshRemoteExec` — bare `ssh`, `StrictHostKeyChecking=ask` — and it SSHes to two DHCP-assigned addresses: the Default-Switch one during the setup phase, and the Internal-switch one after isolation. Neither is knowable before the command discovers it, so neither can be trusted in advance without booting the guest on both switches first. The pre-warm is one extra reboot cycle, and it is deterministic because both DHCP servers key leases by MAC and the VM's MAC does not change when its adapter is reassigned. The alternative — a subnet wildcard in `known_hosts` — is exactly what the design rejects.

- [ ] **Step 1: Write `tests/guest/e2e.test.ts`**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { DEFAULT_NAT_ADAPTER, resolveInternalSwitchNetwork } from '../../src/runHosting/forwarder';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { getVmIpAddresses } from '../../src/guestSetup/hyperVQueries';
import { waitForReachable } from '../../src/guestSetup/reachabilityWait';
import { realTcpConnect } from '../../src/guestSetup/tcpConnect';
import { isolateVmToSwitch, reconcileVmToSwitch } from '../../src/guestSetup/vmReconcile';
import { GITHUB_PLACEHOLDER_PAT } from '../../src/githubPlaceholder';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { envParent, envRoot, repoRoot } from '../testEnvRoot';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { guestCapture } from './guestExec';
import { GUEST_USERNAME } from './autoinstall';
import { ensureHarnessKeys } from './harnessKeys';
import { trustGuestHostKey, untrustGuestHostKey } from './knownHosts';
import { ISOLATION_NAME, roleVmName } from './hyperv/imageCache';
import {
  createTestGuest,
  destroyTestGuest,
  filterCandidateAddresses,
  type ExpectedNetwork,
  type TestGuest,
} from './hyperv/testGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';

const exec = createRealPowerShellExec();
const cliPath = join(repoRoot, 'dist', 'cli.js');
const sharePath = join(envRoot, 'vm-shared-linux');
const vmName = roleVmName('e2e');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

let stack: ProxyStack;
let share: TestShare;
let guest: TestGuest;
let setupAddress: string;
let isolatedAddress: string;
let target: SshTarget;

const trusted: string[] = [];

/** Wait for the guest's address on whichever network it is currently attached to, then trust it. */
async function discoverAndTrust(expected: ExpectedNetwork, hostPublicKey: string): Promise<string> {
  const reachability = await waitForReachable({
    getCandidates: async () => filterCandidateAddresses(await getVmIpAddresses(exec, vmName), expected),
    connect: realTcpConnect,
    timeoutMs: 600_000,
    onProgress: (ms) => console.log(`e2e: waiting for the guest... (${Math.round(ms / 1000)}s)`),
  });
  if (!reachability.reachable) {
    throw new Error(
      `e2e: '${vmName}' never became reachable in ${expected.address}/${expected.netmask}. ` +
        `Boot log: ${join(artifactsDir, 'e2e', 'serial.log')}`,
    );
  }
  // Exact IP, the key we generated — trust by construction, not on first use.
  // Production's ssh runs with StrictHostKeyChecking=ask and the e2e run's stdin
  // carries only the SMB password (which promptMasked consumes), so a missing
  // entry means an unanswerable authenticity prompt and a stale one means a hard
  // REMOTE HOST IDENTIFICATION HAS CHANGED.
  await trustGuestHostKey(reachability.address, hostPublicKey);
  trusted.push(reachability.address);
  return reachability.address;
}

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  share = await createTestShare(exec, sharePath);

  const natNetwork = resolveInternalSwitchNetwork(DEFAULT_NAT_ADAPTER);
  if (!natNetwork) throw new Error(`e2e: '${DEFAULT_NAT_ADAPTER}' has no IPv4 address`);
  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`e2e: ${internal.adapterAlias} has no IPv4 address`);

  const keys = await ensureHarnessKeys();

  // github-config.txt is staged on the HOST side, straight into the share
  // directory — the guest mounts it read-only, and the old harness's dance of
  // writing it from inside WSL is gone with WSL. The token is the placeholder
  // PAT the proxy swaps on the wire, so it is safe to write here.
  writeFileSync(
    join(sharePath, 'github-config.txt'),
    [
      'GITHUB_USERNAME="susentorno-test-user"',
      'GITHUB_EMAIL="susentorno-test@example.com"',
      `GITHUB_TOKEN="${GITHUB_PLACEHOLDER_PAT}"`,
      '',
    ].join('\n'),
  );

  guest = await createTestGuest(exec, 'e2e', 'Default Switch', natNetwork, artifactsDir);
  setupAddress = guest.address;
  await trustGuestHostKey(setupAddress, keys.guestHostPublicKey);
  trusted.push(setupAddress);
  target = { address: setupAddress, username: GUEST_USERNAME };

  // The three stubs, staged while the guest still has general network access.
  //
  // gh: 01-auth-config.sh runs `gh auth login --with-token` against real GitHub.
  // firefox + a pre-seeded policies.json: nn-configure-network.sh's firefox
  // branch only fires when firefox is present, and the merge-preserving-other-keys
  // assertion needs an existing file to merge into.
  const stage = [
    `printf '#!/bin/sh\\nexit 0\\n' | sudo tee /usr/local/bin/gh >/dev/null`,
    `sudo chmod +x /usr/local/bin/gh`,
    `printf '#!/bin/sh\\n' | sudo tee /usr/local/bin/firefox >/dev/null`,
    `sudo chmod +x /usr/local/bin/firefox`,
    `sudo mkdir -p /etc/firefox/policies`,
    `printf '%s' '{"policies":{"SomeOther":true,"Certificates":{"Install":["/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt"]}}}' | sudo tee /etc/firefox/policies/policies.json >/dev/null`,
  ].join(' && ');
  const staged = await guestCapture(target, stage);
  expect(staged.exitCode, staged.stdout).toBe(0);

  // Pre-warm the isolated lease so its exact address can be trusted BEFORE the
  // command runs — production's bare `ssh` reaches it and there is nobody to
  // answer an authenticity prompt. Deterministic because both DHCP servers key
  // leases by MAC, and reassigning the adapter does not change the MAC.
  await isolateVmToSwitch({ exec, vmName }, internalSwitchName);
  isolatedAddress = await discoverAndTrust(internal, keys.guestHostPublicKey);
  await reconcileVmToSwitch({ exec, vmName }, 'Default Switch');
  setupAddress = await discoverAndTrust(natNetwork, keys.guestHostPublicKey);
  target = { address: setupAddress, username: GUEST_USERNAME };

  // Every spec-1 flag in one call. `vmtest` is the guest username the autoinstall
  // identity created; `susentorno-test` is the Windows share account. The
  // password is never a flag, never a file, never an environment variable —
  // automation pipes one line into stdin (ADR-0022).
  const result = await execa(
    'node',
    [
      cliPath,
      'setup-guest-unix',
      '--isolation-name',
      ISOLATION_NAME,
      '--vm-name',
      vmName,
      '--guest-address',
      setupAddress,
      '--guest-username',
      GUEST_USERNAME,
      '--share-name',
      share.shareName,
      '--share-account',
      share.account,
    ],
    { cwd: envParent, input: `${share.password}\n`, reject: false, all: true },
  );
  console.log(`setup-guest-unix|\n${result.all ?? ''}`);
  expect(result.exitCode, 'setup-guest-unix must succeed end to end').toBe(0);

  // The command isolated the guest; assertions run against the isolated address
  // the pre-warm already trusted.
  target = { address: isolatedAddress, username: GUEST_USERNAME };
}, 3_600_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'e2e').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  for (const address of trusted) await untrustGuestHostKey(address).catch(() => {});
  if (share) await removeTestShare(exec, sharePath).catch(() => {});
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('setup-guest-unix end to end on a bare Ubuntu guest', () => {
  it('re-mounted the share against the internal-switch host IP', async () => {
    const internal = resolveIsolationNetwork(ISOLATION_NAME);
    expect(internal.found).toBe(true);
    const { stdout } = await guestCapture(target, `findmnt -no SOURCE /mnt/${share.shareName}`);
    expect(stdout.trim()).toBe(
      `//${internal.found ? internal.address : ''}/${share.shareName}`,
    );
  });

  it('really installed the toolchain the golden image deliberately omits', async () => {
    // The whole point of leaving node, pnpm, and cifs-utils out of the image:
    // this proves the pre-scripts bootstrap a bare Ubuntu rather than dressing
    // up one that was already dressed.
    const { stdout } = await guestCapture(
      target,
      `bash -lc 'command -v node >/dev/null && echo node-ok; command -v pnpm >/dev/null && echo pnpm-ok; dpkg -s cifs-utils >/dev/null 2>&1 && echo cifs-ok'`,
    );
    expect(stdout).toContain('node-ok');
    expect(stdout).toContain('pnpm-ok');
    expect(stdout).toContain('cifs-ok');
  });

  it('01-auth-config symlinked the placeholder claude credential into place', async () => {
    const link = await guestCapture(target, 'readlink "$HOME/.claude/.credentials.json"');
    expect(link.stdout.trim()).toBe(`/mnt/${share.shareName}/credentials.json`);
    const body = await guestCapture(target, 'cat "$HOME/.claude/.credentials.json"');
    expect(body.stdout).toContain('sk-ant-oat-susentorno-PLACEHOLDER');
  });

  it('01-auth-config symlinked the placeholder codex credential into place', async () => {
    const link = await guestCapture(target, 'readlink "$HOME/.codex/auth.json"');
    expect(link.stdout.trim()).toBe(`/mnt/${share.shareName}/auth.json`);
  });

  it('01-auth-config set the git identity from github-config.txt', async () => {
    const name = await guestCapture(target, 'git config --global user.name');
    const email = await guestCapture(target, 'git config --global user.email');
    expect(name.stdout.trim()).toBe('susentorno-test-user');
    expect(email.stdout.trim()).toBe('susentorno-test@example.com');
  });

  it('the home settings transform set hasCompletedOnboarding', async () => {
    const { stdout } = await guestCapture(
      target,
      `python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['hasCompletedOnboarding'])"`,
    );
    expect(stdout.trim()).toBe('True');
  });

  it('the home settings transform merges into an existing ~/.claude.json without clobbering', async () => {
    // Re-run the applier against a pre-seeded file: the fresh-file case is
    // covered above by the real run, and this is the merge case it cannot reach.
    const rerun = await guestCapture(
      target,
      `printf '%s' '{"someExisting": 123}' > "$HOME/.claude.json" && bash /mnt/${share.shareName}/post-scripts/02-apply-home-jq-transforms.sh`,
    );
    expect(rerun.exitCode, rerun.stdout).toBe(0);
    const { stdout } = await guestCapture(
      target,
      `python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));print(d['hasCompletedOnboarding'], d['someExisting'])"`,
    );
    expect(stdout.trim()).toBe('True 123');
  });

  it('configure-network merged the CA into the existing firefox policies.json, preserving other keys', async () => {
    // This assertion lives here, not in phases: nn-configure-network.sh:49,51
    // shells out to jq, which 01-apt-packages.sh:6 installs — so it belongs with
    // the other tests that depend on a pre-script's output.
    const { stdout } = await guestCapture(
      target,
      `python3 -c "import json;d=json.load(open('/etc/firefox/policies/policies.json'));i=d['policies']['Certificates']['Install'];print(d['policies']['SomeOther'], '/etc/firefox/policies/susentorno-proxy-certificate-authority.pem' in i, '/usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt' in i)"`,
    );
    expect(stdout.trim()).toBe('True True False');
  });

  it('ensureKvpDaemon still succeeds against an already-installed package', async () => {
    // The fidelity cost of baking linux-cloud-tools-virtual into the image: this
    // hits the already-installed path. Small, since the contract is "guarantee it
    // is installed" — and it still runs, and still must succeed, which is what a
    // green setup-guest-unix above already proves. Assert the end state directly.
    const { stdout } = await guestCapture(target, 'systemctl is-active hv-kvp-daemon.service');
    expect(stdout.trim()).toBe('active');
  });
});
```

- [ ] **Step 2: Run the file**

Run (elevated, Docker up, `ssh-agent` running):

```
pnpm build && pnpm vitest run --config vitest.guest.config.ts tests/guest/e2e.test.ts
```

Expected: PASS, 9 tests. 15–25 minutes — the real `apt upgrade`, pnpm, and three agent installers dominate.

Diagnosis:

| Failure | Cause |
| --- | --- |
| `setup-guest-unix` hangs with no output after "reconciling" | An unanswered SSH authenticity prompt: the pre-warm did not trust the address the command actually used. Check `ssh-keygen -F <address>` for both addresses |
| `Permission denied (publickey)` from the command | The agent probe passed but `ssh` is not using the agent — most likely an `IdentitiesOnly yes` block in `~/.ssh/config` covering the test subnet (risk 6). Comment it out and re-run |
| `01-apt-packages.sh` fails on `apt update` | The guest is isolated but the proxy is not reaching `archive.ubuntu.com`, or `apt` ran before isolation with no ICS. Check `test-results/guest/<ts>/e2e/network.txt` |
| `gh auth login` reaches the network | The stub is not shadowing — confirm `/usr/local/bin` precedes `/usr/bin` on the guest's `PATH` under `bash -ic` |
| dpkg lock errors during the real `apt` | `apt-daily`/`unattended-upgrades` are not masked in the image. Genuine lock-contention recovery is covered nowhere and the product does not attempt it — the image AVOIDS the race, so this is an image bug, not a test flake |

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/guest/e2e.test.ts
git commit -m "test: drive the real setup-guest-unix end to end against a Hyper-V guest"
```

---

## Task 15: `fresh.test.ts` — a guest that has never left the isolated network

**Files:**

- Create: `tests/guest/fresh.test.ts`

**Interfaces:**

- Consumes: the same set `phases.test.ts` uses. No new modules.
- Produces: nothing.

`fresh` is created **directly on the Internal switch** and asserts, *before anything runs*, that DHCP alone configured it. It must never have touched the Default Switch, which is why `phases` structurally cannot prove this.

Unlike the old harness's guest it has no share already mounted by fstab, and `cifs-utils` is deliberately absent from the golden image — so `fresh` calls `mountShare` itself with the internal-switch host IP. That is a happy accident rather than a cost: it makes `fresh` the one place `mountShare`'s `apt-get install -y cifs-utils` runs **in the isolated phase**, proving `apt` works through the proxy on a guest that has never had general network access. `archive.ubuntu.com:80` is allow-listed in the tier's policy fixture (`tests/proxy-stack/fixtures/allow-list.txt:2`), so this exercises the `ALLOW HTTP` path end to end.

- [ ] **Step 1: Write `tests/guest/fresh.test.ts`**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { listScripts } from '../../src/guestSetup/listScripts';
import { mountShare } from '../../src/guestSetup/mountShare';
import { runPreScripts } from '../../src/guestSetup/runPreScripts';
import type { SshTarget } from '../../src/guestSetup/remoteExec';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { envRoot } from '../testEnvRoot';
import { artifactsDir, collectDiagnostics } from './diagnostics';
import { createHarnessRemoteExec, guestCapture } from './guestExec';
import { GUEST_USERNAME } from './autoinstall';
import { ISOLATION_NAME } from './hyperv/imageCache';
import { createTestGuest, destroyTestGuest, type TestGuest } from './hyperv/testGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';

const exec = createRealPowerShellExec();
const sharePath = join(envRoot, 'vm-shared-linux');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);

let stack: ProxyStack;
let share: TestShare;
let guest: TestGuest;
let target: SshTarget;
let internalHostIp: string;

beforeAll(async () => {
  stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
  share = await createTestShare(exec, sharePath);

  const internal = resolveIsolationNetwork(ISOLATION_NAME);
  if (!internal.found) throw new Error(`fresh: ${internal.adapterAlias} has no IPv4 address`);
  internalHostIp = internal.address;

  // Created ON the Internal switch. This guest has never had a Default-Switch
  // lease, never had general network access, and never run a single script —
  // which is exactly what makes the assertions below mean something.
  guest = await createTestGuest(exec, 'fresh', internalSwitchName, internal, artifactsDir);
  target = { address: guest.address, username: GUEST_USERNAME };
}, 1_800_000);

afterAll(async () => {
  if (guest) {
    await collectDiagnostics(target, 'fresh').catch(() => {});
    await destroyTestGuest(exec, guest).catch(() => {});
  }
  if (share) await removeTestShare(exec, sharePath).catch(() => {});
  if (stack) await stopProxyStack(stack).catch(() => {});
}, 600_000);

describe('a fresh guest starting in the isolated phase', () => {
  // The whole network configuration must be present BEFORE anything runs. That
  // is the design claim: a guest needs nothing but a DHCP lease. Reaching :22 at
  // all (createTestGuest waited for it) already proves addressing works — these
  // add the router and the resolver.
  it('took its default route from the DHCP lease alone', async () => {
    const { stdout } = await guestCapture(target, 'ip -4 route show default');
    expect(stdout).toContain(`default via ${internalHostIp}`);
    expect(stdout).toContain('proto dhcp');
  });

  it('took the host as its resolver from the DHCP lease alone', async () => {
    const { stdout } = await guestCapture(target, 'getent ahostsv4 example.com');
    expect(stdout.trim().split(/\s+/)[0]).toBe(internalHostIp);
  });

  it('has no in-guest DNS or DHCP unit doing any of it', async () => {
    const { stdout } = await guestCapture(
      target,
      'systemctl is-enabled systemd-networkd || true; systemctl is-active NetworkManager',
    );
    expect(stdout).toContain('masked');
    expect(stdout).toContain('active');
  });

  it('installs cifs-utils through the proxy — apt works with no general network access', async () => {
    // The one place mountShare's `apt-get install -y cifs-utils` runs in the
    // ISOLATED phase, on a guest that has never been un-isolated. It reaches
    // archive.ubuntu.com:80, which the policy fixture allow-lists, so this is the
    // ALLOW HTTP path end to end through the real gateway forwarder.
    const before = await guestCapture(target, 'dpkg -s cifs-utils >/dev/null 2>&1 && echo installed');
    expect(before.stdout).not.toContain('installed');

    await mountShare(createHarnessRemoteExec(target), {
      shareName: share.shareName,
      accountName: share.account,
      password: share.password,
      hostIp: internalHostIp,
      onStep: (message) => console.log(`fresh: mountShare — ${message}`),
    });

    const after = await guestCapture(target, 'dpkg -s cifs-utils >/dev/null 2>&1 && echo installed');
    expect(after.stdout).toContain('installed');
    const mounted = await guestCapture(target, `findmnt -no SOURCE /mnt/${share.shareName}`);
    expect(mounted.stdout.trim()).toBe(`//${internalHostIp}/${share.shareName}`);
  }, 900_000);

  it('configure-network leaves the DHCP-supplied networking untouched', async () => {
    const scripts = listScripts(join(sharePath, 'pre-scripts')).filter(
      (s) => s.slug === 'configure-network',
    );
    expect(scripts).toHaveLength(1);
    await runPreScripts(createHarnessRemoteExec(target), {
      scripts,
      shareName: share.shareName,
      internalSwitchHostIp: internalHostIp,
    });

    // Same DHCP route, no DNAT layer reintroduced, host still the resolver.
    const route = await guestCapture(target, 'ip -4 route show default');
    expect(route.stdout).toContain(`default via ${internalHostIp}`);
    expect(route.stdout).toContain('proto dhcp');

    const nat = await guestCapture(target, 'sudo iptables -t nat -S OUTPUT');
    expect(nat.stdout).not.toContain('DNAT');

    const dns = await guestCapture(target, 'getent ahostsv4 example.com');
    expect(dns.stdout.trim().split(/\s+/)[0]).toBe(internalHostIp);
  }, 900_000);
});
```

- [ ] **Step 2: Run the file**

Run: `pnpm build && pnpm vitest run --config vitest.guest.config.ts tests/guest/fresh.test.ts`
Expected: PASS, 5 tests.

If the guest never reaches `:22`, `run-hosting`'s DHCP server did not answer. Check `test-results/guest/<ts>/fresh/serial.log` for `NetworkManager` retry messages, and remember the retry cadence documented in `setup-guest.md:196` — Ubuntu retries every 45s for three minutes, then goes quiet for about five. `createTestGuest`'s 600-second timeout covers one full quiet gap.

- [ ] **Step 3: Run the whole tier**

Run: `pnpm build && pnpm vitest run --config vitest.guest.config.ts`
Expected: PASS, 31 tests across three files (17 + 9 + 5), ~25–40 minutes on a warm golden image.

Confirm the sweep left nothing behind:

```powershell
Get-VM -Name 'susentorno-test-*' -ErrorAction SilentlyContinue
Get-SmbShare -Name 'susentorno-test-*' -ErrorAction SilentlyContinue
Get-LocalUser -Name 'susentorno-test' -ErrorAction SilentlyContinue
Get-VMSwitch -Name 'susentorno-test-internal' -ErrorAction SilentlyContinue
Get-ChildItem .\.image-cache
```

Expected: the first four produce nothing, and `.image-cache/` holds only the ISO, `susentorno-test-golden.vhdx`, its `.stamp`, `golden-build-serial.log`, `harness-known-hosts`, and the two keypairs.

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add tests/guest/fresh.test.ts
git commit -m "test: a guest configured by DHCP alone, installing packages through the proxy"
```

---

## Task 16: The share account is renamed

**Files:**

- Modify: `src/guestSetup/setupAnswers.ts:24`
- Modify: `src/commands/setupGuestUnix.ts:118`
- Modify: `tests/unit/guestSetup/setupAnswers.test.ts:59`
- Modify: `setup-environment.md:5,25-26,29,31,41-42,51,53`
- Modify: `setup-guest.md:117,162,191`

**Interfaces:**

- Consumes: nothing new.
- Produces: `DEFAULT_SHARE_ACCOUNT === 'susentorno'`.

The share account becomes **`susentorno`** by default and **`susentorno-<isolation-name>`** when an isolation name is in play — so this tier uses `susentorno-test`. The account name then says which susentorno installation it belongs to, which matters exactly because a sandboxed installation and a real one can share a machine: the same reason the isolation name exists at all.

This is a **breaking change to shipped behaviour**, accepted deliberately: only one environment is currently deployed, and it will be recreated in full rather than migrated. There is no compatibility shim — consistent with how this project already treats `allowlist.txt` in [ADR-0021](../../adr/0021-split-allow-auth-block-lists-and-skip-allow-list.md), which was abandoned outright rather than auto-migrated.

**Two traps, both of which look like the rename and are not:**

1. **`tests/unit/guestSetup/mountShare.test.ts`'s eleven occurrences must NOT change.** Every one passes `accountName` explicitly as an arbitrary fixture value, so they test `mountShare`, not the default. Rewriting them would be churn that obscures the real change. Spec 1 hit the same distinction with `listScripts.test.ts` and `runPreScripts.test.ts` during the renumbering and called it out for the same reason.
2. **`/etc/susentorno-share.cred` is a file path, not an account name.** It appears in `src/guestSetup/mountShare.ts:66`, `src/guestSetup/fstabLine.ts:33`, `tests/unit/guestSetup/fstabLine.test.ts:13`, `tests/unit/guestSetup/mountShare.test.ts:44,113,114`, and `setup-guest.md:161,163,165,172`. None of them change. Renaming it would be a second, unrelated breaking change smuggled in under this one.

Verify both before committing with `git diff --stat` — only the five files listed above may appear.

- [ ] **Step 1: Change the failing assertion first**

In `tests/unit/guestSetup/setupAnswers.test.ts`, replace line 59:

```typescript
      accountName: 'susentorno',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/setupAnswers.test.ts`
Expected: FAIL — `expected 'susentorno-share' to be 'susentorno'`.

- [ ] **Step 3: Change the default**

`src/guestSetup/setupAnswers.ts:24`:

```typescript
export const DEFAULT_SHARE_ACCOUNT = 'susentorno';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS. In particular `tests/unit/guestSetup/mountShare.test.ts` must still pass **untouched** — if it fails, something read the default that should have taken the parameter.

- [ ] **Step 5: Fix the help text that names the old default in prose**

`src/commands/setupGuestUnix.ts:118`:

```typescript
      'Share account name, skipping its prompt (prompt default: susentorno)',
```

- [ ] **Step 6: Update `setup-environment.md`**

Line 5 — replace `susentorno-share` in the defaults list:

```
If you run more than one environment on this machine, give each one distinct share and share-account names in the steps below — the defaults used here (`vm-shared-linux`, `vm-shared-windows`, `susentorno`) collide if reused across environments. You don't need to redo this setup each time you switch which environment you're actively using, but you do need to keep track of which share name belongs to which environment.
```

Lines 25-26 — the snippet users copy verbatim:

```powershell
$pw = Read-Host -AsSecureString "Password for susentorno"
New-LocalUser -Name "susentorno" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
```

Line 29 (the `secpol.msc` step), line 31 (the Computer Management step), lines 41-42 (`New-SmbShare -ReadAccess`), and lines 51 and 53 (the two paragraphs of security rationale): replace every `susentorno-share` with `susentorno`.

Then add a sentence after line 26's code block, because the isolation name now reaches something a real user creates by hand:

```
If you run this installation under an isolation name — `susentorno create-host-network --isolation-name <name>` — name the account `susentorno-<name>` instead, and pass it to `setup-guest-unix --share-account`. Windows caps a local account name at 20 characters, so an isolation name has about nine to work with.
```

- [ ] **Step 7: Update `setup-guest.md`**

Line 117:

```
It prompts for the Hyper-V VM name, the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno`), and the share password from setup-environment.md.
```

Line 162 — the `.cred` file's `username=` line (the **value**, not the path):

```
username=susentorno
```

Line 191:

```powershell
cmdkey /add:192.168.67.1 /user:susentorno /pass:<the password from setup-environment.md>
```

- [ ] **Step 8: Confirm nothing else moved, then commit**

```bash
grep -rn "susentorno-share" --include="*.ts" --include="*.md" . | grep -v node_modules | grep -v "docs/honist-v"
```

Expected: only `/etc/susentorno-share.cred` path occurrences and `susentorno-share-cred-` temp-file prefixes. Any bare account-name occurrence outside `docs/honist-v/` is a miss.

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli
git add src/guestSetup/setupAnswers.ts src/commands/setupGuestUnix.ts tests/unit/guestSetup/setupAnswers.test.ts setup-environment.md setup-guest.md
git commit -m "feat!: name the share account after its susentorno installation

DEFAULT_SHARE_ACCOUNT becomes 'susentorno', and an isolation name makes it
'susentorno-<name>'. Breaking, with no migration: the one deployed environment
is recreated rather than migrated, matching how allowlist.txt was handled."
```

---

## Task 17: Records, the domain model, and the docs

**Files:**

- Create: `docs/adr/0025-guest-layer-tested-against-real-hyperv.md`
- Modify: `docs/adr/0010-vm-tests-via-qemu-in-wsl2.md` (superseded)
- Modify: `docs/adr/0011-loopback-publish-with-node-forwarder.md`, `docs/adr/0014-host-side-dns-and-dhcp.md`, `docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md` (consequences)
- Modify: `CONTEXT.md:43`
- Modify: `testing.md:13,21,25,52,54,56,77,81`
- Modify: `development.md:7-25,41`

**Interfaces:**

- Consumes: nothing.
- Produces: the records that explain, afterwards, what Tasks 1–16 did and why.

The ADR and the CONTEXT.md amendment are the domain-model half of this changeset: the plan guides the implementation, the ADR explains it afterwards, and CONTEXT.md keeps the vocabulary coherent while both are being read.

- [ ] **Step 1: Write ADR-0025**

Create `docs/adr/0025-guest-layer-tested-against-real-hyperv.md`:

```markdown
# The guest layer is tested against real Hyper-V VMs

The guest tier boots real Hyper-V virtual machines on a real Internal switch, served by the real `run-hosting`, and asserts from inside them. It replaces the QEMU-in-WSL2 harness [[vm-tests-via-qemu-in-wsl2]] established, which supplied its own `dnsmasq` and `socat` in place of the production DNS responder, DHCP server, and gateway forwarder. Substitutions go from three to one: the only thing still faked is `gh`, shadowed at `/usr/local/bin/gh` so `post-scripts/01-auth-config.sh` does not need a real GitHub token.

The claim the tier makes afterwards: **a real Ubuntu guest, on a real Hyper-V Internal switch, served by the real `run-hosting`, reaches exactly the destinations the network policy permits and nothing else.**

The tier is bootstrappable from clean — no manual prerequisite beyond an elevated shell, Hyper-V, Docker, and a running `ssh-agent`. It builds its own golden image from `ubuntu-26.04-live-server-amd64.iso` driven by an unattended autoinstall, its own host network via `create-host-network --isolation-name test`, and its own SMB share and Windows local account. Three per-test guests boot from differencing disks off that one golden parent, so no test can see another's writes. Everything the tier touches on the host derives from one isolation name, and is swept by name at both startup and teardown regardless of which run created it.

Fidelity over portability is the trade. The old harness ran anywhere WSL2 and KVM did; this one runs only on a Windows host with Hyper-V, which is the only platform susentorno targets ([[hyper-v-only-target]]).

## Status

accepted (2026-08-15). Supersedes [[vm-tests-via-qemu-in-wsl2]].

## Considered Options

- **Port the harness to Hyper-V while keeping the substitutions** — drop the WSL dependency but keep `dnsmasq` and `socat`. Rejected: accepting a real-Hyper-V, elevation-requiring, host-state-touching tier without buying the fidelity means paying [[cli-owned-host-network-with-real-hyperv-tier]]'s price for none of its return.
- **A manually-built golden VM plus checkpoints.** Cheap, but it makes the suite un-bootstrappable from source — a real cost for a tier in the default pipeline.
- **Convert Ubuntu's cloud image to VHDX.** Ubuntu publishes no VHD/VHDX for 26.04, and `Convert-VHD` handles VHD↔VHDX only, so this needs `qemu-img` on Windows — a new non-Hyper-V dependency — and keeps the cloud-image-vs-installer fidelity gap that autoinstall closes.
- **Repack the ISO with a Node ISO-writing library** to get the `autoinstall` kernel parameter. Rejected as inconsistent: a new dependency existing purely for tests is the same objection that ruled out `qemu-img`. The harness extracts the ISO onto a FAT32 EFI System Partition and writes its own `boot/grub/grub.cfg` instead — the path Ubuntu supports as first-class UEFI install media, using only Windows built-ins.
- **Answer subiquity's confirmation prompt over the serial console.** Screen-scraping and keystroke-injecting a TUI is the most fragile thing available here, and it would make the diagnostics channel load-bearing for the build rather than merely diagnostic.
- **Split the tier**, with `phases` and `fresh` in the default pipeline and `e2e` opt-in, as a hedge against the e2e test's network-dependent flakiness. Rejected: it would make `setup-guest-unix`'s own wiring the one part nobody runs by default. A flaky e2e test should be made robust, not moved.
- **Keep both harnesses temporarily.** `pnpm test` would run two full guest tiers (~45 min), WSL prerequisites would stay mandatory, and the relocated assertions would exist in two places during exactly the window they are being re-dispositioned.

## Consequences

- **[[loopback-publish-with-node-forwarder]]'s forwarder and [[host-side-dns-and-dhcp]]'s DNS responder and DHCP server get their first automated coverage.** `tests/proxyStack.ts` drops `--no-forward` and passes `--isolation-name test`, which is the single edit the whole design is organised around: that one flag currently disables the gateway's non-loopback listener, the DNS responder, and the DHCP server together.
- **The gateway binds the real `127.0.0.1:80`/`:443`** during this tier, because `startGateway` opens one port pair across every address in `listenAddresses` and the guest connects on the port from the URL. `checkNoRunningProxy`'s deliberate both-ports-required tolerance becomes a defect at those ports, so the tier uses a strict variant that also fails when only one is held. `proxy-stack` keeps the lenient one — it still uses 18080/18443 and genuinely does not care about a stray `:80`.
- **Two `run-hosting` instances remain impossible**, not merely guarded: `templates/proxy/docker-compose.yml:18,25` pins fixed global container names. The isolation name sandboxes the host network and this tier's own objects, never the Envoy containers or the loopback ports.
- **The isolation name now also derives the share account**, for every installation rather than only a test one — see [[cli-owned-host-network-with-real-hyperv-tier]]'s updated consequence and `CONTEXT.md`'s amended definition. `DEFAULT_SHARE_ACCOUNT` becomes `susentorno`, a breaking change with no migration path.
- **`pnpm test`'s prerequisites change**: WSL2, nested virtualization, KVM, `.wslconfig` mirrored networking, and `ignoredPorts=67` are all dropped; a running `ssh-agent` is added. The elevated shell and Hyper-V were already required by [[cli-owned-host-network-with-real-hyperv-tier]].
- **Runtime is ~15–25 minutes steady state**, plus a one-off ~20–30 minute golden build on a cold cache. `.image-cache/` holds the ISO and the golden VHDX between runs; it is gitignored, repo-local, and safe there specifically because this project avoids git worktrees.
- **`ssh-agent` becomes load-bearing.** The e2e test runs the real `createSshRemoteExec`, which spawns bare `ssh`, so the harness key must be discoverable without editing the developer's `~/.ssh/config` or clobbering `~/.ssh/id_ed25519`. A `ssh-add` then `ssh-add -l` probe fails fast when the agent `ssh` would use cannot see the identity; a user `~/.ssh/config` with `IdentitiesOnly yes` covering the test subnet still defeats it, and nothing short of a full connection test would catch that.
- **Three assertions move to `proxy-stack`** — the allowlist-edit restart, the log-follow re-attachment, and unique-tracking reset/preserve. They drive host-side traffic and observe host-side output, which `testing.md` already places there; two of them carried 300-second timeouts on the expensive tier.
```

- [ ] **Step 2: Mark ADR-0010 superseded**

`docs/adr/0010-vm-tests-via-qemu-in-wsl2.md` has no `## Status` section. Insert one between the opening paragraph (line 3) and `## Considered Options` (line 5):

```markdown
## Status

superseded (2026-08-15) by [[guest-layer-tested-against-real-hyperv]].

The decision above is reversed outright, not qualified: Hyper-V *is* the guest tier's test runtime now. This ADR stays in the tree as the record of why QEMU-in-WSL2 was right at the time, and its residual-fidelity-gaps consequence is the list the successor closes.
```

Nothing else in the file changes. Superseding is not amending: the reasoning has to stay readable as it was.

- [ ] **Step 3: Add the consequence to ADR-0011**

Append to `docs/adr/0011-loopback-publish-with-node-forwarder.md`'s consequences:

```markdown
- The forwarder has real automated coverage as of [[guest-layer-tested-against-real-hyperv]]: the guest tier's `run-hosting` binds the Internal-switch adapter for real, and a real Ubuntu guest reaches Envoy through it. Before that, the non-loopback listener was exercised only by hand.
```

- [ ] **Step 4: Add the consequence to ADR-0014**

Append to `docs/adr/0014-host-side-dns-and-dhcp.md`'s consequences, and adjust whatever sentence there says the host-side DNS/DHCP is covered only by manual Hyper-V checkpoints:

```markdown
- "Covered only by manual Hyper-V checkpoints" no longer holds. [[guest-layer-tested-against-real-hyperv]]'s guest tier boots a real Ubuntu guest onto a real Internal switch with no configuration but a DHCP lease, and asserts that the lease supplied the router (option 3) and the resolver (option 6) — so the Windows socket-binding behaviour these servers depend on is exercised on every `pnpm test`.
```

- [ ] **Step 5: Extend ADR-0023's isolation-name consequence**

In `docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md`, append to the final bullet (line 28):

```markdown
[[guest-layer-tested-against-real-hyperv]] extends the name's reach again: it now also derives the share account (`susentorno-<name>`, for every installation rather than only a test one) and, for the test tiers, the guest VM names and the SMB share name.
```

`:15`'s mention of `setup-guest-unix-isolation-checklist.md` **stays** — it is an accurate record of a rejected option's reasoning at the time, not a live pointer.

- [ ] **Step 6: Amend the isolation-name definition in `CONTEXT.md`**

Replace `CONTEXT.md:43` in full:

```markdown
**Isolation name**: The name that selects which parallel set of susentorno host objects a command acts on — the Internal switch and its firewall rules, the share account, and, for the test tiers, the guest VMs and SMB share derived from the same name — so a sandboxed installation can coexist with the default one on the same machine. Omitting it selects the unnamed default. _Avoid_: Sandbox name, test name
```

Spec 1 wrote the narrower definition and said it would be amended here if this spec extended the term. It does, so it is. The share account is called out separately from the test-tier objects because it is derived for *any* installation, not only a test one — it is the first place the isolation name reaches something a real user creates by hand.

- [ ] **Step 7: Rewrite the guest-tier rows in `testing.md`**

Line 13 (the tier table's `guest` row) is already accurate — "Behavior observed through a disposable guest" says nothing about the mechanism, which is the point `:5` makes.

Replace line 25 in full:

```markdown
- **`guest`** tests make their observations from inside a disposable guest. They generally cross the CLI and proxy stack too, but the guest is the highest exercised surface. The harness boots real Hyper-V VMs from differencing disks off a golden image it builds itself, on a real Internal switch served by the real `run-hosting` (see [ADR-0025](docs/adr/0025-guest-layer-tested-against-real-hyperv.md)); the only substitution left is a stub `gh`. On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/guest/<timestamp>/<role>/`.
```

That deletes the dangling `setup-guest-unix-isolation-checklist.md` link: the behaviour it stood in for — VM stop/reassign/start, the elevation check, the `run-hosting` readiness check — is now automated.

Replace line 52 (the `guest` prerequisites row):

```markdown
| `guest` | An elevated (Administrator) PowerShell/terminal, Hyper-V, Docker running, and a running `ssh-agent`. Stop any live `susentorno run-hosting` process first — this tier binds the real `:80`/`:443` and manages the same Envoy containers. The first run builds a golden VM image (~20–30 minutes); later runs reuse it from `.image-cache/`. |
```

Replace line 54:

```markdown
The guest tier creates and refreshes its cached golden image automatically at `.image-cache/`; the first run takes longer. It is gitignored and repo-local, which is safe specifically because this project avoids git worktrees — its live tiers act on one shared host network adapter, so parallel checkouts could not run tests concurrently anyway.
```

In line 56, replace the final sentence:

```markdown
The guest tier also checks for an elevated shell, free gateway ports, and an `ssh-agent` that the `ssh` it will actually invoke can see, before building an image or booting anything.
```

Replace line 77:

```markdown
The `guest` tier's prerequisites (an elevated shell, Hyper-V, Docker, and `ssh-agent` — see [development.md](development.md)) are therefore required for any full `pnpm test` run, not just for working on `templates/vm-shared-linux/` directly. Guest boots, a reboot through isolation, and the e2e file's real package installs take minutes each — expect `pnpm test` to be slow.
```

In line 81, add the two new shared helpers to the list of `tests/`-root support code:

```markdown
Support code used by more than one tier lives at the root of `tests/`, including `proxyStack.ts`, `testEnvRoot.ts`, `rmEnvRoot.ts`, `checkDockerRunning.ts`, `checkNoRunningProxy.ts`, `checkElevated.ts`, `checkGatewayPortsFree.ts`, `sshAgentIdentity.ts`, and `tests/fixtures/`. Tier-specific setup and harness code stays in its tier directory, such as `tests/proxy-stack/globalSetup.ts` and `tests/guest/hyperv/`.
```

- [ ] **Step 8: Rewrite `development.md`'s prerequisites**

Replace lines 7-25 (the whole prerequisites list) with:

```markdown
- All [host prerequisites](README.md#host-prerequisites).
- An **elevated (Administrator)** terminal. The `host-network` and `guest` tiers create and delete real Hyper-V switches, firewall rules, VMs, VHDs, SMB shares, and a Windows local account.
- **Hyper-V** enabled, with a working **Default Switch** (the guest tier's golden-image build needs ICS internet through it).
- **Docker Desktop** running, for the `proxy-stack` and `guest` tiers.
- A running **`ssh-agent`**. The guest tier's end-to-end test runs the real `setup-guest-unix`, whose bare `ssh` finds the harness key through the agent — the only way to supply it without editing your `~/.ssh/config` or clobbering `~/.ssh/id_ed25519`.
  ```powershell
  Set-Service ssh-agent -StartupType Automatic
  Start-Service ssh-agent
  ```
- **~10 GB free disk**. The guest tier caches an Ubuntu ISO (2.7 GB) and a golden VM image in `.image-cache/`, and builds it on the first run (~20–30 minutes). Both are gitignored; delete the directory to force a rebuild.
- No WSL2, KVM, or nested virtualization is required. Test startup gates verify each prerequisite and name the fix for whatever is missing.
```

Replace line 41 (step 9 of the verification pipeline table):

```markdown
| 9 | `pnpm test:guest` | Guest tests (real Hyper-V VMs on a real Internal switch, served by the real `run-hosting`) |
```

- [ ] **Step 9: Check every wiki-link resolves and commit**

The ADRs use `[[slug]]` links whose slugs are the filenames without the number prefix and `.md`. Confirm the four new ones:

```bash
ls docs/adr | grep -E "guest-layer-tested-against-real-hyperv|vm-tests-via-qemu-in-wsl2|cli-owned-host-network|hyper-v-only-target"
```

Expected: `0010-vm-tests-via-qemu-in-wsl2.md`, `0015-hyper-v-only-target.md`, `0023-cli-owned-host-network-with-real-hyperv-tier.md`, `0025-guest-layer-tested-against-real-hyperv.md`.

Also confirm nothing still points at the deleted WSL setup script or the manual checklist:

```bash
grep -rn "setup-wsl.sh\|setup-guest-unix-isolation-checklist\|ignoredPorts\|networkingMode" --include="*.md" . | grep -v node_modules | grep -v "docs/honist-v" | grep -v "docs/adr/0010"
```

Expected: no output. `docs/adr/0010` is excluded on purpose — a superseded ADR keeps its original text.

```bash
pnpm format && pnpm lint && pnpm typecheck
git add docs/adr/0025-guest-layer-tested-against-real-hyperv.md docs/adr/0010-vm-tests-via-qemu-in-wsl2.md docs/adr/0011-loopback-publish-with-node-forwarder.md docs/adr/0014-host-side-dns-and-dhcp.md docs/adr/0023-cli-owned-host-network-with-real-hyperv-tier.md CONTEXT.md testing.md development.md
git commit -m "docs: record the real-Hyper-V guest tier and widen the isolation name"
```

- [ ] **Step 10: Run the whole pipeline**

Run (elevated, Docker up, `ssh-agent` running): `pnpm test`

Expected: PASS, all nine steps. This is the first full run on the new tier, and the only thing that proves the changeset is finished.

---

## Final verification checklist

Run once, after Task 17, from a clean checkout on a machine that has never run this tier:

- [ ] `git clean -ndx` shows `.image-cache/` would be removed — i.e. nothing in it is tracked.
- [ ] `pnpm test` passes from cold, including the ~20–30 minute golden build.
- [ ] `pnpm test` passes a second time, and the second run does **not** rebuild the image.
- [ ] Interrupt a run with Ctrl-C partway through `e2e.test.ts`, then re-run `pnpm test:guest`. It must recover: `sweepIsolationResidue` at startup is what makes that true.
- [ ] After a passing run, `Get-VM -Name 'susentorno-test-*'`, `Get-SmbShare -Name 'susentorno-test-*'`, `Get-LocalUser -Name 'susentorno-test'`, and `Get-VMSwitch -Name 'susentorno-test-internal'` all return nothing.
- [ ] `ssh-add -l` no longer lists the harness key.
- [ ] `ssh-keygen -F <the addresses the run used>` finds nothing in `~/.ssh/known_hosts`, and any entries for your own machines and other VMs are untouched.
- [ ] A developer's real `susentorno-internal` switch, if present, is untouched.



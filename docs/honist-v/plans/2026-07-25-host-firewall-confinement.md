# Host Firewall Confinement Implementation Plan

**Goal:** Confine the guest's inbound reach to the Internal-switch host address independently of Windows' host model, and replace the discovered shared `node.exe` firewall grant with one scoped to a dedicated, port-limited copy — closing both gaps `verify-proxy.ps1` currently can't see.

**Architecture:** A new TypeScript module (`relaunchViaDedicatedNode.ts`) gives `run-proxy` a private copy of `node.exe` and relaunches itself through it before binding the Internal-switch adapter. `host-allow-vm-inbound.ps1` is rewritten to scope every rule it can by `-LocalAddress`/`-LocalPort` against that fixed path. `verify-proxy.ps1` gains two new checks (host-model, any-node.exe stale-rule scan) and extends its existing rule-presence checks into exact filter/state validation, so drift from what `host-allow-vm-inbound.ps1` creates is caught, not just a missing `DisplayName`.

**Tech Stack:** TypeScript (Node ≥18, ESM), `execa` for child-process spawning, `vitest` for unit tests, PowerShell 5.1 (`NetSecurity`/`NetTCPIP` modules) for the two host-side scripts.

## Global Constraints

- Node.js `>=18` (from `package.json`).
- No new npm dependencies — use only `execa`, `node:fs`, `node:crypto`, `node:path`, `node:os`, already in the project.
- `templates/proxy/host-allow-vm-inbound.ps1` requires `#requires -Modules NetSecurity, NetTCPIP`; keep it.
- `templates/proxy/verify-proxy.ps1` requires `#requires -Version 5.1`; keep it.
- The dedicated node.exe's fixed path (`%USERPROFILE%\.configamatron-host\run-proxy-node.exe`) must be computed identically in `relaunchViaDedicatedNode.ts`, `host-allow-vm-inbound.ps1`, and `verify-proxy.ps1` — three independent implementations of the same constant, not shared code (TS and PowerShell can't share a module).
- The relaunch mechanism must only ever engage on `process.platform === 'win32' && options.forward`; every existing test invokes `run-proxy` with `--no-forward`, so this gate must not change behavior for any of them.
- `pnpm test` (format, lint, typecheck, unit, build, e2e, integration) must pass at the end of every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runProxy/relaunchViaDedicatedNode.ts` (new) | Compute the dedicated node.exe path; keep the copy present and byte-identical to the running node.exe; relaunch through it, propagating the child's exit. |
| `tests/unit/runProxy/relaunchViaDedicatedNode.test.ts` (new) | Unit tests for the above, fully mocked (no real fs/process). |
| `src/commands/runProxy.ts` (modify) | Call the relaunch check first in `.action()`; drop the unused `--forward-ports` option. |
| `tests/unit/commands/runProxy.test.ts` (new) | Confirms `--forward-ports` is gone from the registered command. |
| `templates/proxy/host-allow-vm-inbound.ps1` (rewrite) | Resolve both required addresses up front; create every rule `-LocalAddress`-scoped where possible; create three `-Program`-scoped rules for the dedicated node.exe instead of one discovered one. |
| `templates/proxy/verify-proxy.ps1` (rewrite) | Add the host-model and broadened stale-rule checks; extend the existing rule-presence checks into exact filter/state validation. |
| `tests/unit/templates.test.ts` (modify) | Content-assertion tests for both `.ps1` files, matching this project's existing posture (no real firewall/Hyper-V execution in CI). |

---

## Task 1: `relaunchViaDedicatedNode.ts` — dedicated path and copy-freshness logic

**Files:**

- Create: `src/runProxy/relaunchViaDedicatedNode.ts`
- Test: `tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`

**Interfaces:**

- Produces: `getDedicatedNodePath(homedir: string): string`; `ensureDedicatedNodeCopy(deps: EnsureCopyDeps): Promise<string>` where `EnsureCopyDeps = { execPath: string; homedir: string; fileSize: (path: string) => number | null; hashFile: (path: string) => Promise<string>; copyFile: (src: string, dest: string) => void; mkdir: (dirPath: string) => void; writeReadme: (dedicatedPath: string) => void }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  getDedicatedNodePath,
  ensureDedicatedNodeCopy,
  type EnsureCopyDeps,
} from '../../../src/runProxy/relaunchViaDedicatedNode';

describe('getDedicatedNodePath', () => {
  it('joins the given homedir with the fixed .configamatron-host convention', () => {
    expect(getDedicatedNodePath('C:\\Users\\alice')).toBe(
      'C:\\Users\\alice\\.configamatron-host\\run-proxy-node.exe',
    );
  });
});

describe('ensureDedicatedNodeCopy', () => {
  const DEDICATED = 'C:\\Users\\alice\\.configamatron-host\\run-proxy-node.exe';
  const SOURCE = 'C:\\node\\node.exe';

  function makeDeps(overrides: Partial<EnsureCopyDeps> = {}): EnsureCopyDeps {
    return {
      execPath: SOURCE,
      homedir: 'C:\\Users\\alice',
      fileSize: vi.fn(() => null),
      hashFile: vi.fn(async () => 'hash'),
      copyFile: vi.fn(),
      mkdir: vi.fn(),
      writeReadme: vi.fn(),
      ...overrides,
    };
  }

  it('copies when the dedicated path has no file yet', async () => {
    const deps = makeDeps({
      fileSize: vi.fn((path: string) => (path === SOURCE ? 100 : null)),
    });

    const result = await ensureDedicatedNodeCopy(deps);

    expect(result).toBe(DEDICATED);
    expect(deps.hashFile).not.toHaveBeenCalled();
    expect(deps.mkdir).toHaveBeenCalledWith('C:\\Users\\alice\\.configamatron-host');
    expect(deps.copyFile).toHaveBeenCalledWith(SOURCE, DEDICATED);
    expect(deps.writeReadme).toHaveBeenCalledWith(DEDICATED);
  });

  it('copies when sizes differ, without hashing', async () => {
    const deps = makeDeps({
      fileSize: vi.fn((path: string) => (path === SOURCE ? 100 : 50)),
    });

    await ensureDedicatedNodeCopy(deps);

    expect(deps.hashFile).not.toHaveBeenCalled();
    expect(deps.copyFile).toHaveBeenCalledTimes(1);
  });

  it('copies when sizes match but hashes differ', async () => {
    const deps = makeDeps({
      fileSize: vi.fn(() => 100),
      hashFile: vi.fn((path: string) =>
        Promise.resolve(path === SOURCE ? 'hash-a' : 'hash-b'),
      ),
    });

    await ensureDedicatedNodeCopy(deps);

    expect(deps.hashFile).toHaveBeenCalledTimes(2);
    expect(deps.copyFile).toHaveBeenCalledTimes(1);
  });

  it('does not copy when size and hash both match, but still refreshes the readme', async () => {
    const deps = makeDeps({
      fileSize: vi.fn(() => 100),
      hashFile: vi.fn(async () => 'same-hash'),
    });

    await ensureDedicatedNodeCopy(deps);

    expect(deps.copyFile).not.toHaveBeenCalled();
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.writeReadme).toHaveBeenCalledTimes(1);
    expect(deps.writeReadme).toHaveBeenCalledWith(DEDICATED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`
Expected: FAIL — `Cannot find module '../../../src/runProxy/relaunchViaDedicatedNode'`

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/relaunchViaDedicatedNode.ts`:

```typescript
import { dirname, join } from 'node:path';

export interface EnsureCopyDeps {
  execPath: string;
  homedir: string;
  fileSize: (path: string) => number | null;
  hashFile: (path: string) => Promise<string>;
  copyFile: (src: string, dest: string) => void;
  mkdir: (dirPath: string) => void;
  writeReadme: (dedicatedPath: string) => void;
}

/** Fixed, host-wide path — a known constant needs no discovery logic and cannot guess wrong. */
export function getDedicatedNodePath(homedir: string): string {
  return join(homedir, '.configamatron-host', 'run-proxy-node.exe');
}

/**
 * Copies `deps.execPath` to the dedicated path unless a file already there matches it
 * (size, then — only if sizes already match — content hash). Always refreshes
 * readme.txt alongside it, whether or not a copy happened.
 */
export async function ensureDedicatedNodeCopy(deps: EnsureCopyDeps): Promise<string> {
  const dedicatedPath = getDedicatedNodePath(deps.homedir);
  const sourceSize = deps.fileSize(deps.execPath);
  const existingSize = deps.fileSize(dedicatedPath);

  let matches = existingSize !== null && existingSize === sourceSize;
  if (matches) {
    const [sourceHash, existingHash] = await Promise.all([
      deps.hashFile(deps.execPath),
      deps.hashFile(dedicatedPath),
    ]);
    matches = sourceHash === existingHash;
  }

  if (!matches) {
    deps.mkdir(dirname(dedicatedPath));
    deps.copyFile(deps.execPath, dedicatedPath);
  }
  deps.writeReadme(dedicatedPath);

  return dedicatedPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/relaunchViaDedicatedNode.ts tests/unit/runProxy/relaunchViaDedicatedNode.test.ts
git commit -m "feat: add dedicated node.exe path and copy-freshness logic"
```

---

## Task 2: `relaunchViaDedicatedNode.ts` — relaunch, signal handling, real deps

**Files:**

- Modify: `src/runProxy/relaunchViaDedicatedNode.ts`
- Modify: `tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`

**Interfaces:**

- Consumes: `getDedicatedNodePath(homedir: string): string`, `ensureDedicatedNodeCopy(deps: EnsureCopyDeps): Promise<string>`, `EnsureCopyDeps` from Task 1.
- Produces: `type SpawnResult = { exitCode?: number; signal?: string }`; `interface RelaunchDeps extends EnsureCopyDeps { platform: NodeJS.Platform; forward: boolean; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; spawn: (execPath: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<SpawnResult>; onSigint: (handler: () => void) => void; error: (message: string) => void }`; `type RelaunchResult = { relaunched: true; exitCode: number } | { relaunched: false }`; `relaunchIfNeeded(deps: RelaunchDeps): Promise<RelaunchResult>`; `createRelaunchDeps(forward: boolean): RelaunchDeps`.

- [ ] **Step 1: Write the failing test**

First, find this exact text (Task 1's import block, at the top of the file) and add `relaunchIfNeeded` and `type RelaunchDeps` to it:

```typescript
import {
  getDedicatedNodePath,
  ensureDedicatedNodeCopy,
  type EnsureCopyDeps,
} from '../../../src/runProxy/relaunchViaDedicatedNode';
```

Replace it with:

```typescript
import {
  getDedicatedNodePath,
  ensureDedicatedNodeCopy,
  relaunchIfNeeded,
  type EnsureCopyDeps,
  type RelaunchDeps,
} from '../../../src/runProxy/relaunchViaDedicatedNode';
```

Then append the new `describe` block to the end of the file:

```typescript
describe('relaunchIfNeeded', () => {
  const DEDICATED = 'C:\\Users\\alice\\.configamatron-host\\run-proxy-node.exe';
  const SOURCE = 'C:\\node\\node.exe';

  function makeDeps(overrides: Partial<RelaunchDeps> = {}): RelaunchDeps {
    return {
      platform: 'win32',
      forward: true,
      execPath: SOURCE,
      argv: [SOURCE, 'C:\\cli\\cli.js', 'run-proxy'],
      cwd: 'C:\\project',
      env: { FOO: 'bar' },
      homedir: 'C:\\Users\\alice',
      fileSize: vi.fn(() => null),
      hashFile: vi.fn(async () => 'hash'),
      copyFile: vi.fn(),
      mkdir: vi.fn(),
      writeReadme: vi.fn(),
      spawn: vi.fn(async () => ({ exitCode: 0 })),
      onSigint: vi.fn(),
      error: vi.fn(),
      ...overrides,
    };
  }

  it('does nothing on non-win32', async () => {
    const deps = makeDeps({ platform: 'linux' });
    const result = await relaunchIfNeeded(deps);
    expect(result).toEqual({ relaunched: false });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('does nothing when forwarding is disabled', async () => {
    const deps = makeDeps({ forward: false });
    const result = await relaunchIfNeeded(deps);
    expect(result).toEqual({ relaunched: false });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('does nothing when already running the dedicated copy (case-insensitive)', async () => {
    const deps = makeDeps({
      execPath: 'C:\\USERS\\ALICE\\.CONFIGAMATRON-HOST\\RUN-PROXY-NODE.EXE',
    });
    const result = await relaunchIfNeeded(deps);
    expect(result).toEqual({ relaunched: false });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('ensures the copy, installs a SIGINT listener, and spawns argv.slice(1) on the dedicated path', async () => {
    const deps = makeDeps({
      fileSize: vi.fn((path: string) => (path === SOURCE ? 100 : null)),
    });

    const result = await relaunchIfNeeded(deps);

    expect(deps.copyFile).toHaveBeenCalledWith(SOURCE, DEDICATED);
    expect(deps.onSigint).toHaveBeenCalledTimes(1);
    expect(deps.spawn).toHaveBeenCalledWith(DEDICATED, ['C:\\cli\\cli.js', 'run-proxy'], {
      cwd: 'C:\\project',
      env: { FOO: 'bar' },
    });
    expect(result).toEqual({ relaunched: true, exitCode: 0 });
  });

  it('propagates a non-zero exit code', async () => {
    const deps = makeDeps({ spawn: vi.fn(async () => ({ exitCode: 7 })) });
    const result = await relaunchIfNeeded(deps);
    expect(result).toEqual({ relaunched: true, exitCode: 7 });
  });

  it('falls back to a fixed exit code when the child was terminated by signal', async () => {
    const deps = makeDeps({ spawn: vi.fn(async () => ({ signal: 'SIGTERM' })) });
    const result = await relaunchIfNeeded(deps);
    expect(result).toEqual({ relaunched: true, exitCode: 1 });
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('terminated by signal SIGTERM'));
  });

  it('falls back to a fixed exit code when spawn could not launch the process at all', async () => {
    const deps = makeDeps({ spawn: vi.fn(async () => ({})) });
    const result = await relaunchIfNeeded(deps);
    expect(result).toEqual({ relaunched: true, exitCode: 1 });
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('failed to launch'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`
Expected: FAIL — `relaunchIfNeeded` is not exported

- [ ] **Step 3: Write the implementation**

Replace the full content of `src/runProxy/relaunchViaDedicatedNode.ts`:

```typescript
import { createHash } from 'node:crypto';
import { createReadStream, statSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';

export interface EnsureCopyDeps {
  execPath: string;
  homedir: string;
  fileSize: (path: string) => number | null;
  hashFile: (path: string) => Promise<string>;
  copyFile: (src: string, dest: string) => void;
  mkdir: (dirPath: string) => void;
  writeReadme: (dedicatedPath: string) => void;
}

export interface SpawnResult {
  exitCode?: number;
  signal?: string;
}

export interface RelaunchDeps extends EnsureCopyDeps {
  platform: NodeJS.Platform;
  forward: boolean;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: (
    execPath: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<SpawnResult>;
  onSigint: (handler: () => void) => void;
  error: (message: string) => void;
}

export type RelaunchResult = { relaunched: true; exitCode: number } | { relaunched: false };

const FALLBACK_EXIT_CODE = 1;

const README_CONTENT = [
  'run-proxy-node.exe is a plain copy of the node.exe that ran configamatron',
  'run-proxy, kept here so a Windows Firewall rule can be scoped to a binary',
  'that only ever runs run-proxy — not the shared system node.exe, which any',
  'other script or tool might also run through.',
  '',
  'It is not a customized build. Deleting this file is safe: the next',
  '`configamatron run-proxy` (with forwarding enabled, the default) recreates',
  'it from whatever node.exe is currently running the CLI.',
  '',
].join('\n');

/** Fixed, host-wide path — a known constant needs no discovery logic and cannot guess wrong. */
export function getDedicatedNodePath(homedir: string): string {
  return join(homedir, '.configamatron-host', 'run-proxy-node.exe');
}

/**
 * Copies `deps.execPath` to the dedicated path unless a file already there matches it
 * (size, then — only if sizes already match — content hash). Always refreshes
 * readme.txt alongside it, whether or not a copy happened.
 */
export async function ensureDedicatedNodeCopy(deps: EnsureCopyDeps): Promise<string> {
  const dedicatedPath = getDedicatedNodePath(deps.homedir);
  const sourceSize = deps.fileSize(deps.execPath);
  const existingSize = deps.fileSize(dedicatedPath);

  let matches = existingSize !== null && existingSize === sourceSize;
  if (matches) {
    const [sourceHash, existingHash] = await Promise.all([
      deps.hashFile(deps.execPath),
      deps.hashFile(dedicatedPath),
    ]);
    matches = sourceHash === existingHash;
  }

  if (!matches) {
    deps.mkdir(dirname(dedicatedPath));
    deps.copyFile(deps.execPath, dedicatedPath);
  }
  deps.writeReadme(dedicatedPath);

  return dedicatedPath;
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Relaunches through a dedicated copy of node.exe on Windows when forwarding is
 * enabled — the only case where run-proxy binds the Internal-switch adapter and can
 * trigger Windows' listen-time firewall prompt. Resolves once the relaunched child
 * has exited, with its exit code (or a fixed fallback if it died by signal, or
 * couldn't be launched at all).
 */
export async function relaunchIfNeeded(deps: RelaunchDeps): Promise<RelaunchResult> {
  if (deps.platform !== 'win32' || !deps.forward) {
    return { relaunched: false };
  }

  const dedicatedPath = getDedicatedNodePath(deps.homedir);
  if (samePath(deps.execPath, dedicatedPath)) {
    return { relaunched: false };
  }

  await ensureDedicatedNodeCopy(deps);

  // Ctrl-C on Windows delivers CTRL_C_EVENT to every process sharing the console,
  // parent and child alike. Node's default reaction to an unhandled SIGINT is
  // immediate termination — without this listener the parent would very likely die
  // on the same keystroke that's supposed to trigger the child's graceful shutdown,
  // before it can wait for the child's exit and propagate its code.
  deps.onSigint(() => {});

  const result = await deps.spawn(dedicatedPath, deps.argv.slice(1), {
    cwd: deps.cwd,
    env: deps.env,
  });

  if (result.exitCode !== undefined) {
    return { relaunched: true, exitCode: result.exitCode };
  }
  if (result.signal !== undefined) {
    deps.error(`run-proxy: dedicated node.exe copy was terminated by signal ${result.signal}`);
  } else {
    deps.error('run-proxy: failed to launch the dedicated node.exe copy');
  }
  return { relaunched: true, exitCode: FALLBACK_EXIT_CODE };
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function writeReadme(dedicatedPath: string): void {
  writeFileSync(join(dirname(dedicatedPath), 'readme.txt'), README_CONTENT);
}

/** Wires real fs/crypto/execa/process access; the only non-test caller. */
export function createRelaunchDeps(forward: boolean): RelaunchDeps {
  return {
    platform: process.platform,
    forward,
    execPath: process.execPath,
    argv: process.argv,
    cwd: process.cwd(),
    env: process.env,
    homedir: homedir(),
    fileSize,
    hashFile,
    copyFile: copyFileSync,
    mkdir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
    writeReadme,
    spawn: async (execPath, args, options) => {
      const result = await execa(execPath, args, { ...options, stdio: 'inherit', reject: false });
      return { exitCode: result.exitCode, signal: result.signal };
    },
    onSigint: (handler) => process.on('SIGINT', handler),
    error: (message) => console.error(message),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/runProxy/relaunchViaDedicatedNode.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/relaunchViaDedicatedNode.ts tests/unit/runProxy/relaunchViaDedicatedNode.test.ts
git commit -m "feat: relaunch run-proxy through the dedicated node.exe copy on Windows"
```

---

## Task 3: Wire the relaunch into `run-proxy`, drop `--forward-ports`

**Files:**

- Modify: `src/commands/runProxy.ts`
- Create: `tests/unit/commands/runProxy.test.ts`

**Interfaces:**

- Consumes: `relaunchIfNeeded(deps: RelaunchDeps): Promise<RelaunchResult>`, `createRelaunchDeps(forward: boolean): RelaunchDeps` from Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/commands/runProxy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunProxy } from '../../../src/commands/runProxy';

describe('registerRunProxy', () => {
  it('no longer exposes --forward-ports', () => {
    const program = new Command();
    registerRunProxy(program);
    const runProxyCommand = program.commands.find((cmd) => cmd.name() === 'run-proxy');
    expect(runProxyCommand).toBeDefined();
    const flags = runProxyCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--forward-ports'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/commands/runProxy.test.ts`
Expected: FAIL — `--forward-ports` is still present (assertion `toBe(false)` gets `true`)

- [ ] **Step 3: Implement — remove `--forward-ports`, wire the relaunch**

In `src/commands/runProxy.ts`, remove `forwardPorts?: string;` from `RunProxyOptions`:

```typescript
interface RunProxyOptions {
  credentials: string;
  secret?: string;
  codexCredentials: string;
  codexSecret?: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  upstreamOverride: UpstreamOverride[];
  injectFault?: InjectFault;
}
```

Remove the `--forward-ports` option registration:

```typescript
    .option(
      '--forward-ports <http,https>',
      'ports to forward (default: ENVOY_HTTP_PORT,ENVOY_HTTPS_PORT or 80,443)',
    )
```

Find this exact text (the port computation that used it):

```typescript
      const [httpPort, httpsPort] = options.forwardPorts
        ? options.forwardPorts.split(',').map((p) => Number(p.trim()))
        : [Number(process.env.ENVOY_HTTP_PORT ?? 80), Number(process.env.ENVOY_HTTPS_PORT ?? 443)];
```

Replace it with:

```typescript
      const httpPort = Number(process.env.ENVOY_HTTP_PORT ?? 80);
      const httpsPort = Number(process.env.ENVOY_HTTPS_PORT ?? 443);
```

Add the import at the top of the file:

```typescript
import { relaunchIfNeeded, createRelaunchDeps } from '../runProxy/relaunchViaDedicatedNode';
```

Add the relaunch call as the very first thing inside `.action()`, before `requireEnvPathsOrExit`:

```typescript
    .action(async (options: RunProxyOptions) => {
      try {
        const relaunch = await relaunchIfNeeded(createRelaunchDeps(options.forward));
        if (relaunch.relaunched) {
          process.exitCode = relaunch.exitCode;
          return;
        }
      } catch (err) {
        console.error(
          `run-proxy: failed to relaunch through the dedicated node.exe copy: ${String(err)}`,
        );
        process.exitCode = 1;
        return;
      }

      const paths = requireEnvPathsOrExit('run-proxy');
      if (!paths) return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/commands/runProxy.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and run the full unit suite**

Run: `pnpm typecheck && pnpm test:unit`
Expected: no errors, all unit tests pass

- [ ] **Step 6: Commit**

```bash
git add src/commands/runProxy.ts tests/unit/commands/runProxy.test.ts
git commit -m "feat: relaunch run-proxy through dedicated node.exe; drop unused --forward-ports"
```

---

## Task 4: Rewrite `host-allow-vm-inbound.ps1`

**Files:**

- Modify: `templates/proxy/host-allow-vm-inbound.ps1`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Produces (as a convention other scripts must match, not a callable interface): fixed dedicated node.exe path `%USERPROFILE%\.configamatron-host\run-proxy-node.exe`; firewall rule `DisplayName`s `"Envoy Sandbox Proxy (VM inbound)"` (TCP 80/443, `-LocalAddress $hostIp`), `"Envoy Sandbox Proxy DNS stub (VM inbound)"` (UDP 53, `-LocalAddress $hostIp`), `"Envoy Sandbox Proxy DHCP (VM inbound)"` (UDP 67, no `-LocalAddress`), `"Configamatron share (VM inbound)"` (two TCP 445 rules: one `-InterfaceAlias $AdapterAlias -LocalAddress $hostIp`, one `-InterfaceAlias $NatAdapterAlias -LocalAddress $natHostIp`), `"Configamatron run-proxy node (VM inbound)"` (three `-Program`-scoped rules: TCP 80/443 + `-LocalAddress $hostIp`, UDP 53 + `-LocalAddress $hostIp`, UDP 67 without). Task 6 (`verify-proxy.ps1`) must check for exactly these.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/templates.test.ts` (inside the existing `describe('templates', ...)` block, alongside the other `it(...)` cases):

```typescript
  it('host-allow-vm-inbound scopes rules by LocalAddress, splits SMB/node.exe, and drops node discovery', () => {
    const script = readFileSync(
      join(templatesDir(), 'proxy', 'host-allow-vm-inbound.ps1'),
      'utf8',
    );
    expect(script).not.toContain('Resolve-RunProxyNode');
    expect(script).not.toContain('-NodePath');
    expect(script).toContain('$hostIp = ');
    expect(script).toContain('$natHostIp = ');
    expect((script.match(/-LocalAddress \$hostIp/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(script).toContain('-LocalAddress $natHostIp');
    expect((script.match(/-LocalPort 445/g) ?? []).length).toBe(2);
    expect((script.match(/-Program \$nodePath/g) ?? []).length).toBe(3);
    expect(script).toContain('.configamatron-host\\run-proxy-node.exe');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — the current script still contains `Resolve-RunProxyNode` and `-NodePath`, and has no `$natHostIp`

- [ ] **Step 3: Rewrite the script**

Replace the full content of `templates/proxy/host-allow-vm-inbound.ps1`:

```powershell
#requires -Modules NetSecurity, NetTCPIP
<#
Opens inbound traffic from the VM's Hyper-V Internal-switch adapter:

  TCP 80/443  - Envoy, via run-proxy's gateway
  UDP 53      - run-proxy's DNS responder
  UDP 67      - run-proxy's DHCP server
  TCP 445     - the configamatron-share SMB share (Internal-switch and NAT)

and prints the host IP to pass to the guest setup scripts.

Every rule except DHCP (:67 - see below) is scoped by -LocalAddress as well as
-InterfaceAlias. An -InterfaceAlias-only rule permits a packet to *any* local
address on that port, relying entirely on Windows' strong-host model (and
disabled IP forwarding) to keep it confined to this adapter's own address.
-LocalAddress makes that confinement hold even if the host model is ever
weakened - see
docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md.

UDP 67 (DHCP) stays interface-scoped only: a client with no address broadcasts
DISCOVER from 0.0.0.0 to 255.255.255.255, not the host's unicast IP, so a
-LocalAddress condition would silently break DHCP.

The SMB rule spans two adapters (this one and the NAT/Default-Switch one), so
it's two separate rules under the same DisplayName, each with its own
-InterfaceAlias/-LocalAddress pair - a single rule listing both interfaces and
both addresses would let a packet arriving on either interface match either
address, which is not the same guarantee.

It also establishes three program-scoped rules for a dedicated copy of
node.exe that run-proxy relaunches itself through on Windows
(src/runProxy/relaunchViaDedicatedNode.ts), rather than the shared system
node.exe. Without these, the first run-proxy start on an Internal switch
raises Windows' "allow node.exe on public networks?" dialog - an Internal
switch has no gateway, so Windows can never identify it as anything but
Public - and writes a "Query User{GUID}<path>" rule from whatever gets
clicked. Both answers are wrong: Allow grants any port on any local address
and masks whether the four rules above are present at all (this is what
happened at the 2026-07-23 Windows checkpoint), while dismissing it writes a
Block of the same breadth that silently overrides them, since Windows
evaluates Block before Allow. Pre-empting the dialog is what makes the
environment deterministic. Three rules, not one, because -LocalPort can't mix
TCP and UDP under one -Protocol - this mirrors the plain port rules' own
three-way split.

The dedicated node.exe lives at a fixed, host-wide path
(%USERPROFILE%\.configamatron-host\run-proxy-node.exe) that run-proxy creates
on its first forwarded start. The path is a known constant, not discovered -
New-NetFirewallRule -Program does not require the file to exist yet, so this
script can run before that first start.

Safe to re-run: replaces any existing rules with the same names.
#>
[CmdletBinding()]
param(
    [string]$AdapterAlias = "vEthernet (configamatron-internal)",
    [string]$NatAdapterAlias = "vEthernet (Default Switch)"
)

$ErrorActionPreference = "Stop"

# Resolve and validate every address this script needs up front, before any
# existing rule is removed, so a resolution failure aborts cleanly rather than
# leaving rules deleted and not yet replaced.
$config = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias
$hostIp = ($config.IPv4Address | Select-Object -First 1).IPAddress
if (-not $hostIp) {
    throw "No IPv4 address on adapter '$AdapterAlias'. Confirm the VM is on the Internal switch and this is the right adapter (Get-NetIPConfiguration lists all adapters)."
}

$natConfig = Get-NetIPConfiguration -InterfaceAlias $NatAdapterAlias
$natHostIp = ($natConfig.IPv4Address | Select-Object -First 1).IPAddress
if (-not $natHostIp) {
    throw "No IPv4 address on adapter '$NatAdapterAlias'. The SMB share rule needs this adapter's address; pass -NatAdapterAlias if your NAT switch is named differently."
}

$nodePath = Join-Path $env:USERPROFILE ".configamatron-host\run-proxy-node.exe"

$tcpRuleName = "Envoy Sandbox Proxy (VM inbound)"
$dnsRuleName = "Envoy Sandbox Proxy DNS stub (VM inbound)"
$dhcpRuleName = "Envoy Sandbox Proxy DHCP (VM inbound)"
$smbRuleName = "Configamatron share (VM inbound)"
$nodeRuleName = "Configamatron run-proxy node (VM inbound)"

foreach ($name in @($tcpRuleName, $dnsRuleName, $dhcpRuleName, $smbRuleName, $nodeRuleName)) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

# Clear any prompt-generated rule for the dedicated node.exe too, before
# recreating its Allow rules below. A Block one would override every rule
# created here; an Allow one would hide their absence.
$stale = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*Query User*" -and $_.Name.EndsWith($nodePath, [StringComparison]::OrdinalIgnoreCase)
}
foreach ($rule in $stale) {
    Write-Host "Removing prompt-generated $($rule.Action) rule: $($rule.Name)"
}
if ($stale) { $stale | Remove-NetFirewallRule }

New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dnsRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $dhcpRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $smbRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 445 -InterfaceAlias $NatAdapterAlias -LocalAddress $natHostIp -Action Allow | Out-Null

New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol TCP `
    -LocalPort 80, 443 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 53 -Program $nodePath -InterfaceAlias $AdapterAlias -LocalAddress $hostIp -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $nodeRuleName -Direction Inbound -Protocol UDP `
    -LocalPort 67 -Program $nodePath -InterfaceAlias $AdapterAlias -Action Allow | Out-Null

Write-Host "Firewall rules created, scoped to interface '$AdapterAlias'."
Write-Host "Host IP for this network: $hostIp"
Write-Host "Program rules created for $nodePath"
Write-Host "Use this as <host-ip> in:"
Write-Host "  bash vm/vm-setup-persistence.sh $hostIp"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS (all `templates.test.ts` cases, including the new one)

- [ ] **Step 5: Commit**

```bash
git add templates/proxy/host-allow-vm-inbound.ps1 tests/unit/templates.test.ts
git commit -m "feat: scope host-allow-vm-inbound rules by LocalAddress; split SMB and node.exe rules"
```

---

## Task 5: `verify-proxy.ps1` — host-model check and broadened stale-rule scan

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: nothing new from earlier tasks (the host-model check reads `Get-NetIPInterface` directly; the stale-rule scan matches on the literal suffix `node.exe`, not a specific path).

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/templates.test.ts`:

```typescript
  it('verify-proxy checks the host network model and any stale node.exe Query User rule', () => {
    const script = readFileSync(join(templatesDir(), 'proxy', 'verify-proxy.ps1'), 'utf8');
    expect(script).toContain('Get-NetIPInterface');
    expect(script).toContain('WeakHostReceive');
    expect(script).toContain('Forwarding');
    expect(script).toContain("EndsWith('node.exe'");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — the current script has none of these

- [ ] **Step 3: Implement — insert the two new sections**

In `templates/proxy/verify-proxy.ps1`, find this exact text (the end of the `'VM-path (forwarder -> loopback)'` section, right before `'VM reachability'`):

```powershell
    else { Add-Pass "credential gate via ${vmIp}: rejected upstream ($($fwdGate.Code))" }
}

Write-Section 'VM reachability'
```

Replace it with:

```powershell
    else { Add-Pass "credential gate via ${vmIp}: rejected upstream ($($fwdGate.Code))" }
}

Write-Section 'Host network model'

# A weak-host flip is a real confinement break, not advisory: it lets the
# guest reach the host's other IPs on the allowed ports (see
# docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md).
$netIf = Get-NetIPInterface -InterfaceAlias $AdapterAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue
if (-not $netIf) {
    Add-Warn 'host network model checked' "no IPv4 interface named '$AdapterAlias' -- is the Internal-switch adapter up?"
} else {
    if ($netIf.Forwarding.ToString() -eq 'Disabled') { Add-Pass "IP forwarding disabled on $AdapterAlias" }
    else { Add-Fail "IP forwarding disabled on $AdapterAlias" "Forwarding=$($netIf.Forwarding) -- a guest could be routed to the host's other networks" }

    if ($netIf.WeakHostReceive.ToString() -eq 'Disabled') { Add-Pass "strong-host model (WeakHostReceive disabled) on $AdapterAlias" }
    else { Add-Fail "strong-host model (WeakHostReceive disabled) on $AdapterAlias" "WeakHostReceive=$($netIf.WeakHostReceive) -- guest could reach the host's other IPs on the allowed ports" }
}

Write-Section 'Stale prompt-generated rules'

# Scans for ANY node.exe, not just a specific path, so a rule left behind by a
# different (e.g. repo-local dev) node.exe that once hosted run-proxy is also
# caught -- reported, not deleted, since a match might be legitimate for an
# unrelated program.
$staleNodeRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*Query User*" -and $_.Name.EndsWith('node.exe', [StringComparison]::OrdinalIgnoreCase)
})
if ($staleNodeRules.Count -eq 0) {
    Add-Pass 'no stale Query User rule for any node.exe'
} else {
    foreach ($rule in $staleNodeRules) {
        Add-Fail 'no stale Query User rule for any node.exe' "$($rule.Action) rule '$($rule.Name)' -- rerun host-allow-vm-inbound.ps1, or investigate why Windows re-prompted"
    }
}

Write-Section 'VM reachability'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS (all cases including the new one)

- [ ] **Step 5: Commit**

```bash
git add templates/proxy/verify-proxy.ps1 tests/unit/templates.test.ts
git commit -m "feat: verify-proxy checks host network model and any stale node.exe Query User rule"
```

---

## Task 6: `verify-proxy.ps1` — exact rule-set filter/state validation

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: the exact `DisplayName`s and per-rule tuples (protocol/port/interface/address/program) that Task 4's `host-allow-vm-inbound.ps1` creates.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/templates.test.ts`:

```typescript
  it('verify-proxy validates rule filters and state, not just DisplayName presence', () => {
    const script = readFileSync(join(templatesDir(), 'proxy', 'verify-proxy.ps1'), 'utf8');
    expect(script).toContain('Get-NetFirewallAddressFilter');
    expect(script).toContain('Get-NetFirewallPortFilter');
    expect(script).toContain('Get-NetFirewallInterfaceFilter');
    expect(script).toContain('Get-NetFirewallApplicationFilter');
    expect(script).toContain('Enabled.ToString()');
    expect(script).toContain('Direction.ToString()');
    expect(script).toContain('Action.ToString()');
    expect(script).toContain('$NatAdapterAlias');
    expect(script).toContain('SkipAddress');
    expect((script.match(/Test-RuleSet -Label/g) ?? []).length).toBe(5);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — none of these exist in the script yet

- [ ] **Step 3a: Add the `$NatAdapterAlias` parameter and document it**

Find this exact text (the top-of-file doc-comment and param block):

```powershell
The VM-path checks probe the Internal-switch adapter the forwarder listens on.
-AdapterAlias defaults to the Hyper-V Internal-switch NIC "vEthernet
(configamatron-internal)"; pass a different alias if your switch is named
differently, matching host-allow-vm-inbound.ps1, e.g.:

    ... -File .configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (my-switch)"
#>
[CmdletBinding()]
param(
    [string]$EnvDir = (Get-Location).Path,
    [string]$AdapterAlias = 'vEthernet (configamatron-internal)'
)
```

Replace it with:

```powershell
The VM-path checks probe the Internal-switch adapter the forwarder listens on.
-AdapterAlias defaults to the Hyper-V Internal-switch NIC "vEthernet
(configamatron-internal)"; pass a different alias if your switch is named
differently, matching host-allow-vm-inbound.ps1, e.g.:

    ... -File .configamatron\proxy\verify-proxy.ps1 -AdapterAlias "vEthernet (my-switch)"

-NatAdapterAlias defaults to "vEthernet (Default Switch)", matching
host-allow-vm-inbound.ps1 - it's used only to check the second half of the
SMB share rule.
#>
[CmdletBinding()]
param(
    [string]$EnvDir = (Get-Location).Path,
    [string]$AdapterAlias = 'vEthernet (configamatron-internal)',
    [string]$NatAdapterAlias = 'vEthernet (Default Switch)'
)
```

- [ ] **Step 3b: Add the `Get-DedicatedNodePath`, `Test-RuleTuple`, and `Test-RuleSet` helpers**

Find this exact text (right after the existing `Invoke-CurlCode` helper):

```powershell
# Run curl.exe and return the observed HTTP status code plus the process exit code.
function Invoke-CurlCode {
    param([Parameter(Mandatory)][string[]]$CurlArgs)
    $code = & curl.exe -s -o NUL -w '%{http_code}' @CurlArgs 2>$null
    return [pscustomobject]@{ Code = "$code".Trim(); Exit = $LASTEXITCODE }
}

$proxyDir = Join-Path $EnvDir '.configamatron\proxy'
```

Replace it with:

```powershell
# Run curl.exe and return the observed HTTP status code plus the process exit code.
function Invoke-CurlCode {
    param([Parameter(Mandatory)][string[]]$CurlArgs)
    $code = & curl.exe -s -o NUL -w '%{http_code}' @CurlArgs 2>$null
    return [pscustomobject]@{ Code = "$code".Trim(); Exit = $LASTEXITCODE }
}

# The fixed, host-wide path run-proxy relaunches itself through on Windows -
# mirrors the convention in src/runProxy/relaunchViaDedicatedNode.ts.
function Get-DedicatedNodePath {
    Join-Path $env:USERPROFILE ".configamatron-host\run-proxy-node.exe"
}

# Checks one expected filter/state tuple against one resolved rule object.
# $Expected.LocalAddress of $null means "no address restriction expected"
# (the DHCP/:67 rules) - that dimension is always checked regardless of
# $Expected.SkipAddress. $Expected.SkipAddress means the address THIS tuple
# expects couldn't be resolved this run, so only that one dimension is
# skipped here (Test-RuleSet WARNs about it separately) - count, interface,
# protocol, port, program, and state are still checked either way.
function Test-RuleTuple {
    param($Rule, $Expected)
    $portFilter = $Rule | Get-NetFirewallPortFilter
    $addrFilter = $Rule | Get-NetFirewallAddressFilter
    $ifFilter = $Rule | Get-NetFirewallInterfaceFilter
    $appFilter = $Rule | Get-NetFirewallApplicationFilter

    $expectedPorts = (@($Expected.LocalPort) | Sort-Object) -join ','
    $actualPorts = (@($portFilter.LocalPort) | Sort-Object) -join ','
    $addressOk = if ($Expected.SkipAddress) { $true }
                 elseif ($null -eq $Expected.LocalAddress) { $addrFilter.LocalAddress -eq 'Any' }
                 else { $addrFilter.LocalAddress -eq $Expected.LocalAddress }
    # $Expected.Program of $null means "expected unrestricted" (the TCP/DNS/
    # DHCP/SMB rules never carry -Program), asserted the same way as an
    # unrestricted LocalAddress - not "don't care," which would let a rule
    # that drifted to being -Program-scoped still pass.
    $programOk = if ($null -eq $Expected.Program) { $appFilter.Program -eq 'Any' }
                 else { $appFilter.Program -eq $Expected.Program }

    return (
        $portFilter.Protocol -eq $Expected.Protocol -and
        $actualPorts -eq $expectedPorts -and
        $ifFilter.InterfaceAlias -eq $Expected.InterfaceAlias -and
        $addressOk -and $programOk -and
        $Rule.Enabled.ToString() -eq 'True' -and
        $Rule.Direction.ToString() -eq 'Inbound' -and
        $Rule.Action.ToString() -eq 'Allow'
    )
}

# Verifies an exact, unordered match between the rules found under $DisplayName
# and $Expected (an array of tuples): right count, and every expected tuple
# claimed by exactly one distinct rule. A shared DisplayName can cover more
# than one real rule (SMB, node.exe), so "at least one matches" would let a
# missing or wrongly-scoped sibling hide behind one correct rule. A rule set
# that's simply absent WARNs (may just mean host-allow-vm-inbound.ps1 hasn't
# run yet); a present-but-wrong set FAILs. Always runs the full tuple check -
# an unresolved address (per-tuple SkipAddress) only ever narrows what that
# one comparison covers, never skips the rule set entirely.
function Test-RuleSet {
    param([string]$Label, [string]$DisplayName, [array]$Expected)

    $rules = @(Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue)

    if ($rules.Count -eq 0) {
        Add-Warn "$Label rule(s) present" "not found -- run host-allow-vm-inbound.ps1 (as admin)"
        return
    }

    $addressUnverifiable = [bool]($Expected | Where-Object { $_.SkipAddress } | Select-Object -First 1)
    if ($addressUnverifiable) {
        Add-Warn "$Label address scoping" "cannot verify -- an expected adapter's address could not be resolved"
    }

    if ($rules.Count -ne $Expected.Count) {
        Add-Fail "$Label rule count" "expected $($Expected.Count) rule(s) named '$DisplayName', found $($rules.Count)"
        return
    }

    $remaining = [System.Collections.ArrayList]::new($Expected)
    $allMatched = $true
    foreach ($rule in $rules) {
        $hit = $remaining | Where-Object { Test-RuleTuple -Rule $rule -Expected $_ } | Select-Object -First 1
        if ($hit) { $remaining.Remove($hit) }
        else { $allMatched = $false }
    }

    if ($allMatched) {
        $suffix = if ($addressUnverifiable) { '(port/interface/program/state; address unverified where noted)' } else { '(address/port/interface/program/state)' }
        Add-Pass "$Label rule(s) match expected scoping $suffix"
    } else {
        Add-Fail "$Label rule(s) match expected scoping" "one or more of the $($Expected.Count) rule(s) named '$DisplayName' don't match the expected tuple"
    }
}

$proxyDir = Join-Path $EnvDir '.configamatron\proxy'
```

- [ ] **Step 3c: Replace the `'VM reachability'` section**

Find this exact text (the entire `'VM reachability'` section, through the final summary):

```powershell
Write-Section 'VM reachability'

$rule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy (VM inbound)' -ErrorAction SilentlyContinue
if ($rule) { Add-Pass 'Internal-switch inbound firewall rule present' }
else { Add-Warn 'Internal-switch inbound firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin) once the VM is on the Internal switch" }
$dnsRule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy DNS stub (VM inbound)' -ErrorAction SilentlyContinue
if ($dnsRule) { Add-Pass 'Internal-switch inbound DNS firewall rule present' }
else { Add-Warn 'Internal-switch inbound DNS firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin)" }
$dhcpRule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy DHCP (VM inbound)' -ErrorAction SilentlyContinue
if ($dhcpRule) { Add-Pass 'Internal-switch inbound DHCP firewall rule present' }
else { Add-Warn 'Internal-switch inbound DHCP firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin)" }

$cfg = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias -ErrorAction SilentlyContinue
$hostIp = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
if ($hostIp) { Add-Pass "$AdapterAlias host IP: $hostIp (use as <host-ip> in VM setup)" }
else { Add-Warn 'Internal-switch adapter IP' "no IPv4 on '$AdapterAlias' -- is the Internal-switch adapter up?" }
if ($hostIp) {
    $dnsListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 53 -ErrorAction SilentlyContinue
    if ($dnsListener) { Add-Pass "DNS responder listening on ${hostIp}:53" }
    else { Add-Fail "DNS responder listening on ${hostIp}:53" "not found -- is run-proxy running? guests have no other resolver" }
    $dhcpListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 67 -ErrorAction SilentlyContinue
    if ($dhcpListener) { Add-Pass "DHCP server listening on ${hostIp}:67" }
    else { Add-Fail "DHCP server listening on ${hostIp}:67" "not found -- is run-proxy running? guests cannot get an address" }
}

Write-Host ''
Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
```

Replace it with:

```powershell
Write-Section 'VM reachability'

$cfg = Get-NetIPConfiguration -InterfaceAlias $AdapterAlias -ErrorAction SilentlyContinue
$hostIp = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
if ($hostIp) { Add-Pass "$AdapterAlias host IP: $hostIp (use as <host-ip> in VM setup)" }
else { Add-Warn 'Internal-switch adapter IP' "no IPv4 on '$AdapterAlias' -- is the Internal-switch adapter up?" }

$natCfg = Get-NetIPConfiguration -InterfaceAlias $NatAdapterAlias -ErrorAction SilentlyContinue
$natHostIp = ($natCfg.IPv4Address | Select-Object -First 1).IPAddress
if ($natHostIp) { Add-Pass "$NatAdapterAlias host IP: $natHostIp" }
else { Add-Warn "$NatAdapterAlias host IP" "no IPv4 on '$NatAdapterAlias' -- is the Default Switch adapter up?" }

$nodePath = Get-DedicatedNodePath
$hostIpUnresolved = -not $hostIp

# Every Test-RuleSet call below runs unconditionally: count, interface,
# protocol, port, program, and state are always checked. SkipAddress on a
# tuple narrows only that tuple's address comparison when its specific
# source IP didn't resolve - it never skips the rest of the check.
Test-RuleSet -Label 'TCP 80/443' -DisplayName 'Envoy Sandbox Proxy (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 80, 443; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
)
Test-RuleSet -Label 'DNS 53' -DisplayName 'Envoy Sandbox Proxy DNS stub (VM inbound)' -Expected @(
    @{ Protocol = 'UDP'; LocalPort = 53; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
)
Test-RuleSet -Label 'DHCP 67' -DisplayName 'Envoy Sandbox Proxy DHCP (VM inbound)' -Expected @(
    @{ Protocol = 'UDP'; LocalPort = 67; InterfaceAlias = $AdapterAlias; LocalAddress = $null }
)
Test-RuleSet -Label 'SMB 445' -DisplayName 'Configamatron share (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 445; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'TCP'; LocalPort = 445; InterfaceAlias = $NatAdapterAlias; LocalAddress = $natHostIp; SkipAddress = (-not $natHostIp) }
)
Test-RuleSet -Label 'run-proxy node.exe' -DisplayName 'Configamatron run-proxy node (VM inbound)' -Expected @(
    @{ Protocol = 'TCP'; LocalPort = 80, 443; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; Program = $nodePath; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'UDP'; LocalPort = 53; InterfaceAlias = $AdapterAlias; LocalAddress = $hostIp; Program = $nodePath; SkipAddress = $hostIpUnresolved }
    @{ Protocol = 'UDP'; LocalPort = 67; InterfaceAlias = $AdapterAlias; LocalAddress = $null; Program = $nodePath }
)

if ($hostIp) {
    $dnsListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 53 -ErrorAction SilentlyContinue
    if ($dnsListener) { Add-Pass "DNS responder listening on ${hostIp}:53" }
    else { Add-Fail "DNS responder listening on ${hostIp}:53" "not found -- is run-proxy running? guests have no other resolver" }
    $dhcpListener = Get-NetUDPEndpoint -LocalAddress $hostIp -LocalPort 67 -ErrorAction SilentlyContinue
    if ($dhcpListener) { Add-Pass "DHCP server listening on ${hostIp}:67" }
    else { Add-Fail "DHCP server listening on ${hostIp}:67" "not found -- is run-proxy running? guests cannot get an address" }
}

Write-Host ''
Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS (all cases including the new one)

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: format/lint/typecheck/unit/build/e2e/integration all pass

- [ ] **Step 6: Commit**

```bash
git add templates/proxy/verify-proxy.ps1 tests/unit/templates.test.ts
git commit -m "feat: verify-proxy validates rule filters and state, not just DisplayName presence"
```

---

## Manual Verification (Windows host, per the design doc's Scope)

Not automated — this project's host-only scripts are verified manually at checkpoints, not by CI:

1. Run `host-allow-vm-inbound.ps1` on a Windows host with the Internal switch configured. Confirm it completes without error and `Get-NetFirewallRule` shows the expected rule counts (1 TCP, 1 DNS, 1 DHCP, 2 SMB, 3 node.exe).
2. Start `configamatron run-proxy` (forwarding enabled, the default) and confirm: no Windows firewall dialog appears; `%USERPROFILE%\.configamatron-host\run-proxy-node.exe` and its `readme.txt` exist; Ctrl-C stops it and the shell's `$LASTEXITCODE` (or `echo %ERRORLEVEL%`) reflects a clean exit.
3. Run `verify-proxy.ps1` and confirm all checks PASS, including the new host-model, stale-rule, and filter/state checks.
4. Deferred per the design doc's Scope: confirm the strong-host/no-forwarding check reports FAIL when a real adapter's weak-host-receive is enabled — only once a guest/host pair is available to test it without weakening a production host.

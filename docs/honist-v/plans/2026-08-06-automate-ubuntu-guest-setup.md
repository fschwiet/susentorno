# Automate Ubuntu Guest Setup via SSH Implementation Plan

**Goal:** Add `susentorno setup-guest-unix`, a Host-side CLI command that mounts the environment's SMB share and runs every `pre-scripts/` script on an Ubuntu guest over SSH, replacing the hand-typed steps in setup-guest.md §2–3.

**Architecture:** A handful of small, pure, independently-testable modules under `src/guestSetup/` (quoting, script discovery, fstab-line construction, mount orchestration, pre-script orchestration) sit behind one injectable `RemoteExec` seam — "run this command on the guest, get its exit code back." Production wires that seam to the real OS `ssh`/`scp` binaries via `execa`; `tests/guest/` wires it to the existing QEMU-guest test harness; unit tests wire it to an in-memory fake. `src/commands/setupGuestUnix.ts` is thin glue: prompt for inputs, resolve host IPs, call the orchestration functions, report success or failure.

**Tech Stack:** TypeScript, Commander (CLI framework already in use), `execa` (already a dependency, no new SSH library), Vitest.

## Global Constraints

- No new SSH library dependency — every remote step shells out to the OS `ssh`/`scp` client via `execa`.
- Every SSH invocation uses `-t` (pseudo-terminal) and inherited stdio, run through `bash -ic '<command>'` on the guest — no invocation is ever given piped/programmatic stdin, so the guest's login/host-key/sudo prompts always reach the user directly.
- The SMB share password is never interpolated into a command string, logged, or printed. It is written to a local temp file (mode 600) and reaches the guest via `scp` + `sudo install -m 600`.
- Every user-supplied value (share name, account name, guest username, pre-script filenames) that gets interpolated into a remote command string is POSIX-single-quoted first.
- Windows-guest automation, network isolation/reboot, and `post-scripts/` automation are explicitly out of scope for this plan.
- Follow this repo's existing patterns: `node:`-prefixed core imports, `import type { Command } from 'commander'`, flat `tests/unit/*.test.ts` layout (subdirectories only where an existing subsystem already has one, e.g. `src/runHosting/` → this plan adds `src/guestSetup/` the same way), Prettier/ESLint conventions already configured in the repo (`pnpm format`, `pnpm lint` must pass — run them before every commit in this plan).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/guestSetup/quoteForRemoteShell.ts` | POSIX single-quote escaping for values interpolated into a remote command string. |
| `src/guestSetup/listPreScripts.ts` | Reads `.susentorno/vm-shared-linux/pre-scripts/`, returns the woven scripts in run order with each one's slug (filename minus numeric prefix and `.sh`). |
| `src/guestSetup/fstabLine.ts` | Builds the idempotent (delete-then-append) `/etc/fstab` command for the cifs mount line. |
| `src/guestSetup/remoteExec.ts` | The `RemoteExec` interface, pure argv-builder functions for `ssh`/`scp`, and the production `createSshRemoteExec()` factory that wraps `execa`. |
| `src/guestSetup/mountShare.ts` | Orchestrates the 5-step mount sequence (install `cifs-utils`, deliver credentials file, mount point, fstab, `mount -a`) against a `RemoteExec`. |
| `src/guestSetup/runPreScripts.ts` | Orchestrates running every pre-script in order against a `RemoteExec`, with exact-remainder argument selection and stop-on-failure. |
| `src/cliPrompt.ts` | `promptText` (with default) and `promptMasked` (no echo) — both take injectable input/output streams for testability. |
| `src/commands/setupGuestUnix.ts` | Registers `susentorno setup-guest-unix`: resolves adapter IPs, prompts for inputs, wires `createSshRemoteExec`, calls `mountShare` then `runPreScripts`, reports success/failure. |
| `src/cli.ts` | Modified: registers the new command. |
| `package.json` | Modified: `"test"` script gains `&& pnpm test:guest`. |
| `testing.md`, `development.md` | Modified: guest tier is now part of the default `pnpm test` pipeline. |
| `setup-guest.md` | Modified: Ubuntu §2–3 leads with `susentorno setup-guest-unix`; manual steps become a fallback callout. |
| `tests/unit/guestSetup/*.test.ts` | Unit tests for each pure module above. |
| `tests/unit/cliPrompt.test.ts` | Unit tests for `promptText`/`promptMasked` against injected streams. |
| `tests/unit/commands/setupGuestUnix.test.ts` | Option-surface test (mirrors `tests/unit/commands/runHosting.test.ts`). |
| `tests/cli/setupGuestUnix.test.ts` | Packaged-CLI test: fails fast with no prompts when an adapter alias doesn't exist. |
| `tests/guest/guest.test.ts` | Modified: new coverage driving `runPreScripts` against the real QEMU guest through the harness-backed `RemoteExec`. |

---

## Task 1: Fold the guest test tier into `pnpm test`

This is a small, independent config/docs change — not code, so it has no red/green test cycle. Do it first since it's quick and unblocks the later tasks' new `tests/guest/` coverage actually running by default.

**Files:**

- Modify: `package.json`
- Modify: `testing.md`
- Modify: `development.md`

- [ ] **Step 1: Update `package.json`'s `test` script**

In `package.json`, change:

```json
    "test": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli && pnpm test:proxy-stack",
```

to:

```json
    "test": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli && pnpm test:proxy-stack && pnpm test:guest",
```

- [ ] **Step 2: Update testing.md's "Default verification pipeline" section**

Replace:

```markdown
## Default verification pipeline

`pnpm test` runs formatting, linting, type checking, the `unit` tier, a production build, the `cli` tier, and the `proxy-stack` tier in fail-fast order. The Verification Pipeline section of [development.md](development.md) is the source of truth for the exact step order.

The `guest` tier is not part of `pnpm test`. Run it separately with `pnpm test:guest` when changing `templates/vm-shared-linux/` or proxy configuration. Guest boots and reboots take minutes.
```

with:

```markdown
## Default verification pipeline

`pnpm test` runs formatting, linting, type checking, the `unit` tier, a production build, the `cli` tier, the `proxy-stack` tier, and the `guest` tier, in fail-fast order. The Verification Pipeline section of [development.md](development.md) is the source of truth for the exact step order.

The `guest` tier's WSL2/QEMU prerequisites (see [development.md](development.md)) are therefore required for any full `pnpm test` run, not just for working on `templates/vm-shared-linux/` directly. Guest boots and reboots take minutes — expect `pnpm test` to be slow.
```

- [ ] **Step 3: Update development.md's "Verification pipeline" table and surrounding text**

Replace:

```markdown
| 8 | `pnpm test:guest` | Guest tests (QEMU in WSL2) — run when touching `templates/vm-shared-linux/` or proxy config; **not** part of `pnpm test` |

See [testing.md](testing.md) for what each tier's test surface is, how to choose the tier for a new test, and each tier's prerequisites.

Run the full pipeline (steps 1–7) in one command:
```

with:

```markdown
| 8 | `pnpm test:guest` | Guest tests (QEMU in WSL2) |

See [testing.md](testing.md) for what each tier's test surface is, how to choose the tier for a new test, and each tier's prerequisites.

Run the full pipeline (steps 1–8) in one command:
```

- [ ] **Step 4: Verify**

Run: `grep -n '"test":' package.json`
Expected: the printed line ends with `&& pnpm test:guest"`.

- [ ] **Step 5: Commit**

```bash
git add package.json testing.md development.md
git commit -m "test: fold the guest tier into pnpm test now that CI is gone"
```

---

## Task 2: `quoteForRemoteShell`

**Files:**

- Create: `src/guestSetup/quoteForRemoteShell.ts`
- Test: `tests/unit/guestSetup/quoteForRemoteShell.test.ts`

**Interfaces:**

- Produces: `quoteForRemoteShell(value: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/quoteForRemoteShell.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { quoteForRemoteShell } from '../../../src/guestSetup/quoteForRemoteShell';

describe('quoteForRemoteShell', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteForRemoteShell('vm-shared-linux')).toBe("'vm-shared-linux'");
  });

  it('escapes an embedded single quote', () => {
    expect(quoteForRemoteShell("O'Brien")).toBe("'O'\\''Brien'");
  });

  it('escapes multiple embedded single quotes', () => {
    expect(quoteForRemoteShell("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('leaves other shell metacharacters untouched, since single-quoting neutralizes them', () => {
    expect(quoteForRemoteShell('a; rm -rf / $(whoami) `id` & | > <')).toBe(
      "'a; rm -rf / $(whoami) `id` & | > <'",
    );
  });

  it('handles an empty string', () => {
    expect(quoteForRemoteShell('')).toBe("''");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/quoteForRemoteShell.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/quoteForRemoteShell'`

- [ ] **Step 3: Write minimal implementation**

Create `src/guestSetup/quoteForRemoteShell.ts`:

```typescript
/**
 * POSIX single-quote a value for interpolation into a remote shell command
 * string. Every embedded `'` becomes `'\''` (close quote, escaped literal
 * quote, reopen quote) — the standard way to safely nest an arbitrary string
 * inside single quotes in sh/bash.
 */
export function quoteForRemoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/quoteForRemoteShell.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/quoteForRemoteShell.ts tests/unit/guestSetup/quoteForRemoteShell.test.ts
git commit -m "feat(guest-setup): add quoteForRemoteShell"
```

---

## Task 3: `listPreScripts`

**Files:**

- Create: `src/guestSetup/listPreScripts.ts`
- Test: `tests/unit/guestSetup/listPreScripts.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export interface PreScript {
    path: string;
    filename: string;
    slug: string;
  }
  export function listPreScripts(dir: string): PreScript[];
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/listPreScripts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPreScripts } from '../../../src/guestSetup/listPreScripts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'list-pre-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function touch(name: string) {
  writeFileSync(join(dir, name), '');
}

describe('listPreScripts', () => {
  it('returns scripts in numeric-prefix order with the extension-stripped slug', () => {
    touch('02-install-pnpm.sh');
    touch('01-apt-packages.sh');
    touch('05-configure-network.sh');
    const scripts = listPreScripts(dir);
    expect(scripts.map((s) => s.filename)).toEqual([
      '01-apt-packages.sh',
      '02-install-pnpm.sh',
      '05-configure-network.sh',
    ]);
    expect(scripts.map((s) => s.slug)).toEqual(['apt-packages', 'install-pnpm', 'configure-network']);
    expect(scripts[0].path).toBe(join(dir, '01-apt-packages.sh'));
  });

  it('ignores files that are not NN-name.sh', () => {
    touch('01-apt-packages.sh');
    touch('README.md');
    touch('nn-configure-network.sh'); // unwoven sentinel form — should not appear
    touch('1-bad.sh'); // single-digit prefix
    const scripts = listPreScripts(dir);
    expect(scripts.map((s) => s.filename)).toEqual(['01-apt-packages.sh']);
  });

  it('returns an empty array for a directory with no matching scripts', () => {
    touch('README.md');
    expect(listPreScripts(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/listPreScripts.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/listPreScripts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/guestSetup/listPreScripts.ts`:

```typescript
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PreScript {
  path: string;
  filename: string;
  slug: string;
}

// Matches the woven output shape update-shares always produces: a two-digit
// prefix, a hyphen, and a .sh extension (see src/weaveScripts.ts's renumber(),
// which builds output names as `${NN}-${remainder}` and always uses '-').
const PRE_SCRIPT_NAME_RE = /^(\d{2})-(.+)\.sh$/;

export function listPreScripts(dir: string): PreScript[] {
  return readdirSync(dir)
    .filter((name) => PRE_SCRIPT_NAME_RE.test(name))
    .sort()
    .map((filename) => {
      const match = PRE_SCRIPT_NAME_RE.exec(filename)!;
      return { path: join(dir, filename), filename, slug: match[2] };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/listPreScripts.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/listPreScripts.ts tests/unit/guestSetup/listPreScripts.test.ts
git commit -m "feat(guest-setup): add listPreScripts"
```

---

## Task 4: `fstabLine`

**Files:**

- Create: `src/guestSetup/fstabLine.ts`
- Test: `tests/unit/guestSetup/fstabLine.test.ts`

**Interfaces:**

- Consumes: `quoteForRemoteShell(value: string): string` from Task 2.
- Produces:
  ```typescript
  export interface FstabReplaceOptions {
    shareName: string;
    defaultSwitchHostIp: string;
  }
  export function buildFstabReplaceCommand(opts: FstabReplaceOptions): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/fstabLine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildFstabReplaceCommand } from '../../../src/guestSetup/fstabLine';

describe('buildFstabReplaceCommand', () => {
  it('deletes any existing line for the mount point, then appends the correct one', () => {
    const command = buildFstabReplaceCommand({
      shareName: 'vm-shared-linux',
      defaultSwitchHostIp: '172.28.128.1',
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
      defaultSwitchHostIp: '172.28.128.1',
    });
    expect(command).toContain("/mnt/share'\\''name");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/fstabLine.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/fstabLine'`

- [ ] **Step 3: Write minimal implementation**

Create `src/guestSetup/fstabLine.ts`:

```typescript
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface FstabReplaceOptions {
  shareName: string;
  defaultSwitchHostIp: string;
}

/**
 * Idempotent /etc/fstab update for the cifs mount line: delete any existing
 * line for this mount point (matched by [[:space:]]-bounded field, so it
 * can't false-positive on a longer directory name), then append the correct
 * line fresh. Safe both for a same-content rerun and for a rerun after the
 * Default-Switch host IP changed across a host reboot — either way this
 * converges on one correct line, unlike a plain `tee -a`.
 */
export function buildFstabReplaceCommand(opts: FstabReplaceOptions): string {
  const mountPoint = `/mnt/${opts.shareName}`;
  const fstabLine =
    `//${opts.defaultSwitchHostIp}/${opts.shareName} ${mountPoint} cifs ` +
    `ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount 0 0`;
  // '#' as the sed delimiter avoids escaping the '/' characters in mountPoint.
  const deleteScript = `\\#[[:space:]]${mountPoint}[[:space:]]#d`;
  return (
    `sudo sed -i ${quoteForRemoteShell(deleteScript)} /etc/fstab && ` +
    `echo ${quoteForRemoteShell(fstabLine)} | sudo tee -a /etc/fstab > /dev/null`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/fstabLine.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/fstabLine.ts tests/unit/guestSetup/fstabLine.test.ts
git commit -m "feat(guest-setup): add buildFstabReplaceCommand"
```

---

## Task 5: `remoteExec` — `RemoteExec` interface, argv builders, and the SSH factory

**Files:**

- Create: `src/guestSetup/remoteExec.ts`
- Test: `tests/unit/guestSetup/remoteExec.test.ts`

**Interfaces:**

- Consumes: `quoteForRemoteShell(value: string): string` from Task 2.
- Produces:
  ```typescript
  export interface RemoteExecResult {
    exitCode: number;
  }
  export interface RemoteExec {
    run(remoteCommand: string): Promise<RemoteExecResult>;
    copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult>;
  }
  export interface SshTarget {
    address: string;
    username: string;
  }
  export function buildSshRunArgv(target: SshTarget, remoteCommand: string): string[];
  export function buildScpArgv(target: SshTarget, localPath: string, remoteDestPath: string): string[];
  export function createSshRemoteExec(target: SshTarget): RemoteExec;
  ```

Only `buildSshRunArgv` and `buildScpArgv` are unit tested here — they're pure. `createSshRemoteExec` is a thin `execa` wrapper with no dedicated unit test (this codebase has no execa-mocking precedent); it's exercised for real by `tests/guest/` (Task 10) and by manually running the finished command against a real guest.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/remoteExec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSshRunArgv, buildScpArgv } from '../../../src/guestSetup/remoteExec';

describe('buildSshRunArgv', () => {
  it('wraps the command in bash -ic with -t and the quoted command as one argv element', () => {
    const argv = buildSshRunArgv({ address: '192.168.1.50', username: 'ubuntu' }, 'echo hi');
    expect(argv).toEqual(['-t', 'ubuntu@192.168.1.50', 'bash', '-ic', "'echo hi'"]);
  });

  it('escapes a single quote inside the command', () => {
    const argv = buildSshRunArgv({ address: 'host', username: 'ubuntu' }, "echo 'hi'");
    expect(argv[4]).toBe("'echo '\\''hi'\\'''");
  });
});

describe('buildScpArgv', () => {
  it('builds a local-path to user@host:remote-path argv', () => {
    const argv = buildScpArgv(
      { address: '192.168.1.50', username: 'ubuntu' },
      '/tmp/local-file',
      '/tmp/remote-file',
    );
    expect(argv).toEqual(['/tmp/local-file', 'ubuntu@192.168.1.50:/tmp/remote-file']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/remoteExec.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/remoteExec'`

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/remoteExec.ts`:

```typescript
import { execa } from 'execa';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RemoteExecResult {
  exitCode: number;
}

/**
 * Injectable seam for "run this command on the guest and get its exit code
 * back." Production wires this to real ssh/scp (createSshRemoteExec, below);
 * tests/guest/ wires it to the existing QEMU-guest harness; unit tests wire
 * it to an in-memory fake. mountShare and runPreScripts are written once
 * against this interface.
 */
export interface RemoteExec {
  run(remoteCommand: string): Promise<RemoteExecResult>;
  copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult>;
}

export interface SshTarget {
  address: string;
  username: string;
}

/**
 * ssh joins trailing argv elements with a plain space and sends the result
 * to the remote shell as one string — it does not preserve argv boundaries
 * over the wire. remoteCommand must therefore already be a single,
 * shell-quoted argument by the time it reaches `bash -ic`, or bash -c would
 * treat only the first word as the script and the rest as positional
 * parameters.
 */
export function buildSshRunArgv(target: SshTarget, remoteCommand: string): string[] {
  return ['-t', `${target.username}@${target.address}`, 'bash', '-ic', quoteForRemoteShell(remoteCommand)];
}

export function buildScpArgv(target: SshTarget, localPath: string, remoteDestPath: string): string[] {
  return [localPath, `${target.username}@${target.address}:${remoteDestPath}`];
}

export function createSshRemoteExec(target: SshTarget): RemoteExec {
  return {
    async run(remoteCommand: string): Promise<RemoteExecResult> {
      const result = await execa('ssh', buildSshRunArgv(target, remoteCommand), {
        stdio: 'inherit',
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1 };
    },
    async copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult> {
      const result = await execa('scp', buildScpArgv(target, localPath, remoteDestPath), {
        stdio: 'inherit',
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1 };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/remoteExec.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/remoteExec.ts tests/unit/guestSetup/remoteExec.test.ts
git commit -m "feat(guest-setup): add RemoteExec interface, argv builders, and the SSH factory"
```

---

## Task 6: `mountShare`

**Files:**

- Create: `src/guestSetup/mountShare.ts`
- Test: `tests/unit/guestSetup/mountShare.test.ts`

**Interfaces:**

- Consumes:
  - `RemoteExec`, `RemoteExecResult` from Task 5.
  - `quoteForRemoteShell(value: string): string` from Task 2.
  - `buildFstabReplaceCommand(opts: FstabReplaceOptions): string` from Task 4.
- Produces:
  ```typescript
  export interface MountShareOptions {
    shareName: string;
    accountName: string;
    password: string;
    defaultSwitchHostIp: string;
  }
  export class MountShareError extends Error {
    readonly step: string;
  }
  export async function mountShare(remoteExec: RemoteExec, opts: MountShareOptions): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/mountShare.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import { mountShare, MountShareError } from '../../../src/guestSetup/mountShare';

function fakeRemoteExec(overrides: {
  runResults?: Record<string, number>;
  copyResult?: number;
} = {}): { remoteExec: RemoteExec; calls: string[]; copiedFiles: [string, string][] } {
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
      defaultSwitchHostIp: '172.28.128.1',
    });

    expect(calls[0]).toBe('sudo apt-get install -y cifs-utils');
    expect(copiedFiles).toHaveLength(1);
    expect(calls.some((c) => c.includes('sudo install -m 600') && c.includes('/etc/susentorno-share.cred'))).toBe(
      true,
    );
    expect(calls.some((c) => c.includes('sudo mkdir -p') && c.includes('/mnt/vm-shared-linux'))).toBe(true);
    expect(calls.some((c) => c.includes('/etc/fstab'))).toBe(true);
    expect(calls[calls.length - 1]).toBe('sudo systemctl daemon-reload && sudo mount -a');
  });

  it('writes the credentials file locally with the account name and password, then deletes it', async () => {
    const { remoteExec, copiedFiles } = fakeRemoteExec();
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      defaultSwitchHostIp: '172.28.128.1',
    });
    const [localPath] = copiedFiles[0];
    expect(existsSync(localPath)).toBe(false); // cleaned up after the run
    // Re-derive what would have been written, since the temp file is gone by
    // the time the test can inspect it: assert via a spy instead.
    void readFileSync; // (imported for symmetry with other tests in this suite; unused here)
  });

  it('stops at the first failing step and reports which one', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ runResults: { 'cifs-utils': 1 } });
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        defaultSwitchHostIp: '172.28.128.1',
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
        defaultSwitchHostIp: '172.28.128.1',
      }),
    ).rejects.toThrow(MountShareError);
    expect(calls.some((c) => c.includes('sudo install -m 600'))).toBe(false);
  });
});
```

Note: the second test above is intentionally light — the local temp credentials file is deleted before the test can inspect its contents (by design, so the secret doesn't linger on disk). Step 3 rewrites this test to properly verify the file's contents by capturing them before cleanup, via a small seam. Read on.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/mountShare.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/mountShare'`

- [ ] **Step 3: Replace the weak second test with one that verifies file contents, then write the implementation**

Replace the `'writes the credentials file locally...'` test in `tests/unit/guestSetup/mountShare.test.ts` with:

```typescript
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
      defaultSwitchHostIp: '172.28.128.1',
    });
    expect(capturedContents).toBe('username=susentorno-share\npassword=hunter2\n');
    expect(existsSync(capturedLocalPath)).toBe(false); // deleted after mountShare returns
  });
```

(This reads the file from inside the fake `copyFile`, i.e. before `mountShare`'s `finally` block deletes it — the same moment the real `scp` would read it.)

Create `src/guestSetup/mountShare.ts`:

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
  defaultSwitchHostIp: string;
}

export class MountShareError extends Error {
  readonly step: string;
  constructor(step: string, exitCode: number) {
    super(`mountShare: '${step}' exited with code ${exitCode}`);
    this.step = step;
  }
}

async function runStep(remoteExec: RemoteExec, step: string, command: string): Promise<void> {
  const { exitCode } = await remoteExec.run(command);
  if (exitCode !== 0) throw new MountShareError(step, exitCode);
}

export async function mountShare(remoteExec: RemoteExec, opts: MountShareOptions): Promise<void> {
  await runStep(remoteExec, 'install cifs-utils', 'sudo apt-get install -y cifs-utils');

  const suffix = randomBytes(8).toString('hex');
  const localTempPath = join(tmpdir(), `susentorno-share-cred-${suffix}`);
  const remoteTempPath = `/tmp/susentorno-share-cred-${suffix}`;
  writeFileSync(localTempPath, `username=${opts.accountName}\npassword=${opts.password}\n`, {
    mode: 0o600,
  });
  try {
    const { exitCode: copyExitCode } = await remoteExec.copyFile(localTempPath, remoteTempPath);
    if (copyExitCode !== 0) throw new MountShareError('copy credentials file', copyExitCode);

    await runStep(
      remoteExec,
      'install credentials file',
      `sudo install -m 600 -o root -g root ${quoteForRemoteShell(remoteTempPath)} ` +
        `/etc/susentorno-share.cred && rm -f ${quoteForRemoteShell(remoteTempPath)}`,
    );
  } finally {
    rmSync(localTempPath, { force: true });
  }

  const mountPoint = `/mnt/${opts.shareName}`;
  await runStep(
    remoteExec,
    'create mount point',
    `sudo mkdir -p ${quoteForRemoteShell(mountPoint)}`,
  );
  await runStep(
    remoteExec,
    'update fstab',
    buildFstabReplaceCommand({ shareName: opts.shareName, defaultSwitchHostIp: opts.defaultSwitchHostIp }),
  );
  await runStep(remoteExec, 'mount share', 'sudo systemctl daemon-reload && sudo mount -a');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/mountShare.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/mountShare.ts tests/unit/guestSetup/mountShare.test.ts
git commit -m "feat(guest-setup): add mountShare orchestration"
```

---

## Task 7: `runPreScripts`

**Files:**

- Create: `src/guestSetup/runPreScripts.ts`
- Test: `tests/unit/guestSetup/runPreScripts.test.ts`

**Interfaces:**

- Consumes:
  - `RemoteExec` from Task 5.
  - `PreScript` from Task 3.
  - `quoteForRemoteShell(value: string): string` from Task 2.
- Produces:
  ```typescript
  export interface RunPreScriptsOptions {
    scripts: PreScript[];
    shareName: string;
    internalSwitchHostIp: string;
  }
  export class RunPreScriptsError extends Error {
    readonly script: string;
  }
  export async function runPreScripts(remoteExec: RemoteExec, opts: RunPreScriptsOptions): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guestSetup/runPreScripts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import type { PreScript } from '../../../src/guestSetup/listPreScripts';
import { runPreScripts, RunPreScriptsError } from '../../../src/guestSetup/runPreScripts';

function script(filename: string, slug: string): PreScript {
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
      throw new Error('runPreScripts should never call copyFile');
    },
  };
  return { remoteExec, calls };
}

describe('runPreScripts', () => {
  it('runs every script in order from the share pre-scripts directory, with no arguments by default', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [script('01-apt-packages.sh', 'apt-packages'), script('02-install-pnpm.sh', 'install-pnpm')],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls).toEqual([
      "cd '/mnt/vm-shared-linux/pre-scripts' && ./01-apt-packages.sh",
      "cd '/mnt/vm-shared-linux/pre-scripts' && ./02-install-pnpm.sh",
    ]);
  });

  it('passes the internal-switch host IP only to the exact configure-network slug', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [
        script('01-apt-packages.sh', 'apt-packages'),
        script('05-configure-network.sh', 'configure-network'),
      ],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls[0]).toBe("cd '/mnt/vm-shared-linux/pre-scripts' && ./01-apt-packages.sh");
    expect(calls[1]).toBe(
      "cd '/mnt/vm-shared-linux/pre-scripts' && ./05-configure-network.sh '192.168.67.1'",
    );
  });

  it('does not special-case a custom script whose slug merely contains configure-network', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [script('03-preconfigure-network-tools.sh', 'preconfigure-network-tools')],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls).toEqual([
      "cd '/mnt/vm-shared-linux/pre-scripts' && ./03-preconfigure-network-tools.sh",
    ]);
  });

  it('stops at the first non-zero exit and reports which script failed', async () => {
    const { remoteExec, calls } = fakeRemoteExec((command) =>
      command.includes('02-install-pnpm.sh') ? 1 : 0,
    );
    await expect(
      runPreScripts(remoteExec, {
        scripts: [
          script('01-apt-packages.sh', 'apt-packages'),
          script('02-install-pnpm.sh', 'install-pnpm'),
          script('03-install-tools.sh', 'install-tools'),
        ],
        shareName: 'vm-shared-linux',
        internalSwitchHostIp: '192.168.67.1',
      }),
    ).rejects.toThrow(RunPreScriptsError);
    expect(calls).toHaveLength(2); // 03 never ran
  });

  it('fails fast, before running anything, if more than one script resolves to configure-network', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await expect(
      runPreScripts(remoteExec, {
        scripts: [
          script('01-configure-network.sh', 'configure-network'),
          script('02-configure-network.sh', 'configure-network'),
        ],
        shareName: 'vm-shared-linux',
        internalSwitchHostIp: '192.168.67.1',
      }),
    ).rejects.toThrow(/more than one pre-script resolves to 'configure-network'/);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/runPreScripts.test.ts`
Expected: FAIL — `Cannot find module '../../../src/guestSetup/runPreScripts'`

- [ ] **Step 3: Write the implementation**

Create `src/guestSetup/runPreScripts.ts`:

```typescript
import type { RemoteExec } from './remoteExec';
import type { PreScript } from './listPreScripts';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RunPreScriptsOptions {
  scripts: PreScript[];
  shareName: string;
  internalSwitchHostIp: string;
}

export class RunPreScriptsError extends Error {
  readonly script: string;
  constructor(script: string, exitCode: number) {
    super(`runPreScripts: '${script}' exited with code ${exitCode}`);
    this.script = script;
  }
}

const CONFIGURE_NETWORK_SLUG = 'configure-network';

export async function runPreScripts(remoteExec: RemoteExec, opts: RunPreScriptsOptions): Promise<void> {
  const matches = opts.scripts.filter((s) => s.slug === CONFIGURE_NETWORK_SLUG);
  if (matches.length > 1) {
    throw new Error(
      `runPreScripts: more than one pre-script resolves to '${CONFIGURE_NETWORK_SLUG}': ` +
        matches.map((s) => s.filename).join(', '),
    );
  }

  const remoteDir = `/mnt/${opts.shareName}/pre-scripts`;
  for (const s of opts.scripts) {
    const args = s.slug === CONFIGURE_NETWORK_SLUG ? ` ${quoteForRemoteShell(opts.internalSwitchHostIp)}` : '';
    const command = `cd ${quoteForRemoteShell(remoteDir)} && ./${s.filename}${args}`;
    const { exitCode } = await remoteExec.run(command);
    if (exitCode !== 0) throw new RunPreScriptsError(s.filename, exitCode);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guestSetup/runPreScripts.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/runPreScripts.ts tests/unit/guestSetup/runPreScripts.test.ts
git commit -m "feat(guest-setup): add runPreScripts orchestration"
```

---

## Task 8: `cliPrompt` — `promptText` and `promptMasked`

**Files:**

- Create: `src/cliPrompt.ts`
- Test: `tests/unit/cliPrompt.test.ts`

**Interfaces:**

- Produces:
  ```typescript
  export interface PromptStreams {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
  export function promptText(question: string, defaultValue?: string, streams?: PromptStreams): Promise<string>;
  export function promptMasked(question: string, streams?: PromptStreams): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cliPrompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptText, promptMasked } from '../../src/cliPrompt';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

describe('promptText', () => {
  it('returns the typed value', async () => {
    const s = streams();
    const result = promptText('Guest address', undefined, s);
    s.input.write('192.168.1.50\n');
    expect(await result).toBe('192.168.1.50');
  });

  it('returns the default when Enter is pressed with no input', async () => {
    const s = streams();
    const result = promptText('SMB share name', 'vm-shared-linux', s);
    s.input.write('\n');
    expect(await result).toBe('vm-shared-linux');
  });

  it('prints the default in the prompt text', async () => {
    const s = streams();
    const result = promptText('SMB share name', 'vm-shared-linux', s);
    s.input.write('\n');
    await result;
    expect(s.written()).toContain('vm-shared-linux');
  });
});

describe('promptMasked', () => {
  it('resolves with the typed value', async () => {
    const s = streams();
    const result = promptMasked('SMB share password', s);
    s.input.write('hunter2');
    s.input.write('\r');
    expect(await result).toBe('hunter2');
  });

  it('echoes asterisks instead of the typed characters', async () => {
    const s = streams();
    const result = promptMasked('SMB share password', s);
    s.input.write('hunter2');
    s.input.write('\r');
    await result;
    expect(s.written()).toContain('*******');
    expect(s.written()).not.toContain('hunter2');
  });

  it('handles backspace by removing the last character', async () => {
    const s = streams();
    const result = promptMasked('SMB share password', s);
    s.input.write('hunterX');
    s.input.write('\x7f'); // backspace
    s.input.write('2');
    s.input.write('\r');
    expect(await result).toBe('hunter2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/cliPrompt.test.ts`
Expected: FAIL — `Cannot find module '../../src/cliPrompt'`

- [ ] **Step 3: Write the implementation**

Create `src/cliPrompt.ts`:

```typescript
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

function defaultStreams(): PromptStreams {
  return { input: process.stdin, output: process.stdout };
}

export async function promptText(
  question: string,
  defaultValue?: string,
  streams: PromptStreams = defaultStreams(),
): Promise<string> {
  const rl = createInterface({ input: streams.input, output: streams.output });
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  rl.close();
  return answer === '' && defaultValue !== undefined ? defaultValue : answer;
}

interface Keypress {
  name?: string;
  ctrl?: boolean;
}

export function promptMasked(question: string, streams: PromptStreams = defaultStreams()): Promise<string> {
  return new Promise((resolve, reject) => {
    const { input, output } = streams;
    output.write(`${question}: `);
    let value = '';

    emitKeypressEvents(input as NodeJS.ReadStream);
    const ttyInput = input as NodeJS.ReadStream;
    const isTTY = ttyInput.isTTY === true;
    if (isTTY) ttyInput.setRawMode(true);

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (isTTY) ttyInput.setRawMode(false);
    };

    function onKeypress(str: string | undefined, key: Keypress) {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('promptMasked: cancelled'));
        return;
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        output.write('\n');
        resolve(value);
        return;
      }
      if (key?.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (str && !key?.ctrl) {
        value += str;
        output.write('*');
      }
    }

    input.on('keypress', onKeypress);
    (input as NodeJS.ReadStream).resume?.();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/cliPrompt.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cliPrompt.ts tests/unit/cliPrompt.test.ts
git commit -m "feat: add promptText and promptMasked CLI prompt helpers"
```

---

## Task 9: `setup-guest-unix` command

**Files:**

- Create: `src/commands/setupGuestUnix.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/commands/setupGuestUnix.test.ts`
- Test: `tests/cli/setupGuestUnix.test.ts`

**Interfaces:**

- Consumes:
  - `resolveForwardListenAddress(adapterName?, interfaces?): string | null` and `DEFAULT_INTERNAL_SWITCH_ADAPTER` from `src/runHosting/forwarder.ts` (existing).
  - `requireEnvPathsOrExit(commandName, cwd?): EnvPaths | null` from `src/envPaths.ts` (existing); `EnvPaths.vmShared: string` (existing field).
  - `promptText`, `promptMasked` from Task 8.
  - `listPreScripts` from Task 3.
  - `createSshRemoteExec` from Task 5.
  - `mountShare`, `MountShareError` from Task 6.
  - `runPreScripts`, `RunPreScriptsError` from Task 7.
- Produces: `registerSetupGuestUnix(program: Command): void`

- [ ] **Step 1: Write the failing test (unit-tier option surface)**

Create `tests/unit/commands/setupGuestUnix.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerSetupGuestUnix } from '../../../src/commands/setupGuestUnix';

describe('setup-guest-unix command option surface', () => {
  it('registers the command with adapter-alias overrides and sensible defaults', () => {
    const program = new Command();
    registerSetupGuestUnix(program);
    const command = program.commands.find((cmd) => cmd.name() === 'setup-guest-unix');
    expect(command).toBeDefined();

    const adapterOption = command!.options.find((o) => o.flags.includes('--adapter-alias'));
    expect(adapterOption?.defaultValue).toBe('vEthernet (susentorno-internal)');

    const natAdapterOption = command!.options.find((o) => o.flags.includes('--nat-adapter-alias'));
    expect(natAdapterOption?.defaultValue).toBe('vEthernet (Default Switch)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/commands/setupGuestUnix.test.ts`
Expected: FAIL — `Cannot find module '../../../src/commands/setupGuestUnix'`

- [ ] **Step 3: Write the implementation**

Create `src/commands/setupGuestUnix.ts`:

```typescript
import { join } from 'node:path';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { resolveForwardListenAddress, DEFAULT_INTERNAL_SWITCH_ADAPTER } from '../runHosting/forwarder';
import { promptText, promptMasked } from '../cliPrompt';
import { listPreScripts } from '../guestSetup/listPreScripts';
import { createSshRemoteExec } from '../guestSetup/remoteExec';
import { mountShare, MountShareError } from '../guestSetup/mountShare';
import { runPreScripts, RunPreScriptsError } from '../guestSetup/runPreScripts';

const DEFAULT_NAT_ADAPTER = 'vEthernet (Default Switch)';

interface SetupGuestUnixOptions {
  adapterAlias: string;
  natAdapterAlias: string;
}

export function registerSetupGuestUnix(program: Command): void {
  program
    .command('setup-guest-unix')
    .description(
      'Mount this environment\'s SMB share and run every pre-scripts/ script on an Ubuntu guest over SSH. ' +
        'A failed run is safe to retry for the built-in scripts; a woven-in custom pre-script must be ' +
        'idempotent itself for a retry to be safe, the same responsibility you already have when authoring one.',
    )
    .option('--adapter-alias <name>', 'Internal-switch adapter', DEFAULT_INTERNAL_SWITCH_ADAPTER)
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .action(async (options: SetupGuestUnixOptions) => {
      const paths = requireEnvPathsOrExit('setup-guest-unix');
      if (!paths) return;

      const internalSwitchHostIp = resolveForwardListenAddress(options.adapterAlias);
      if (!internalSwitchHostIp) {
        console.error(
          `setup-guest-unix: could not find an IPv4 address on adapter '${options.adapterAlias}'. ` +
            'Pass --adapter-alias, or complete setup-machine.md first.',
        );
        process.exitCode = 1;
        return;
      }
      const defaultSwitchHostIp = resolveForwardListenAddress(options.natAdapterAlias);
      if (!defaultSwitchHostIp) {
        console.error(
          `setup-guest-unix: could not find an IPv4 address on adapter '${options.natAdapterAlias}'. ` +
            'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
        );
        process.exitCode = 1;
        return;
      }

      const address = await promptText('Guest address (hostname or IP)');
      const username = await promptText('Guest username');
      const shareName = await promptText('SMB share name', 'vm-shared-linux');
      const accountName = await promptText('Share account name', 'susentorno-share');
      const password = await promptMasked('SMB share password');

      const scripts = listPreScripts(join(paths.vmShared, 'pre-scripts'));
      const remoteExec = createSshRemoteExec({ address, username });

      try {
        await mountShare(remoteExec, { shareName, accountName, password, defaultSwitchHostIp });
        await runPreScripts(remoteExec, { scripts, shareName, internalSwitchHostIp });
      } catch (error) {
        if (error instanceof MountShareError || error instanceof RunPreScriptsError) {
          console.error(`setup-guest-unix: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      console.log('setup-guest-unix: mount and pre-scripts/ completed on the guest.');
    });
}
```

Modify `src/cli.ts` — add the import alongside the others:

```typescript
import { registerSetupGuestUnix } from './commands/setupGuestUnix';
```

and the registration call alongside the others:

```typescript
registerSetupGuestUnix(program);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/commands/setupGuestUnix.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Write the failing test (cli-tier fail-fast behavior)**

Create `tests/cli/setupGuestUnix.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'susentorno-setup-guest-unix-'));
  await execa('node', [cliPath, 'init'], { cwd: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('susentorno setup-guest-unix', () => {
  it('fails fast with no prompts when the internal-switch adapter does not exist', async () => {
    const { exitCode, stderr, stdout } = await execa(
      'node',
      [cliPath, 'setup-guest-unix', '--adapter-alias', 'does-not-exist-adapter'],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not find an IPv4 address on adapter 'does-not-exist-adapter'");
    expect(stdout).not.toContain('Guest address'); // never reached the prompts
  });

  it('fails fast when the NAT adapter does not exist, even if the internal-switch one does', async () => {
    const { exitCode, stderr } = await execa(
      'node',
      [
        cliPath,
        'setup-guest-unix',
        '--adapter-alias',
        'Loopback Pseudo-Interface 1',
        '--nat-adapter-alias',
        'does-not-exist-nat-adapter',
      ],
      { cwd: dir, reject: false, input: '' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not find an IPv4 address on adapter 'does-not-exist-nat-adapter'");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run --config vitest.cli.config.ts tests/cli/setupGuestUnix.test.ts`
Expected: FAIL — the command doesn't exist yet in the built CLI (this should already be fixed by Step 3/4's implementation; if it fails here it means `pnpm build` wasn't run since adding the command — rerun `pnpm build` first, then re-run this test to confirm it now passes instead of failing for the wrong reason. If it still fails, the second test's `'Loopback Pseudo-Interface 1'` adapter name doesn't exist on this machine — replace it with an adapter name confirmed present via `Get-NetIPConfiguration` on the dev machine, or simplify that test to only assert the first (`--adapter-alias`) failure case.)

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run --config vitest.cli.config.ts tests/cli/setupGuestUnix.test.ts`
Expected: PASS (2 tests, adjusting the second test's adapter name per Step 6's note if needed for the machine running it)

- [ ] **Step 8: Commit**

```bash
git add src/commands/setupGuestUnix.ts src/cli.ts tests/unit/commands/setupGuestUnix.test.ts tests/cli/setupGuestUnix.test.ts
git commit -m "feat: add susentorno setup-guest-unix command"
```

---

## Task 10: `tests/guest/` coverage for the real orchestration

**Files:**

- Modify: `tests/guest/guest.test.ts`

**Interfaces:**

- Consumes: `RemoteExec`, `RemoteExecResult` from Task 5; `listPreScripts` from Task 3; `runPreScripts` from Task 7; the existing `guest()` helper and `envRoot` already defined in `guest.test.ts`.

This drives the real `runPreScripts` orchestration against the real QEMU guest, through a small adapter that reuses the file's existing `guest()` helper (which already shells into the guest via the harness's own SSH). It's scoped to the `configure-network` script only — proving exact-remainder argument selection and the remote-command construction against a real guest — rather than the full 01-04 chain, which installs heavy real-world tooling (pnpm, VS Code, the .NET SDK) that no test in this file exercises today and that would make this one test dramatically slower and network-flakier than the rest of the suite for marginal additional coverage (ordering and stop-on-failure are already covered by the unit tests in Task 7's `runPreScripts.test.ts`).

- [ ] **Step 1: Add the harness-backed `RemoteExec` adapter and import the new modules**

In `tests/guest/guest.test.ts`, add to the imports near the top (after the existing `import { envRoot } from '../testEnvRoot';` line):

```typescript
import { join } from 'node:path';
import type { RemoteExec, RemoteExecResult } from '../../src/guestSetup/remoteExec';
import { listPreScripts } from '../../src/guestSetup/listPreScripts';
import { runPreScripts } from '../../src/guestSetup/runPreScripts';
```

Add this helper near the existing `function guest(name, cmd)` helper (around line 36):

```typescript
// Adapts the harness's existing guest() SSH helper to the RemoteExec
// interface, so the production orchestration logic (runPreScripts) can run
// unmodified against a real guest. guest() rejects on a non-zero remote exit
// (execa's default), so the exit code is captured in-band instead, the same
// way guestProbe() above already does for curl's exit code.
function harnessRemoteExec(name: string): RemoteExec {
  return {
    async run(command: string): Promise<RemoteExecResult> {
      const { stdout } = await guest(name, `${command} ; echo "SUSENTORNO_EXIT=$?"`);
      const match = /SUSENTORNO_EXIT=(\d+)/.exec(stdout);
      return { exitCode: match ? Number(match[1]) : 1 };
    },
    async copyFile(): Promise<RemoteExecResult> {
      throw new Error('harnessRemoteExec.copyFile is not exercised by this suite');
    },
  };
}
```

- [ ] **Step 2: Add the test**

In the `describe('provisioning during the setup phase', ...)` block, add a new test right before the existing `'runs 05-configure-network.sh from the VM share'` test:

```typescript
  it('runs configure-network through runPreScripts, passing the internal-switch host IP', async () => {
    const scripts = listPreScripts(join(envRoot, 'vm-shared-linux', 'pre-scripts'));
    const configureNetworkOnly = scripts.filter((s) => s.slug === 'configure-network');
    expect(configureNetworkOnly).toHaveLength(1);

    await runPreScripts(harnessRemoteExec('g1'), {
      scripts: configureNetworkOnly,
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: BRIDGE_IP,
    });

    const { stdout } = await guest(
      'g1',
      'test -f /usr/local/share/ca-certificates/susentorno-proxy-certificate-authority.crt && echo present',
    );
    expect(stdout.trim()).toBe('present');
  });
```

- [ ] **Step 3: Run the guest suite to verify the new test passes**

Run: `pnpm test:guest`
Expected: PASS, including the new test (the whole suite takes several minutes — see testing.md's guest-tier prerequisites in development.md if this is the first run on this machine)

- [ ] **Step 4: Commit**

```bash
git add tests/guest/guest.test.ts
git commit -m "test(guest): exercise runPreScripts against a real QEMU guest"
```

---

## Task 11: Update setup-guest.md

**Files:**

- Modify: `setup-guest.md`

- [ ] **Step 1: Rewrite the Ubuntu path in §2–3 to lead with the new command**

In `setup-guest.md`, replace the Ubuntu-specific content of "## 2. Configure the guest network and mount the share" (everything from `**Ubuntu guest**` through the paragraph ending "...the numbered scripts run from there.") and the Ubuntu bullet under "## 3. Run the numbered scripts" with:

```markdown
**Ubuntu guest** — leave the interface on **DHCP**; the installer's default configuration is already correct. Install `openssh-server` (there is no network path into the guest before this exists — everything after it is automated):

```bash
sudo apt update -y && sudo apt install -y openssh-server
```

Then, from the Host, run the environment's setup command, which mounts the share and runs every `pre-scripts/` script in order over SSH:

```powershell
susentorno setup-guest-unix
```

It prompts for the guest's address, username, the SMB share/account names (defaulting to this environment's `vm-shared-linux` / `susentorno-share`), and the share password from setup-environment.md. It stops before network isolation — continue to "Isolate" below once it finishes.

<details>
<summary>Manual fallback (for diagnosing a failure, or to see exactly what the command does)</summary>

With `openssh-server` installed you can open an ssh shell to make copying and pasting easier:

```
ssh <username>@<vm-name>
```

For the following commands, replace `<the password from setup-environment.md>`. Special characters don't need to be escaped — the heredoc interpreter is only watching for an `EOF`.

```bash
sudo apt install -y cifs-utils

# Credentials file, readable only by root:
sudo tee /etc/susentorno-share.cred > /dev/null << 'EOF'
username=susentorno-share
password=<the password from setup-environment.md>
EOF
sudo chmod 600 /etc/susentorno-share.cred

sudo mkdir -p /mnt/vm-shared-linux
# /etc/fstab — auto-mounts at boot so the credentials symlink resolves:
echo '//192.168.67.1/vm-shared-linux  /mnt/vm-shared-linux  cifs  ro,credentials=/etc/susentorno-share.cred,uid=1000,gid=1000,_netdev,x-systemd.automount  0  0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
```

Use the **Default Switch** host IP in that `fstab` line during the NAT phase and the Internal-switch host IP afterwards. The share then lives at `/mnt/vm-shared-linux` — the numbered scripts run from there. `cd` into `pre-scripts/` and run every script in number order; the last is `05-configure-network.sh <host-ip>` when there are no custom scripts, where `<host-ip>` is the Internal-switch host IP from setup-machine.md.

</details>
```

Leave the Windows-guest content in both sections unchanged.

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `pnpm exec prettier --check setup-guest.md`
Expected: no formatting errors (this repo's `pnpm format`/`format:check` scripts run Prettier over the whole tree, including Markdown; this checks just the changed file)

- [ ] **Step 3: Commit**

```bash
git add setup-guest.md
git commit -m "docs: point setup-guest.md's Ubuntu path at susentorno setup-guest-unix"
```

---

## Self-Review Notes

- **Spec coverage**: every spec section has a task — Command/Inputs/SSH mechanism → Tasks 5, 8, 9; Mount step → Tasks 4, 6; Running pre-scripts → Tasks 3, 7; Testing → Tasks 2–10 collectively (unit coverage per module, `tests/guest/` in Task 10); `pnpm test` guest tier → Task 1; Documentation → Task 11. Out-of-scope items (Windows guest, isolation/reboot/post-scripts automation, a persisted guest registry) have deliberately no task.
- **Type/name consistency checked**: `RemoteExec`/`RemoteExecResult` (Task 5) are the exact types consumed by Tasks 6, 7, 9, 10. `PreScript`/`listPreScripts` (Task 3) match what Tasks 7, 9, 10 import. `MountShareError`/`RunPreScriptsError` (Tasks 6, 7) are the exact classes Task 9 catches. `paths.vmShared` (existing `EnvPaths` field) is used, not the unrelated existing `paths.preScripts` field (which points at `.susentorno/pre-scripts/`, the customization-input directory, not the woven output).

## Peer Review Notes

Reviewed by `prompt-a-peer-medium` against this plan and the spec it implements (`docs/honist-v/specs/2026-08-06-automate-ubuntu-guest-setup-design.md`). [Filled in after the peer review step below.]

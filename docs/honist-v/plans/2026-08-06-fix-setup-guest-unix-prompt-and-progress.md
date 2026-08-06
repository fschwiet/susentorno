# Fix `setup-guest-unix`'s Stdin Handoff and Add Step Progress Implementation Plan

**Goal:** Fix the bug where `setup-guest-unix` silently swallows the guest's SSH password (leaving the user staring at a blank console with no way to tell whether it's stuck), and add step-by-step progress output so a long-running `mountShare`/`runPreScripts` run is never silent.

**Architecture:** Two fixes, independent in code but done in this order for delivery reasons — the second is only useful to a real user once the first stops the run from stalling before any progress can print. (1) `promptMasked` (`src/cliPrompt.ts`) explicitly releases `process.stdin` (`input.pause()`) after it finishes reading the masked SMB share password, so the `ssh` child process spawned immediately afterward (`stdio: 'inherit'`) can read the console for its own login prompt instead of racing Node for it. `write-github-config`'s separate hand-rolled prompt is folded onto the same shared `promptText` helper while we're in `cliPrompt.ts`, for consistency — it isn't affected by the bug (it never uses raw mode) but currently duplicates the same job. (2) `mountShare` and `runPreScripts` (`src/guestSetup/`) gain an optional, injectable `onStep` callback, matching the existing `RemoteExec` seam pattern, so `setup-guest-unix` can print a message before every step instead of only at the very end.

**Tech Stack:** TypeScript, Vitest. No new dependencies — see [[promptmasked-releases-stdin-explicitly]] (ADR-0022) for why a third-party prompt library was rejected.

## Global Constraints

- No new dependency for interactive prompting. `promptMasked`/`promptText` stay hand-rolled `node:readline`/`emitKeypressEvents`-based implementations (per ADR-0022).
- `promptMasked`'s exported signature and its injectable `PromptStreams` (`input`/`output`) do not change — only its internal cleanup path gains one call.
- The actual real-world effect of the stdin fix (that a subsequently-spawned `ssh` can read the console) cannot be verified by any test tier in this repo — the same limitation the original plan already accepted for `createSshRemoteExec` itself. It is verified only by manually re-running `setup-guest-unix` against a real guest; that manual run is a required task in this plan, not optional follow-up.
- `onStep` messages are plain step labels/filenames only — never remote command strings (which can contain credential file paths) and never the SMB password itself.
- Follow this repo's existing patterns: flat `tests/unit/**/*.test.ts` layout mirroring `src/`, Prettier/ESLint conventions already configured (`pnpm format`, `pnpm lint` must pass — run them before every commit in this plan).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/adr/0022-promptmasked-releases-stdin-explicitly.md` | Already written; committed as part of Task 1. |
| `src/cliPrompt.ts` | Modified: `promptMasked`'s cleanup now calls `input.pause()` unconditionally. |
| `tests/unit/cliPrompt.test.ts` | Modified: new `promptMasked` tests asserting `pause()` is called after a normal submit and after a cancellation. |
| `src/commands/writeGithubConfig.ts` | Modified: replaces its own hand-rolled `readline` prompt with the shared `promptText`. |
| `src/guestSetup/mountShare.ts` | Modified: `MountShareOptions` gains an optional `onStep?: (message: string) => void`, called before each of the 6 network operations. |
| `tests/unit/guestSetup/mountShare.test.ts` | Modified: new test asserting `onStep` fires with the right labels, in order. |
| `src/guestSetup/runPreScripts.ts` | Modified: `RunPreScriptsOptions` gains the same `onStep?: (message: string) => void`, called before each script runs. |
| `tests/unit/guestSetup/runPreScripts.test.ts` | Modified: new test asserting `onStep` fires with each script's filename, in order. |
| `src/commands/setupGuestUnix.ts` | Modified: wires `onStep: (message) => console.log(...)` into both `mountShare` and `runPreScripts` calls. |

---

## Task 1: Record ADR-0022

This is a docs-only change with no red/green cycle — do it first so the reasoning behind Task 2 is committed before the code that implements it.

**Files:**

- Already created: `docs/adr/0022-promptmasked-releases-stdin-explicitly.md`

- [ ] **Step 1: Verify the ADR is in place**

Run: `ls docs/adr/0022-promptmasked-releases-stdin-explicitly.md`
Expected: file exists.

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0022-promptmasked-releases-stdin-explicitly.md
git commit -m "docs: record ADR-0022 for the promptMasked stdin fix"
```

---

## Task 2: `promptMasked` releases stdin after finishing

**Files:**

- Modify: `src/cliPrompt.ts:30-78`
- Modify: `tests/unit/cliPrompt.test.ts`

**Interfaces:**

- No change to `promptMasked(question: string, streams?: PromptStreams): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/cliPrompt.test.ts`, change the import to add `vi`:

```typescript
import { describe, it, expect, vi } from 'vitest';
```

Add these two tests inside the existing `describe('promptMasked', ...)` block:

```typescript
  it('pauses the input stream after resolving, so a later spawned child can read the console', async () => {
    const s = streams();
    const pauseSpy = vi.spyOn(s.input, 'pause');
    const result = promptMasked('SMB share password', s);
    s.input.write('hunter2');
    s.input.write('\r');
    await result;
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('pauses the input stream after a cancellation (Ctrl+C)', async () => {
    const s = streams();
    const pauseSpy = vi.spyOn(s.input, 'pause');
    const result = promptMasked('SMB share password', s);
    s.input.write('\x03');
    await expect(result).rejects.toThrow('promptMasked: cancelled');
    expect(pauseSpy).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run tests/unit/cliPrompt.test.ts`
Expected: FAIL — both new tests report `pauseSpy` was not called.

- [ ] **Step 3: Fix `promptMasked`'s cleanup**

In `src/cliPrompt.ts`, change:

```typescript
    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (isTTY) ttyInput.setRawMode(false);
    };
```

to:

```typescript
    // Unconditional, not just when isTTY: emitKeypressEvents attaches an
    // internal `data` listener to `input` with no public removal API, which
    // keeps the stream in flowing mode — and therefore still reading from the
    // console — even after our own `keypress` listener is gone and raw mode
    // is off. pause() forces it out of flowing mode regardless of what else
    // is still attached, so a child process spawned right after this
    // (ssh with stdio: 'inherit') can read the console instead of racing us
    // for it. See ADR-0022.
    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (isTTY) ttyInput.setRawMode(false);
      input.pause();
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/cliPrompt.test.ts`
Expected: PASS (8 tests: 3 `promptText` + 5 `promptMasked`)

- [ ] **Step 5: Commit**

```bash
git add src/cliPrompt.ts tests/unit/cliPrompt.test.ts
git commit -m "fix(guest-setup): pause stdin after promptMasked so ssh can read the console"
```

---

## Task 3: Migrate `write-github-config` onto the shared `promptText`

Pure refactor — behavior stays identical (same prompt text, same trimming), so the existing CLI-tier tests are the safety net instead of a new failing test.

**Files:**

- Modify: `src/commands/writeGithubConfig.ts:1-39`

**Interfaces:**

- Consumes: `promptText(question: string, defaultValue?: string, streams?: PromptStreams): Promise<string>` from `src/cliPrompt.ts` (unchanged, Task 2).

- [ ] **Step 1: Confirm the baseline passes**

Run: `pnpm build && pnpm vitest run --config vitest.cli.config.ts tests/cli/writeGithubConfig.test.ts`
Expected: PASS (4 tests) — this is the safety net for Step 3.

- [ ] **Step 2: Replace the hand-rolled `readline` call**

In `src/commands/writeGithubConfig.ts`, change the import line:

```typescript
import { createInterface } from 'node:readline/promises';
```

to:

```typescript
import { promptText } from '../cliPrompt';
```

Then change:

```typescript
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = (
        await rl.question(
          "Github personal access tokens can be created at https://github.com/settings/personal-access-tokens/new. To allow changes to a repository be sure to allow access to 'Contents' with read+write permissions.\n\n" +
            'GitHub fine-grained PAT: ',
        )
      ).trim();
      rl.close();
```

to:

```typescript
      const token = await promptText(
        "Github personal access tokens can be created at https://github.com/settings/personal-access-tokens/new. To allow changes to a repository be sure to allow access to 'Contents' with read+write permissions.\n\n" +
          'GitHub fine-grained PAT',
      );
```

(`promptText` appends `: ` itself, so the trailing `: ` moves out of the literal string; it also already `.trim()`s the answer.)

- [ ] **Step 3: Run tests to verify they still pass**

Run: `pnpm build && pnpm vitest run --config vitest.cli.config.ts tests/cli/writeGithubConfig.test.ts`
Expected: PASS (4 tests), unchanged from Step 1.

- [ ] **Step 4: Commit**

```bash
git add src/commands/writeGithubConfig.ts
git commit -m "refactor(guest-setup): migrate write-github-config onto shared promptText"
```

---

## Task 4: `mountShare` reports progress via `onStep`

**Files:**

- Modify: `src/guestSetup/mountShare.ts`
- Modify: `tests/unit/guestSetup/mountShare.test.ts`

**Interfaces:**

- Produces: `MountShareOptions` gains `onStep?: (message: string) => void`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/guestSetup/mountShare.test.ts`, inside `describe('mountShare', ...)`:

```typescript
  it('reports each step to onStep immediately before the operation it describes runs, in order', async () => {
    // A single event log shared between onStep and the fake RemoteExec proves
    // interleaving order, not just that both eventually get called — a test
    // that only checked the final onStep label list would still pass an
    // implementation that (wrongly) reported every step only after the run.
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
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
      defaultSwitchHostIp: '172.28.128.1',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events.map((e) => e.split(':')[0])).toEqual([
      'step',
      'run',
      'step',
      'copyFile',
      'step',
      'run',
      'step',
      'run',
      'step',
      'run',
      'step',
      'run',
    ]);
    expect(events[0]).toBe('step:install cifs-utils');
    expect(events[2]).toBe('step:copy credentials file');
    expect(events[4]).toBe('step:install credentials file');
    expect(events[6]).toBe('step:create mount point');
    expect(events[8]).toBe('step:update fstab');
    expect(events[10]).toBe('step:mount share');
  });

  it('works with no onStep given', async () => {
    const { remoteExec } = fakeRemoteExec();
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        defaultSwitchHostIp: '172.28.128.1',
      }),
    ).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/mountShare.test.ts`
Expected: FAIL — `events` contains no `step:*` entries (`onStep` doesn't exist on `MountShareOptions` yet, so it's silently never called).

- [ ] **Step 3: Thread `onStep` through the implementation**

In `src/guestSetup/mountShare.ts`, change the options interface:

```typescript
export interface MountShareOptions {
  shareName: string;
  accountName: string;
  password: string;
  defaultSwitchHostIp: string;
  onStep?: (message: string) => void;
}
```

Change `runStep` to take the reporter explicitly:

```typescript
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
```

Change `mountShare` to resolve a default and pass it everywhere, and to report the one step (`copyFile`) that isn't behind `runStep`:

```typescript
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
  await runStep(remoteExec, 'create mount point', `sudo mkdir -p ${quoteForRemoteShell(mountPoint)}`, onStep);
  await runStep(
    remoteExec,
    'update fstab',
    buildFstabReplaceCommand({
      shareName: opts.shareName,
      defaultSwitchHostIp: opts.defaultSwitchHostIp,
    }),
    onStep,
  );
  await runStep(remoteExec, 'mount share', 'sudo systemctl daemon-reload && sudo mount -a', onStep);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/mountShare.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/mountShare.ts tests/unit/guestSetup/mountShare.test.ts
git commit -m "feat(guest-setup): report mountShare progress via onStep"
```

---

## Task 5: `runPreScripts` reports progress via `onStep`

**Files:**

- Modify: `src/guestSetup/runPreScripts.ts`
- Modify: `tests/unit/guestSetup/runPreScripts.test.ts`

**Interfaces:**

- Produces: `RunPreScriptsOptions` gains `onStep?: (message: string) => void`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/guestSetup/runPreScripts.test.ts`, inside `describe('runPreScripts', ...)`:

```typescript
  it('reports each script to onStep immediately before running it, interleaved in order', async () => {
    // Shared event log, same reasoning as mountShare's Task 4 test: proves
    // onStep fires before remoteExec.run for each script, not just that both
    // eventually fire.
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('runPreScripts should never call copyFile');
      },
    };
    await runPreScripts(remoteExec, {
      scripts: [script('01-apt-packages.sh', 'apt-packages'), script('02-install-pnpm.sh', 'install-pnpm')],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events).toEqual([
      'step:running 01-apt-packages.sh',
      "run:cd '/mnt/vm-shared-linux/pre-scripts' && './01-apt-packages.sh'",
      'step:running 02-install-pnpm.sh',
      "run:cd '/mnt/vm-shared-linux/pre-scripts' && './02-install-pnpm.sh'",
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guestSetup/runPreScripts.test.ts`
Expected: FAIL — `events` contains no `step:*` entries.

- [ ] **Step 3: Thread `onStep` through the implementation**

In `src/guestSetup/runPreScripts.ts`, change the options interface:

```typescript
export interface RunPreScriptsOptions {
  scripts: PreScript[];
  shareName: string;
  internalSwitchHostIp: string;
  onStep?: (message: string) => void;
}
```

Change the loop body:

```typescript
export async function runPreScripts(
  remoteExec: RemoteExec,
  opts: RunPreScriptsOptions,
): Promise<void> {
  const matches = opts.scripts.filter((s) => s.slug === CONFIGURE_NETWORK_SLUG);
  if (matches.length > 1) {
    throw new Error(
      `runPreScripts: more than one pre-script resolves to '${CONFIGURE_NETWORK_SLUG}': ` +
        matches.map((s) => s.filename).join(', '),
    );
  }

  const onStep = opts.onStep ?? (() => {});
  const remoteDir = `/mnt/${opts.shareName}/pre-scripts`;
  for (const script of opts.scripts) {
    const args =
      script.slug === CONFIGURE_NETWORK_SLUG
        ? ` ${quoteForRemoteShell(opts.internalSwitchHostIp)}`
        : '';
    const scriptPath = quoteForRemoteShell(`./${script.filename}`);
    const command = `cd ${quoteForRemoteShell(remoteDir)} && ${scriptPath}${args}`;
    onStep(`running ${script.filename}`);
    const { exitCode } = await remoteExec.run(command);
    if (exitCode !== 0) throw new RunPreScriptsError(script.filename, exitCode);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guestSetup/runPreScripts.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/guestSetup/runPreScripts.ts tests/unit/guestSetup/runPreScripts.test.ts
git commit -m "feat(guest-setup): report runPreScripts progress via onStep"
```

---

## Task 6: Wire progress logging into `setup-guest-unix`

**Files:**

- Modify: `src/commands/setupGuestUnix.ts:87-100`

**Interfaces:**

- Consumes: `onStep?: (message: string) => void` on `MountShareOptions` (Task 4) and `RunPreScriptsOptions` (Task 5).

- [ ] **Step 1: Wire the reporter**

In `src/commands/setupGuestUnix.ts`, change:

```typescript
      const scripts = listPreScripts(join(paths.vmShared, 'pre-scripts'));
      const remoteExec = createSshRemoteExec({ address, username });

      try {
        await mountShare(remoteExec, { shareName, accountName, password, defaultSwitchHostIp });
        await runPreScripts(remoteExec, { scripts, shareName, internalSwitchHostIp });
```

to:

```typescript
      const scripts = listPreScripts(join(paths.vmShared, 'pre-scripts'));
      const remoteExec = createSshRemoteExec({ address, username });
      const onStep = (message: string) => console.log(`setup-guest-unix: ${message}...`);

      try {
        await mountShare(remoteExec, { shareName, accountName, password, defaultSwitchHostIp, onStep });
        await runPreScripts(remoteExec, { scripts, shareName, internalSwitchHostIp, onStep });
```

- [ ] **Step 2: Verify the option surface test and build still pass**

Run: `pnpm vitest run tests/unit/commands/setupGuestUnix.test.ts && pnpm build`
Expected: PASS — this test only covers the option surface and `resolveGuestNetwork`, unaffected by this change; the build step confirms it still type-checks and bundles.

- [ ] **Step 3: Commit**

```bash
git add src/commands/setupGuestUnix.ts
git commit -m "feat(guest-setup): wire step progress logging into setup-guest-unix"
```

---

## Task 7: Run the full verification gate

The Global Constraints require `pnpm format`/`pnpm lint` to pass before every commit, but no task above runs them — each task's own test command only covers that task's slice. Run the full gate once, after all code tasks, before the manual guest run.

- [ ] **Step 1: Run the gate**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:cli`

Expected: all PASS. (`pnpm format:check` is used instead of `pnpm format` because `format` rewrites the whole repo rather than just verifying it. `test:proxy-stack` and `test:guest` are omitted — they need Docker/QEMU prerequisites this plan doesn't touch and aren't affected by these changes.)

- [ ] **Step 2: Fix and re-run if anything fails**

If `format:check` fails: run `pnpm format`, review the diff, `git add` and commit it separately (`style: format`). If anything else fails, fix it in the file/task it belongs to and re-run that task's own test command before re-running the full gate.

---

## Task 8: Manually verify against the real guest

This is the only verification for the actual bug this plan exists to fix — no test tier in this repo can exercise a real shared Windows console racing a spawned `ssh` process (see Global Constraints).

- [ ] **Step 1: Build the CLI**

Run: `pnpm build`

- [ ] **Step 2: Run `susentorno setup-guest-unix` against your real Ubuntu guest**

Enter the SMB share password. Then watch for, in this exact order — **do not** treat reaching the first line below as success; `onStep` fires *before* the network operation it describes, so it prints regardless of whether SSH ever works:

1. `setup-guest-unix: install cifs-utils...` — prints before the first `ssh` call even starts. Reaching this line only means the SMB-password step finished; it proves nothing about SSH yet.
2. The guest's own `username@host's password:` prompt (each step below spawns its own `ssh`/`scp` process — this codebase's `RemoteExec` doesn't configure SSH connection sharing, so expect to be prompted again for each one, unless your own `~/.ssh/config` sets up `ControlMaster`). Enter the guest's login password.
3. `setup-guest-unix: copy credentials file...` — **this is the real confirmation**: it only prints once the previous `ssh` command (installing `cifs-utils`) has actually finished successfully, so reaching it proves the SSH password was received and the remote command ran.
4. A distinct `setup-guest-unix: <step>...` line before each remaining `mountShare` step and before each pre-script, with no long silent gaps and no repeated/stalled password prompts.

- [ ] **Step 3: Report the result**

If step 2 above (the SSH password prompt) never resolves — no matter how many times you type the password, you never reach `setup-guest-unix: copy credentials file...` — then `input.pause()` alone did not fully resolve the Windows console race, and this plan's Task 2 needs revisiting (e.g. also pausing/releasing stdin at the `setupGuestUnix.ts` call site, before `createSshRemoteExec` is even constructed, as defense in depth). If it works, this plan is complete.

---

## Self-Review

**Spec coverage:** the original ask was (A) fix the silent SSH-password hang and (B) add progress output, in that order, plus (per follow-up) migrate `write-github-config` onto the same prompt helper and record the reasoning as an ADR. Task 1 → ADR. Task 2 → (A). Task 3 → the `write-github-config` migration. Tasks 4–6 → (B). Task 7 → the full lint/format/test gate the Global Constraints require but no per-task step otherwise runs. Task 8 → the required manual verification, since (A)'s fix is fundamentally untestable by any tier in this repo.

**Placeholder scan:** no TBD/TODO markers; every step shows the real code being written, not a description of it.

**Type consistency:** `onStep?: (message: string) => void` is the same shape in `MountShareOptions` (Task 4) and `RunPreScriptsOptions` (Task 5), and `setupGuestUnix.ts` (Task 6) passes one function satisfying both.

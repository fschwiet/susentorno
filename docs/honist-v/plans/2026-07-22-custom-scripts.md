# Custom VM Setup Scripts Implementation Plan

**Goal:** Let users drop their own numbered setup scripts into committed `.configamatron/pre-scripts/` and `post-scripts/` folders that get woven together with the tool's built-in scripts into the generated VM shares.

**Architecture:** A pure "weave" core classifies/validates/orders a folder's scripts and renumbers built-ins+customs into one contiguous `01,02,03…` block per phase (`pre`/`post`) and per platform (`.sh`→`vm-shared`, `.ps1`→`vm-shared-windows`). Passthrough resources are copied beside the scripts; a collision detector fails loud before anything is written. `init` and `update-shares` run the same whole-transaction weave (validate everything, then stage-then-swap each phase folder).

**Tech Stack:** TypeScript (ESM/NodeNext), Node ≥18, commander CLI, vitest, `node:fs`/`node:path`. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

- **Runtime:** Node `>=18`; ESM modules (`"type": "module"`), import with no file extension from `src/` (e.g. `import { x } from './weaveScripts'`).
- **Quality gates (all must pass — this is `pnpm test`):** `pnpm format:check` (prettier), `pnpm lint` (eslint), `pnpm typecheck` (`tsc --noEmit`), `pnpm test:unit` (vitest), then `pnpm build` + `test:e2e` + `test:integration`. Run `pnpm format` before committing to satisfy prettier.
- **File operations are argv/path based — never build shell command strings.** Use `node:fs` (`copyFileSync`, `cpSync`, `renameSync`, `rmSync`, `mkdirSync`, `readdirSync`).
- **Runnable-step naming (verbatim from spec):** a file directly inside a phase folder is a runnable step iff it matches `^[0-9]{2}[-_].+\.(sh|ps1)$` — two-digit prefix, a `-` or `_` separator, a **non-empty** name, and a **lowercase** `.sh`/`.ps1` extension. Built-ins may additionally use the reserved `nn` sentinel prefix (`^(nn|[0-9]{2})[-_].+\.(sh|ps1)$`); the `nn` sentinel is a **hard error** in a custom folder.
- **Fail loud, mutate nothing on failure:** every validation error lists *all* offenders; no share is touched until every check across both phases and both platforms passes.
- **Renumbering:** concatenate built-in list then custom list, renumber contiguously `01,02,…`; output filename = new two-digit number + `-` + the original text after the source prefix-and-separator (separator normalizes to `-`). More than 99 combined scripts is a hard error.
- **The `nn` sentinel sorts last** within its phase, so built-in `nn-configure-network` always lands strictly last in `pre` — after every custom pre-script.
- **Case sensitivity:** the Windows share (`vm-shared-windows`) compares destination paths **case-insensitively**; the Linux share (`vm-shared`) compares **case-sensitively**.
- **`$script_dir`-relative references only:** scripts reference sibling resources relative to their own file location, never the caller's cwd.

---

## File Structure

**New source modules**

- `src/weaveScripts.ts` — pure classify/validate/sort/renumber core for a single folder. No knowledge of built-in vs custom beyond an `allowSentinel` flag.
- `src/collisions.ts` — pure destination-path collision detector (file/dir/ancestor/case).
- `src/weaveShares.ts` — orchestrator: builds per-phase plans (validates naming + collisions), stages, and swaps them into the shares. Consumes the two modules above plus `envPaths` and `initEnv`'s dns-responder filter.

**New tests**

- `tests/unit/weaveScripts.test.ts`, `tests/unit/collisions.test.ts`, `tests/unit/weaveShares.test.ts`, `tests/unit/gitignore.test.ts`.

**Modified source**

- `src/envPaths.ts` — add custom `preScripts`/`postScripts` source paths and per-target generated phase-folder paths.
- `src/initEnv.ts` — scaffold custom folders with placeholder READMEs, then weave.
- `src/commands/updateShares.ts` — run the weave (whole-transaction) alongside the existing home-jq-transforms refresh.

**Reorganized templates** (moved into `pre-scripts/`/`post-scripts/` subfolders, `nn-configure-network` renamed, env-file references changed to the script's parent dir):

- `templates/vm-shared/{pre,post}-scripts/…`, `templates/vm-shared-windows/{pre,post}-scripts/…`, `templates/configamatron.gitignore` (inverted to an allowlist).
- `scripts/copy-vm-applier.mjs` — copy the bundled `.mjs` into the `post-scripts/` subfolders.

**Modified tests/docs:** `tests/unit/templates.test.ts`, `tests/unit/initEnv.test.ts`, `tests/e2e/init.test.ts`, `tests/e2e/updateShares.test.ts`, `tests/unit/envPaths.test.ts`, `tests/vm/vm.test.ts`, `tests/vm/harness/share.sh`, `README.md`, `usage-windows-vm.md`, `technical-notes.md`.

---

## Task 1: Weave core (`src/weaveScripts.ts`)

Pure folder classification, validation, ordering, and renumbering. This is the reusable engine the spec calls "one function orders a single folder's scripts, taking an `allowSentinel` flag."

**Files:**

- Create: `src/weaveScripts.ts`
- Test: `tests/unit/weaveScripts.test.ts`

**Interfaces:**

- Produces:
  - `type ScriptExtension = 'sh' | 'ps1'`
  - `interface OrderedScript { sourcePath: string; sourceName: string; remainder: string; ext: ScriptExtension; sentinel: boolean }`
  - `interface PassthroughEntry { sourcePath: string; name: string; isDirectory: boolean }`
  - `interface FolderContents { scripts: OrderedScript[]; passthrough: PassthroughEntry[] }`
  - `function readFolderContents(opts: { dir: string; extension: ScriptExtension; allowSentinel: boolean; strictExtension: boolean }): FolderContents`
  - `interface RenumberedScript { sourcePath: string; outputName: string }`
  - `function renumber(scripts: OrderedScript[]): RenumberedScript[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/weaveScripts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFolderContents, renumber } from '../../src/weaveScripts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function touch(name: string) {
  writeFileSync(join(dir, name), '');
}

describe('readFolderContents', () => {
  it('returns empty contents for a missing folder', () => {
    const r = readFolderContents({
      dir: join(dir, 'nope'),
      extension: 'sh',
      allowSentinel: false,
      strictExtension: false,
    });
    expect(r.scripts).toEqual([]);
    expect(r.passthrough).toEqual([]);
  });

  it('orders scripts by prefix and keeps the remainder for renaming', () => {
    touch('02-second.sh');
    touch('01_first.sh');
    const r = readFolderContents({
      dir,
      extension: 'sh',
      allowSentinel: false,
      strictExtension: false,
    });
    expect(r.scripts.map((s) => s.sourceName)).toEqual(['01_first.sh', '02-second.sh']);
    // The '_' separator normalizes away; remainder is the text after "<prefix><sep>".
    expect(r.scripts[0].remainder).toBe('first.sh');
    expect(r.scripts[1].remainder).toBe('second.sh');
  });

  it('breaks a prefix tie by full filename, byte-ordinal ascending', () => {
    touch('01-bravo.sh');
    touch('01-alpha.sh');
    const r = readFolderContents({
      dir,
      extension: 'sh',
      allowSentinel: false,
      strictExtension: false,
    });
    expect(r.scripts.map((s) => s.sourceName)).toEqual(['01-alpha.sh', '01-bravo.sh']);
  });

  it('filters to the requested extension and treats the other platform as neither script nor passthrough', () => {
    touch('01-linux.sh');
    touch('01-windows.ps1');
    const r = readFolderContents({
      dir,
      extension: 'sh',
      allowSentinel: false,
      strictExtension: false,
    });
    expect(r.scripts.map((s) => s.sourceName)).toEqual(['01-linux.sh']);
    expect(r.passthrough).toEqual([]); // the .ps1 is a valid script for the other platform, not passthrough
  });

  it('honors the nn sentinel when allowSentinel is true and sorts it last', () => {
    touch('nn-network.sh');
    touch('05-late.sh');
    const r = readFolderContents({
      dir,
      extension: 'sh',
      allowSentinel: true,
      strictExtension: true,
    });
    expect(r.scripts.map((s) => s.sourceName)).toEqual(['05-late.sh', 'nn-network.sh']);
  });

  it('rejects the nn sentinel when allowSentinel is false', () => {
    touch('nn-network.sh');
    expect(() =>
      readFolderContents({ dir, extension: 'sh', allowSentinel: false, strictExtension: false }),
    ).toThrow(/nn/);
  });

  it('rejects an empty name, a bad prefix, and an uppercase extension, listing every offender', () => {
    touch('01-.sh'); // empty name
    touch('1-bad.sh'); // one-digit prefix
    touch('01-up.SH'); // uppercase extension
    touch('ok.txt'); // passthrough, not an offender
    let message = '';
    try {
      readFolderContents({ dir, extension: 'sh', allowSentinel: false, strictExtension: false });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('01-.sh');
    expect(message).toContain('1-bad.sh');
    expect(message).toContain('01-up.SH');
    expect(message).not.toContain('ok.txt');
  });

  it('rejects an opposite-extension script in a built-in folder (strictExtension)', () => {
    touch('01-stray.ps1');
    expect(() =>
      readFolderContents({ dir, extension: 'sh', allowSentinel: true, strictExtension: true }),
    ).toThrow(/01-stray\.ps1/);
  });

  it('collects non-script files and directories as passthrough', () => {
    touch('dnsmasq-stub.conf');
    mkdirSync(join(dir, 'lib'));
    const r = readFolderContents({
      dir,
      extension: 'sh',
      allowSentinel: false,
      strictExtension: false,
    });
    const names = r.passthrough.map((p) => `${p.name}:${p.isDirectory}`).sort();
    expect(names).toEqual(['dnsmasq-stub.conf:false', 'lib:true']);
  });
});

describe('renumber', () => {
  it('renumbers contiguously and builds output names from the remainder', () => {
    const scripts = [
      { sourcePath: '/a/04-configure.sh', sourceName: '04-configure.sh', remainder: 'configure.sh', ext: 'sh' as const, sentinel: false },
      { sourcePath: '/b/nn-network.sh', sourceName: 'nn-network.sh', remainder: 'network.sh', ext: 'sh' as const, sentinel: true },
    ];
    expect(renumber(scripts)).toEqual([
      { sourcePath: '/a/04-configure.sh', outputName: '01-configure.sh' },
      { sourcePath: '/b/nn-network.sh', outputName: '02-network.sh' },
    ]);
  });

  it('fails loud when the combined count exceeds 99', () => {
    const scripts = Array.from({ length: 100 }, (_, i) => ({
      sourcePath: `/x/${i}.sh`,
      sourceName: `${i}.sh`,
      remainder: 'x.sh',
      ext: 'sh' as const,
      sentinel: false,
    }));
    expect(() => renumber(scripts)).toThrow(/99/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/weaveScripts.test.ts`
Expected: FAIL — `Cannot find module '../../src/weaveScripts'`.

- [ ] **Step 3: Write the implementation**

Create `src/weaveScripts.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type ScriptExtension = 'sh' | 'ps1';

// A runnable step: two-digit (or reserved 'nn') prefix, '-'/'_' separator,
// non-empty name, lowercase .sh/.ps1. Group 2 is the name, group 3 the extension.
const SCRIPT_NAME_RE = /^(nn|[0-9]{2})[-_](.+)\.(sh|ps1)$/;
// Anything ending in .sh/.ps1 (any case) is "script-like": if it is not a valid
// script name it is a hard error rather than a silent passthrough.
const SCRIPT_LIKE_RE = /\.(sh|ps1)$/i;

export interface OrderedScript {
  sourcePath: string;
  sourceName: string;
  /** Text after "<prefix><separator>", including the extension, e.g. "network.sh". */
  remainder: string;
  ext: ScriptExtension;
  /** True for the reserved 'nn' prefix; the orchestrator floats these to the end of the combined list. */
  sentinel: boolean;
}

export interface PassthroughEntry {
  sourcePath: string;
  name: string;
  isDirectory: boolean;
}

export interface FolderContents {
  scripts: OrderedScript[];
  passthrough: PassthroughEntry[];
}

interface ParsedScript extends OrderedScript {
  prefix: string;
}

export interface ReadFolderOptions {
  dir: string;
  extension: ScriptExtension;
  /** Built-in folders pass true; custom folders pass false (the reserved 'nn' is theirs alone). */
  allowSentinel: boolean;
  /** Built-in folders pass true: an opposite-extension script is a template authoring error. */
  strictExtension: boolean;
}

/**
 * Classify, validate, and order one folder's direct children. Missing folders
 * yield empty contents (custom folders are scaffolded by init but a user may
 * delete one). Throws — listing every offender — on any invalid script name.
 */
export function readFolderContents(opts: ReadFolderOptions): FolderContents {
  const { dir, extension, allowSentinel, strictExtension } = opts;
  if (!existsSync(dir)) return { scripts: [], passthrough: [] };

  const offenders: string[] = [];
  const parsed: ParsedScript[] = [];
  const passthrough: PassthroughEntry[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const sourcePath = join(dir, name);
    if (entry.isDirectory()) {
      passthrough.push({ sourcePath, name, isDirectory: true });
      continue;
    }
    const match = SCRIPT_NAME_RE.exec(name);
    if (match) {
      const prefix = match[1];
      const ext = match[3] as ScriptExtension;
      const sentinel = prefix === 'nn';
      if (sentinel && !allowSentinel) {
        offenders.push(`${name} (reserved 'nn' prefix is only for built-in scripts)`);
        continue;
      }
      if (strictExtension && ext !== extension) {
        offenders.push(`${name} (built-in folder must contain only .${extension} scripts)`);
        continue;
      }
      // A valid script for the other platform (custom folder holding both): skip it here.
      if (ext !== extension) continue;
      parsed.push({
        sourcePath,
        sourceName: name,
        remainder: `${match[2]}.${match[3]}`,
        ext,
        sentinel,
        prefix,
      });
      continue;
    }
    if (SCRIPT_LIKE_RE.test(name)) {
      offenders.push(`${name} (must match NN[-_]name.(sh|ps1) with a lowercase extension)`);
      continue;
    }
    passthrough.push({ sourcePath, name, isDirectory: false });
  }

  if (offenders.length > 0) {
    throw new Error(`invalid script name(s) in ${dir}:\n  - ${offenders.join('\n  - ')}`);
  }

  parsed.sort(compareScripts);
  return {
    scripts: parsed.map(({ sourcePath, sourceName, remainder, ext, sentinel }) => ({
      sourcePath,
      sourceName,
      remainder,
      ext,
      sentinel,
    })),
    passthrough,
  };
}

// Numbered scripts first (by 2-digit prefix, which string-compares like a number),
// then the 'nn' sentinel; ties within a prefix break by full filename byte-ordinal.
function compareScripts(a: ParsedScript, b: ParsedScript): number {
  if (a.sentinel !== b.sentinel) return a.sentinel ? 1 : -1;
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
  if (a.sourceName < b.sourceName) return -1;
  if (a.sourceName > b.sourceName) return 1;
  return 0;
}

export interface RenumberedScript {
  sourcePath: string;
  outputName: string;
}

/** Renumber a concatenated (built-in then custom) list to contiguous 01,02,03…. */
export function renumber(scripts: OrderedScript[]): RenumberedScript[] {
  if (scripts.length > 99) {
    throw new Error(
      `too many scripts after weaving (${scripts.length}); the two-digit prefix caps the total at 99`,
    );
  }
  return scripts.map((s, i) => ({
    sourcePath: s.sourcePath,
    outputName: `${String(i + 1).padStart(2, '0')}-${s.remainder}`,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/weaveScripts.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Format, then commit**

```bash
pnpm format
git add src/weaveScripts.ts tests/unit/weaveScripts.test.ts
git commit -m "feat: add weave core for classifying and renumbering setup scripts"
```

---

## Task 2: Collision detection (`src/collisions.ts`)

Detects, per share, whether two items would occupy the same destination-relative path — files, directories, ancestors, and (on Windows) case-only clashes. Two directories at the same path merge; everything else that overlaps is a conflict.

**Files:**

- Create: `src/collisions.ts`
- Test: `tests/unit/collisions.test.ts`

**Interfaces:**

- Produces:
  - `interface WeaveItem { destPath: string; kind: 'file' | 'dir'; origin: string }` — `destPath` is `/`-separated, relative to the phase folder; `origin` is a human label for error messages.
  - `interface Collision { destPath: string; a: string; b: string; reason: string }`
  - `function detectCollisions(items: WeaveItem[], opts: { caseInsensitive: boolean }): Collision[]` — returns every conflict (empty when clean).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/collisions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectCollisions, type WeaveItem } from '../../src/collisions';

const f = (destPath: string, origin: string): WeaveItem => ({ destPath, kind: 'file', origin });
const d = (destPath: string, origin: string): WeaveItem => ({ destPath, kind: 'dir', origin });

describe('detectCollisions', () => {
  it('passes a clean layout', () => {
    const items = [f('01-a.sh', 'builtin'), f('02-b.sh', 'custom'), f('helper.conf', 'builtin')];
    expect(detectCollisions(items, { caseInsensitive: false })).toEqual([]);
  });

  it('flags two files at the same path and names both sides', () => {
    const c = detectCollisions([f('x.conf', 'builtin x'), f('x.conf', 'custom x')], {
      caseInsensitive: false,
    });
    expect(c).toHaveLength(1);
    expect(c[0].destPath).toBe('x.conf');
    expect(c[0].a).toBe('builtin x');
    expect(c[0].b).toBe('custom x');
    expect(c[0].reason).toMatch(/two files/);
  });

  it('flags a file vs a directory at the same path', () => {
    const c = detectCollisions([f('lib', 'builtin file'), d('lib', 'custom dir')], {
      caseInsensitive: false,
    });
    expect(c).toHaveLength(1);
    expect(c[0].reason).toMatch(/file vs directory/);
  });

  it('flags an ancestor conflict (a file where another item needs a directory)', () => {
    const c = detectCollisions([f('lib', 'builtin file'), f('lib/helper.sh', 'custom nested')], {
      caseInsensitive: false,
    });
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].reason).toMatch(/file vs directory/);
  });

  it('merges two directories at the same path without a collision', () => {
    const c = detectCollisions(
      [d('lib', 'builtin'), f('lib/a.sh', 'builtin'), d('lib', 'custom'), f('lib/b.sh', 'custom')],
      { caseInsensitive: false },
    );
    expect(c).toEqual([]);
  });

  it('still flags colliding contents inside two merged directories', () => {
    const c = detectCollisions(
      [d('lib', 'builtin'), f('lib/same.sh', 'builtin'), d('lib', 'custom'), f('lib/same.sh', 'custom')],
      { caseInsensitive: false },
    );
    expect(c).toHaveLength(1);
    expect(c[0].destPath).toBe('lib/same.sh');
  });

  it('treats a case-only file clash as a collision on Windows but not on Linux', () => {
    const items = [f('Foo.txt', 'builtin'), f('foo.txt', 'custom')];
    expect(detectCollisions(items, { caseInsensitive: false })).toEqual([]);
    expect(detectCollisions(items, { caseInsensitive: true })).toHaveLength(1);
  });

  it('treats a case-only directory clash as a collision on Windows', () => {
    const items = [d('DNS-Responder', 'builtin'), d('dns-responder', 'custom')];
    expect(detectCollisions(items, { caseInsensitive: false })).toEqual([]);
    const c = detectCollisions(items, { caseInsensitive: true });
    expect(c).toHaveLength(1);
    expect(c[0].reason).toMatch(/case-only/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/collisions.test.ts`
Expected: FAIL — `Cannot find module '../../src/collisions'`.

- [ ] **Step 3: Write the implementation**

Create `src/collisions.ts`:

```ts
export interface WeaveItem {
  /** Destination path relative to the phase folder, '/'-separated. */
  destPath: string;
  kind: 'file' | 'dir';
  /** Human-readable source label for error messages. */
  origin: string;
}

export interface Collision {
  destPath: string;
  a: string;
  b: string;
  reason: string;
}

interface Node {
  kind: 'file' | 'dir';
  /** Actual (byte-exact) path; used to detect case-only clashes on Windows. */
  displayPath: string;
  origin: string;
}

/**
 * Detect, on the normalized destination-relative path each item would occupy,
 * whether two items conflict. Two directories at byte-identical paths merge;
 * a case-only difference on a case-insensitive share is a clash; file-vs-file,
 * file-vs-directory, and ancestor overlaps are conflicts. Returns every one.
 */
export function detectCollisions(items: WeaveItem[], opts: { caseInsensitive: boolean }): Collision[] {
  const key = (p: string) => (opts.caseInsensitive ? p.toLowerCase() : p);
  const nodes = new Map<string, Node>();
  const collisions: Collision[] = [];

  for (const item of items) {
    const segments = item.destPath.split('/').filter((s) => s.length > 0);

    // Every ancestor must be a directory.
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      const existing = nodes.get(key(ancestor));
      if (!existing) {
        nodes.set(key(ancestor), { kind: 'dir', displayPath: ancestor, origin: item.origin });
      } else if (existing.kind === 'file') {
        collisions.push({
          destPath: ancestor,
          a: existing.origin,
          b: item.origin,
          reason: 'file vs directory (ancestor conflict)',
        });
      } else if (existing.displayPath !== ancestor) {
        collisions.push({
          destPath: ancestor,
          a: existing.origin,
          b: item.origin,
          reason: 'case-only directory clash',
        });
      }
    }

    const full = segments.join('/');
    const existing = nodes.get(key(full));
    if (!existing) {
      nodes.set(key(full), { kind: item.kind, displayPath: full, origin: item.origin });
    } else if (existing.kind === 'dir' && item.kind === 'dir') {
      if (existing.displayPath !== full) {
        collisions.push({
          destPath: full,
          a: existing.origin,
          b: item.origin,
          reason: 'case-only directory clash',
        });
      }
      // byte-identical directories merge — no collision.
    } else if (existing.kind === 'file' && item.kind === 'file') {
      collisions.push({
        destPath: full,
        a: existing.origin,
        b: item.origin,
        reason: 'two files at the same path',
      });
    } else {
      collisions.push({
        destPath: full,
        a: existing.origin,
        b: item.origin,
        reason: 'file vs directory',
      });
    }
  }

  return collisions;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/collisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, then commit**

```bash
pnpm format
git add src/collisions.ts tests/unit/collisions.test.ts
git commit -m "feat: add destination-path collision detector for woven shares"
```

---

## Task 3: Phase-folder paths in `envPaths`

Add the custom source folders and the per-target generated phase-folder paths so `init`/`update-shares` and the weave orchestrator address them by name.

**Files:**

- Modify: `src/envPaths.ts`
- Test: `tests/unit/envPaths.test.ts`

**Interfaces:**

- Consumes: existing `EnvPaths`, `VmSharedPaths` from `src/envPaths.ts`.
- Produces (added fields):
  - `VmSharedPaths` gains `preScripts: string` and `postScripts: string` (generated phase folders inside each share).
  - `EnvPaths` gains `preScripts: string` and `postScripts: string` (the user-edited source folders under `.configamatron/`).

- [ ] **Step 1: Write the failing test**

In `tests/unit/envPaths.test.ts`, update the two `toEqual` blocks for `vmSharedTargets[0]`/`[1]` to include the new fields, and add a new assertion block. Replace the `vmSharedTargets[0]` object with:

```ts
    expect(paths.vmSharedTargets[0]).toEqual({
      dir: join(root, 'vm-shared'),
      cert: join(root, 'vm-shared', 'cert.pem'),
      credentials: join(root, 'vm-shared', 'credentials.json'),
      authJson: join(root, 'vm-shared', 'auth.json'),
      githubConfig: join(root, 'vm-shared', 'github-config.txt'),
      homeJqTransforms: join(root, 'vm-shared', 'home-jq-transforms'),
      preScripts: join(root, 'vm-shared', 'pre-scripts'),
      postScripts: join(root, 'vm-shared', 'post-scripts'),
    });
```

and the `vmSharedTargets[1]` object with:

```ts
    expect(paths.vmSharedTargets[1]).toEqual({
      dir: join(root, 'vm-shared-windows'),
      cert: join(root, 'vm-shared-windows', 'cert.pem'),
      credentials: join(root, 'vm-shared-windows', 'credentials.json'),
      authJson: join(root, 'vm-shared-windows', 'auth.json'),
      githubConfig: join(root, 'vm-shared-windows', 'github-config.txt'),
      homeJqTransforms: join(root, 'vm-shared-windows', 'home-jq-transforms'),
      preScripts: join(root, 'vm-shared-windows', 'pre-scripts'),
      postScripts: join(root, 'vm-shared-windows', 'post-scripts'),
    });
```

Then add this test inside the `describe('envPaths home-jq-transforms', …)` block (or a new `describe`):

```ts
  it('locates the user-edited custom script source folders', () => {
    const p = envPaths('/work');
    expect(p.preScripts).toBe(join('/work', '.configamatron', 'pre-scripts'));
    expect(p.postScripts).toBe(join('/work', '.configamatron', 'post-scripts'));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`
Expected: FAIL — `toEqual` mismatch (missing `preScripts`/`postScripts`) and `p.preScripts` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/envPaths.ts`:

Add the two fields to `VmSharedPaths`:

```ts
export interface VmSharedPaths {
  dir: string;
  cert: string;
  credentials: string;
  authJson: string;
  githubConfig: string;
  homeJqTransforms: string;
  preScripts: string;
  postScripts: string;
}
```

Add the two source-folder fields to `EnvPaths` (next to `homeJqTransforms`):

```ts
  homeJqTransforms: string;
  preScripts: string;
  postScripts: string;
  gitignore: string;
```

Extend the `target` helper inside `envPaths`:

```ts
  const target = (dir: string): VmSharedPaths => ({
    dir,
    cert: join(dir, 'cert.pem'),
    credentials: join(dir, 'credentials.json'),
    authJson: join(dir, 'auth.json'),
    githubConfig: join(dir, 'github-config.txt'),
    homeJqTransforms: join(dir, 'home-jq-transforms'),
    preScripts: join(dir, 'pre-scripts'),
    postScripts: join(dir, 'post-scripts'),
  });
```

And add the source folders to the returned object (next to `homeJqTransforms: join(root, 'home-jq-transforms')`):

```ts
    homeJqTransforms: join(root, 'home-jq-transforms'),
    preScripts: join(root, 'pre-scripts'),
    postScripts: join(root, 'post-scripts'),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, then commit**

```bash
pnpm format
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "feat: add custom-script and generated phase-folder paths to envPaths"
```

---

## Task 4: Weave orchestrator (`src/weaveShares.ts`)

Builds a plan for each phase × platform (validating names via Task 1 and collisions via Task 2), then stages every phase and swaps them into the shares only after all staging succeeds. This is the whole-transaction engine both `init` and `update-shares` call.

**Files:**

- Create: `src/dnsResponder.ts` (leaf module — see Step 0)
- Modify: `src/initEnv.ts` (re-point its import — see Step 0)
- Create: `src/weaveShares.ts`
- Test: `tests/unit/weaveShares.test.ts`

**Interfaces:**

- Consumes: `readFolderContents`, `renumber`, `ScriptExtension` (Task 1); `detectCollisions`, `WeaveItem`, `Collision` (Task 2); `EnvPaths` (Task 3); `isDnsResponderBuildArtifact` from `src/dnsResponder.ts` (created here).
- Produces:
  - `interface WeaveAction { kind: 'file' | 'dir'; src: string; destRel: string }`
  - `interface PhasePlan { livePhaseDir: string; actions: WeaveAction[] }`
  - `function planAllPhases(opts: { templatesDir: string; paths: EnvPaths }): PhasePlan[]` — throws on any naming/collision/overflow violation.
  - `function executePlans(plans: PhasePlan[]): void` — stage-all-then-swap-all with backup/restore.
  - `function weaveShares(opts: { templatesDir: string; paths: EnvPaths }): void` — `executePlans(planAllPhases(opts))`.

- [ ] **Step 0: Extract `isDnsResponderBuildArtifact` into a leaf module (avoids a circular import)**

`weaveShares` needs the dns-responder build-artifact filter, and in Task 6 `initEnv` will import `weaveShares` — so `weaveShares` importing from `initEnv` would be circular. Move the helper into a dependency-free leaf module first.

Create `src/dnsResponder.ts` (move the function verbatim from `initEnv.ts`):

```ts
/**
 * Reject dns-responder build artifacts (bin/obj) so a developer's local build output
 * never gets copied onto the read-only VM share. cpSync copies straight off disk and
 * ignores gitignore, so the filter is the only guard.
 */
export function isDnsResponderBuildArtifact(source: string): boolean {
  const segments = source.split(/[\\/]/);
  const dnsIdx = segments.indexOf('dns-responder');
  if (dnsIdx === -1) return false;
  return segments.slice(dnsIdx + 1).some((s) => s === 'bin' || s === 'obj');
}
```

In `src/initEnv.ts`, delete the local `isDnsResponderBuildArtifact` definition and its doc comment, and import it instead. Add to the imports:

```ts
import { isDnsResponderBuildArtifact } from './dnsResponder';
```

(The `filter: (source) => !isDnsResponderBuildArtifact(source)` call site is unchanged; behavior is identical, so `tests/unit/initEnv.test.ts` still passes.)

Run: `pnpm typecheck && pnpm vitest run tests/unit/initEnv.test.ts`
Expected: PASS.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/weaveShares.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envPaths } from '../../src/envPaths';
import { planAllPhases, weaveShares } from '../../src/weaveShares';

let work: string; // acts as cwd; .configamatron lives under it
let templates: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'weave-shares-'));
  templates = join(work, 'templates');
  // Built-in template phase folders (both platforms).
  mkdirSync(join(templates, 'vm-shared', 'pre-scripts'), { recursive: true });
  mkdirSync(join(templates, 'vm-shared', 'post-scripts'), { recursive: true });
  mkdirSync(join(templates, 'vm-shared-windows', 'pre-scripts'), { recursive: true });
  mkdirSync(join(templates, 'vm-shared-windows', 'post-scripts'), { recursive: true });
  writeFileSync(join(templates, 'vm-shared', 'pre-scripts', '01-apt.sh'), 'apt');
  writeFileSync(join(templates, 'vm-shared', 'pre-scripts', 'nn-network.sh'), 'net');
  writeFileSync(join(templates, 'vm-shared', 'pre-scripts', 'dnsmasq.conf'), 'conf');
  writeFileSync(join(templates, 'vm-shared', 'post-scripts', '01-auth.sh'), 'auth');
  writeFileSync(join(templates, 'vm-shared-windows', 'pre-scripts', '01-pkg.ps1'), 'pkg');
  writeFileSync(join(templates, 'vm-shared-windows', 'pre-scripts', 'nn-network.ps1'), 'net');
  writeFileSync(join(templates, 'vm-shared-windows', 'post-scripts', '01-auth.ps1'), 'auth');
  // Custom source folders (empty to start).
  mkdirSync(join(work, '.configamatron', 'pre-scripts'), { recursive: true });
  mkdirSync(join(work, '.configamatron', 'post-scripts'), { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('weaveShares', () => {
  it('renumbers built-ins with the sentinel last and copies passthrough beside them', () => {
    const paths = envPaths(work);
    weaveShares({ templatesDir: templates, paths });
    const pre = join(paths.vmShared, 'pre-scripts');
    expect(readdirSync(pre).sort()).toEqual(['01-apt.sh', '02-network.sh', 'dnsmasq.conf']);
    expect(readdirSync(join(paths.vmSharedWindows, 'pre-scripts')).sort()).toEqual([
      '01-pkg.ps1',
      '02-network.ps1',
    ]);
  });

  it('weaves a custom pre-script in before the network sentinel', () => {
    const paths = envPaths(work);
    writeFileSync(join(paths.preScripts, '01-docker.sh'), 'docker');
    weaveShares({ templatesDir: templates, paths });
    expect(readdirSync(join(paths.vmShared, 'pre-scripts')).sort()).toEqual([
      '01-apt.sh', // built-in first
      '02-docker.sh', // custom next
      '03-network.sh', // sentinel strictly last
      'dnsmasq.conf',
    ]);
  });

  it('copies custom passthrough into BOTH shares', () => {
    const paths = envPaths(work);
    mkdirSync(join(paths.preScripts, 'lib'));
    writeFileSync(join(paths.preScripts, 'lib', 'helper.sh'), 'h');
    weaveShares({ templatesDir: templates, paths });
    expect(existsSync(join(paths.vmShared, 'pre-scripts', 'lib', 'helper.sh'))).toBe(true);
    expect(existsSync(join(paths.vmSharedWindows, 'pre-scripts', 'lib', 'helper.sh'))).toBe(true);
  });

  it('keeps built-in passthrough on its own platform only', () => {
    const paths = envPaths(work);
    weaveShares({ templatesDir: templates, paths });
    // dnsmasq.conf is a Linux built-in resource; it must not appear on Windows.
    expect(existsSync(join(paths.vmSharedWindows, 'pre-scripts', 'dnsmasq.conf'))).toBe(false);
  });

  it('aborts without mutating any share when a custom folder has a bad name', () => {
    const paths = envPaths(work);
    writeFileSync(join(paths.postScripts, 'bad.sh'), 'nope'); // no prefix
    expect(() => weaveShares({ templatesDir: templates, paths })).toThrow(/bad\.sh/);
    // No phase folder was created in the shares.
    expect(existsSync(join(paths.vmShared, 'pre-scripts'))).toBe(false);
    expect(existsSync(join(paths.vmShared, 'post-scripts'))).toBe(false);
  });

  it('fails loud on a resource-vs-generated-script collision, naming both sides', () => {
    const paths = envPaths(work);
    // A custom passthrough directory named exactly like the generated network script.
    mkdirSync(join(paths.preScripts, '02-network.sh'));
    writeFileSync(join(paths.preScripts, '02-network.sh', 'inner'), 'x');
    let message = '';
    try {
      planAllPhases({ templatesDir: templates, paths });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('02-network.sh');
    // Both sides are labeled built-in vs custom so the fix is obvious.
    expect(message).toMatch(/built-in script/);
    expect(message).toMatch(/custom resource/);
  });

  it('aggregates errors from both phases in one throw', () => {
    const paths = envPaths(work);
    writeFileSync(join(paths.preScripts, 'bad-pre.sh'), 'x'); // no prefix (pre)
    writeFileSync(join(paths.postScripts, 'bad-post.sh'), 'x'); // no prefix (post)
    let message = '';
    try {
      planAllPhases({ templatesDir: templates, paths });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('bad-pre.sh');
    expect(message).toContain('bad-post.sh');
  });

  it('replaces a phase folder, dropping files the user deleted', () => {
    const paths = envPaths(work);
    writeFileSync(join(paths.preScripts, '01-docker.sh'), 'docker');
    weaveShares({ templatesDir: templates, paths });
    expect(existsSync(join(paths.vmShared, 'pre-scripts', '02-docker.sh'))).toBe(true);
    // Remove the custom script and re-weave: it must disappear (replace, not overlay).
    rmSync(join(paths.preScripts, '01-docker.sh'));
    weaveShares({ templatesDir: templates, paths });
    expect(existsSync(join(paths.vmShared, 'pre-scripts', '02-docker.sh'))).toBe(false);
    expect(readdirSync(join(paths.vmShared, 'pre-scripts')).sort()).toEqual([
      '01-apt.sh',
      '02-network.sh',
      'dnsmasq.conf',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/weaveShares.test.ts`
Expected: FAIL — `Cannot find module '../../src/weaveShares'`.

- [ ] **Step 3: Write the implementation**

Create `src/weaveShares.ts`:

```ts
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EnvPaths } from './envPaths';
import { isDnsResponderBuildArtifact } from './dnsResponder';
import { readFolderContents, renumber, type OrderedScript, type ScriptExtension } from './weaveScripts';
import { detectCollisions, type Collision, type WeaveItem } from './collisions';

export interface WeaveAction {
  kind: 'file' | 'dir';
  src: string;
  /** Path relative to livePhaseDir. */
  destRel: string;
}

export interface PhasePlan {
  livePhaseDir: string;
  actions: WeaveAction[];
}

interface PlatformSpec {
  extension: ScriptExtension;
  builtinShareDir: string;
  outShareDir: string;
  caseInsensitive: boolean;
}

const PHASE_DIRS = ['pre-scripts', 'post-scripts'] as const;

/**
 * Build (and fully validate) a plan for every phase × platform. Accumulates every
 * phase's error (naming, overflow, collisions) rather than stopping at the first,
 * so a single run reports all offenders across both phases and both platforms.
 */
export function planAllPhases(opts: { templatesDir: string; paths: EnvPaths }): PhasePlan[] {
  const { templatesDir, paths } = opts;
  const platforms: PlatformSpec[] = [
    {
      extension: 'sh',
      builtinShareDir: join(templatesDir, 'vm-shared'),
      outShareDir: paths.vmShared,
      caseInsensitive: false,
    },
    {
      extension: 'ps1',
      builtinShareDir: join(templatesDir, 'vm-shared-windows'),
      outShareDir: paths.vmSharedWindows,
      caseInsensitive: true,
    },
  ];

  const plans: PhasePlan[] = [];
  const errors: string[] = [];
  for (const phaseDir of PHASE_DIRS) {
    for (const platform of platforms) {
      try {
        plans.push(
          planPhase({
            builtinPhaseDir: join(platform.builtinShareDir, phaseDir),
            customPhaseDir: join(paths.root, phaseDir),
            outPhaseDir: join(platform.outShareDir, phaseDir),
            extension: platform.extension,
            caseInsensitive: platform.caseInsensitive,
          }),
        );
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n\n'));
  return plans;
}

function planPhase(opts: {
  builtinPhaseDir: string;
  customPhaseDir: string;
  outPhaseDir: string;
  extension: ScriptExtension;
  caseInsensitive: boolean;
}): PhasePlan {
  const builtin = readFolderContents({
    dir: opts.builtinPhaseDir,
    extension: opts.extension,
    allowSentinel: true,
    strictExtension: true,
  });
  const custom = readFolderContents({
    dir: opts.customPhaseDir,
    extension: opts.extension,
    allowSentinel: false,
    strictExtension: false,
  });

  // Two solid blocks — built-in then custom — with the reserved 'nn' sentinel
  // (built-in only) floated to the very end so network isolation always runs last,
  // after every custom pre-script. Custom folders never contain a sentinel. Each
  // script carries its origin label so a collision message names both sides.
  const builtinNonSentinel = builtin.scripts.filter((s) => !s.sentinel);
  const builtinSentinel = builtin.scripts.filter((s) => s.sentinel);
  const labeled: { script: OrderedScript; label: 'built-in' | 'custom' }[] = [
    ...builtinNonSentinel.map((script) => ({ script, label: 'built-in' as const })),
    ...custom.scripts.map((script) => ({ script, label: 'custom' as const })),
    ...builtinSentinel.map((script) => ({ script, label: 'built-in' as const })),
  ];
  // renumber preserves order and length, so the two arrays zip index-for-index.
  const renumbered = renumber(labeled.map((l) => l.script));

  const actions: WeaveAction[] = [];
  const items: WeaveItem[] = [];
  renumbered.forEach((r, i) => {
    actions.push({ kind: 'file', src: r.sourcePath, destRel: r.outputName });
    items.push({
      destPath: r.outputName,
      kind: 'file',
      origin: `${labeled[i].label} script ${r.outputName}`,
    });
  });

  // Passthrough resources: built-in first, then custom. Origin labels distinguish
  // built-in vs custom so a collision message names both sides unambiguously.
  for (const [label, list] of [
    ['built-in', builtin.passthrough],
    ['custom', custom.passthrough],
  ] as const) {
    for (const p of list) {
      actions.push({ kind: p.isDirectory ? 'dir' : 'file', src: p.sourcePath, destRel: p.name });
      if (p.isDirectory) expandDir(p.sourcePath, p.name, label, items);
      else items.push({ destPath: p.name, kind: 'file', origin: `${label} resource ${p.name}` });
    }
  }

  const collisions = detectCollisions(items, { caseInsensitive: opts.caseInsensitive });
  if (collisions.length > 0) throw new Error(formatCollisions(opts.outPhaseDir, collisions));

  return { livePhaseDir: opts.outPhaseDir, actions };
}

function expandDir(absDir: string, relBase: string, label: string, out: WeaveItem[]): void {
  out.push({ destPath: relBase, kind: 'dir', origin: `${label} resource ${relBase}/` });
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const childRel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) expandDir(join(absDir, entry.name), childRel, label, out);
    else out.push({ destPath: childRel, kind: 'file', origin: `${label} resource ${childRel}` });
  }
}

function formatCollisions(outPhaseDir: string, collisions: Collision[]): string {
  const lines = collisions.map((c) => `  - ${c.destPath}: ${c.reason} (${c.a} vs ${c.b})`);
  return `resource/script collisions in ${outPhaseDir}:\n${lines.join('\n')}`;
}

/**
 * Stage every plan into a sibling ".staging" dir; only once ALL staging succeeds,
 * swap each into place (moving the live dir to a backup and restoring every swap
 * on any failure). Recording the swap before the promotion rename means a failure
 * there still rolls the entry back. This minimizes the window and matches the
 * existing per-target recovery.
 */
export function executePlans(plans: PhasePlan[]): void {
  const staged: { live: string; staging: string }[] = [];
  try {
    for (const plan of plans) {
      const staging = `${plan.livePhaseDir}.staging-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      // Record before copying so a mid-copy failure still cleans this partial dir.
      staged.push({ live: plan.livePhaseDir, staging });
      for (const action of plan.actions) {
        const dest = join(staging, action.destRel);
        mkdirSync(dirname(dest), { recursive: true });
        if (action.kind === 'dir') {
          cpSync(action.src, dest, {
            recursive: true,
            filter: (source) => !isDnsResponderBuildArtifact(source),
          });
        } else {
          copyFileSync(action.src, dest);
        }
      }
    }
  } catch (error) {
    for (const s of staged) rmSync(s.staging, { recursive: true, force: true });
    throw error;
  }

  const swapped: { live: string; backup: string; hadLive: boolean }[] = [];
  try {
    for (const { live, staging } of staged) {
      const backup = `${live}.backup-${process.pid}`;
      rmSync(backup, { recursive: true, force: true });
      const hadLive = existsSync(live);
      if (hadLive) renameSync(live, backup);
      // Record BEFORE the promotion rename so a failure there is still rolled back.
      swapped.push({ live, backup, hadLive });
      renameSync(staging, live);
    }
  } catch (error) {
    for (const { live, backup, hadLive } of swapped) {
      rmSync(live, { recursive: true, force: true });
      if (hadLive && existsSync(backup)) renameSync(backup, live);
    }
    for (const { staging } of staged) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  for (const { backup } of swapped) rmSync(backup, { recursive: true, force: true });
}

export function weaveShares(opts: { templatesDir: string; paths: EnvPaths }): void {
  executePlans(planAllPhases(opts));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/weaveShares.test.ts`
Expected: PASS (all cases, including the abort-without-mutating and replace-not-overlay checks).

- [ ] **Step 5: Format, then commit**

```bash
pnpm format
git add src/weaveShares.ts tests/unit/weaveShares.test.ts
git commit -m "feat: add whole-transaction weave orchestrator for VM shares"
```

---

## Task 5: Inverted `.gitignore` template (allowlist)

Replace the denylist `templates/configamatron.gitignore` with an allowlist that ignores everything and re-includes only the user-authored surface. Add a stable content-assertion test.

**Files:**

- Modify: `templates/configamatron.gitignore`
- Test: `tests/unit/gitignore.test.ts` (create)

**Interfaces:** none (template + test only).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/gitignore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { templatesDir } from '../../src/templates';

describe('configamatron.gitignore (allowlist)', () => {
  const gitignore = readFileSync(join(templatesDir(), 'configamatron.gitignore'), 'utf8');

  it('ignores everything by default', () => {
    expect(gitignore).toMatch(/^\*$/m);
  });

  it('re-includes the user-authored customization surface', () => {
    for (const line of [
      '!/.gitignore',
      '!/pre-scripts/',
      '!/pre-scripts/**',
      '!/post-scripts/',
      '!/post-scripts/**',
      '!/home-jq-transforms/',
      '!/home-jq-transforms/**',
      '!/proxy/',
      '!/proxy/allowlist.txt',
    ]) {
      expect(gitignore, line).toContain(line);
    }
  });

  it('does not enumerate secrets to exclude (they fall under the default ignore)', () => {
    expect(gitignore).not.toContain('proxy/secrets/');
    expect(gitignore).not.toContain('credentials.json');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/gitignore.test.ts`
Expected: FAIL — the current denylist has no bare `*` line and no `!/pre-scripts/` re-includes.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `templates/configamatron.gitignore` with:

```gitignore
# .configamatron/ is committed, but only the files you author. Everything the tool
# generates or that holds secrets is ignored by default; the entries below opt the
# user-authored customization surface back into source control across installs.

# Ignore everything by default.
*

# ...except the user-authored inputs:
!/.gitignore
!/pre-scripts/
!/pre-scripts/**
!/post-scripts/
!/post-scripts/**
!/home-jq-transforms/
!/home-jq-transforms/**
!/proxy/
!/proxy/allowlist.txt
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/gitignore.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, then commit**

```bash
pnpm format
git add templates/configamatron.gitignore tests/unit/gitignore.test.ts
git commit -m "feat: invert .configamatron gitignore to a user-authored allowlist"
```

---

## Task 6: Reorganize built-in templates and weave them in `init`

Move the built-in scripts into `pre-scripts/`/`post-scripts/`, rename `05-configure-network`→`nn-configure-network`, change the built-in scripts' environment-file references to the script's parent dir, point the applier bundle at `post-scripts/`, and make `init` scaffold the custom folders and run the weave so the generated shares are woven. This is one cohesive deliverable: the generated shares become woven output.

**Files:**

- Move (git mv) built-in scripts + resources into `templates/vm-shared/{pre,post}-scripts/` and `templates/vm-shared-windows/{pre,post}-scripts/` (details below).
- Modify: `templates/vm-shared/pre-scripts/nn-configure-network.sh`, `templates/vm-shared/post-scripts/01-auth-config.sh`, `templates/vm-shared/post-scripts/02-apply-home-jq-transforms.sh`, and the three `.ps1` equivalents (env-file references → parent dir).
- Modify: `scripts/copy-vm-applier.mjs`, `.gitignore` (root — applier artifact path)
- Modify: `src/initEnv.ts`
- Test: `tests/unit/templates.test.ts`, `tests/unit/initEnv.test.ts`, `tests/e2e/init.test.ts`, `tests/e2e/vmApplier.test.ts`

**Interfaces:**

- Consumes: `weaveShares` (Task 4), `envPaths` (Task 3).
- Produces: generated shares now contain `pre-scripts/` and `post-scripts/` with woven, renumbered scripts + resources; `.configamatron/pre-scripts/` and `post-scripts/` scaffolded with `README.md`.

- [ ] **Step 1: Move and rename the built-in template files**

Run these `git mv` commands (create the target dirs first). The exact mapping:

```bash
# --- Linux: templates/vm-shared ---
mkdir -p templates/vm-shared/pre-scripts templates/vm-shared/post-scripts
git mv templates/vm-shared/01-apt-packages.sh          templates/vm-shared/pre-scripts/01-apt-packages.sh
git mv templates/vm-shared/02-install-pnpm.sh          templates/vm-shared/pre-scripts/02-install-pnpm.sh
git mv templates/vm-shared/03-install-tools.sh         templates/vm-shared/pre-scripts/03-install-tools.sh
git mv templates/vm-shared/04-configure-tools.sh       templates/vm-shared/pre-scripts/04-configure-tools.sh
git mv templates/vm-shared/05-configure-network.sh     templates/vm-shared/pre-scripts/nn-configure-network.sh
git mv templates/vm-shared/dnsmasq-stub.conf           templates/vm-shared/pre-scripts/dnsmasq-stub.conf
git mv templates/vm-shared/configamatron-egress.service templates/vm-shared/pre-scripts/configamatron-egress.service
git mv templates/vm-shared/60-dns-override.yaml        templates/vm-shared/pre-scripts/60-dns-override.yaml
git mv templates/vm-shared/06-auth-config.sh           templates/vm-shared/post-scripts/01-auth-config.sh
git mv templates/vm-shared/07-apply-home-jq-transforms.sh templates/vm-shared/post-scripts/02-apply-home-jq-transforms.sh
# verify-config.sh STAYS at the share root.
# apply-home-jq-transforms.mjs is a build artifact (gitignored); Step 3 relocates the copy target.

# --- Windows: templates/vm-shared-windows ---
mkdir -p templates/vm-shared-windows/pre-scripts templates/vm-shared-windows/post-scripts
git mv templates/vm-shared-windows/01-install-packages.ps1   templates/vm-shared-windows/pre-scripts/01-install-packages.ps1
git mv templates/vm-shared-windows/02-install-pnpm.ps1       templates/vm-shared-windows/pre-scripts/02-install-pnpm.ps1
git mv templates/vm-shared-windows/03-install-tools.ps1      templates/vm-shared-windows/pre-scripts/03-install-tools.ps1
git mv templates/vm-shared-windows/04-configure-tools.ps1    templates/vm-shared-windows/pre-scripts/04-configure-tools.ps1
git mv templates/vm-shared-windows/05-configure-network.ps1  templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1
git mv templates/vm-shared-windows/dns-responder             templates/vm-shared-windows/pre-scripts/dns-responder
git mv templates/vm-shared-windows/06-auth-config.ps1        templates/vm-shared-windows/post-scripts/01-auth-config.ps1
git mv templates/vm-shared-windows/07-apply-home-jq-transforms.ps1 templates/vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1
# verify-config.ps1 STAYS at the share root.
```

- [ ] **Step 2: Update the built-in scripts' environment-file references to the parent dir**

The scripts moved one level down (into `<phase>/`), so the share-root files they read (`cert.pem`, `github-config.txt`, `credentials.json`, `auth.json`, `home-jq-transforms/`) are now one directory up. Use `dirname`/`Split-Path -Parent` so the resolved path stays clean (the VM test asserts on the exact symlink target).

In `templates/vm-shared/pre-scripts/nn-configure-network.sh`, change the cert default. Replace:

```bash
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_path="${2:-${script_dir}/cert.pem}"
```

with:

```bash
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
share_root="$(dirname "$script_dir")"
cert_path="${2:-${share_root}/cert.pem}"
```

(The `${script_dir}/dnsmasq-stub.conf`, `${script_dir}/configamatron-egress.service`, and `${script_dir}/60-dns-override.yaml` references stay unchanged — those resources travel with the script into `pre-scripts/`.)

In `templates/vm-shared/post-scripts/01-auth-config.sh`, the `dir` variable is the script dir; the three env files move up one level. Replace:

```bash
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```

with:

```bash
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$(dirname "$script_dir")"
```

(`config_path="$dir/github-config.txt"`, `"${dir}/credentials.json"`, and `"${dir}/auth.json"` then all resolve to the share root — leave those lines as-is.)

In `templates/vm-shared/post-scripts/02-apply-home-jq-transforms.sh`, the `.mjs` stays beside the script but `home-jq-transforms/` is at the share root. Replace:

```bash
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$script_dir/apply-home-jq-transforms.mjs" "$script_dir/home-jq-transforms"
```

with:

```bash
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
share_root="$(dirname "$script_dir")"

node "$script_dir/apply-home-jq-transforms.mjs" "$share_root/home-jq-transforms"
```

In `templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1`, replace:

```powershell
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CertPath) { $CertPath = Join-Path $scriptDir 'cert.pem' }
```

with:

```powershell
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shareRoot = Split-Path -Parent $scriptDir
if (-not $CertPath) { $CertPath = Join-Path $shareRoot 'cert.pem' }
```

(The `dns-responder` reference `Join-Path $scriptDir 'dns-responder'` stays — that folder travels into `pre-scripts/`.)

In `templates/vm-shared-windows/post-scripts/01-auth-config.ps1`, the two placeholder credential files and `github-config.txt` move up. Replace:

```powershell
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
```

with:

```powershell
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shareRoot = Split-Path -Parent $scriptDir
```

Then update the three consuming lines to use `$shareRoot`:
- `$configPath = Join-Path $scriptDir 'github-config.txt'` → `Join-Path $shareRoot 'github-config.txt'`
- `Copy-Item -Force (Join-Path $scriptDir 'credentials.json') …` → `Join-Path $shareRoot 'credentials.json'`
- `Copy-Item -Force (Join-Path $scriptDir 'auth.json') …` → `Join-Path $shareRoot 'auth.json'`

In `templates/vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1`, replace:

```powershell
& node (Join-Path $PSScriptRoot 'apply-home-jq-transforms.mjs') (Join-Path $PSScriptRoot 'home-jq-transforms')
```

with:

```powershell
$shareRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'apply-home-jq-transforms.mjs') (Join-Path $shareRoot 'home-jq-transforms')
```

- [ ] **Step 3: Point the applier-bundle copy at `post-scripts/` and update the ignore path**

In `scripts/copy-vm-applier.mjs`, change the destination so the bundled `.mjs` lands beside its wrapper:

```js
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'dist', 'apply-home-jq-transforms.js');
for (const share of ['vm-shared', 'vm-shared-windows']) {
  copyFileSync(src, join(root, 'templates', share, 'post-scripts', 'apply-home-jq-transforms.mjs'));
}
console.log('copied apply-home-jq-transforms.mjs into template post-scripts folders');
```

The root `.gitignore` pins this build artifact to its old location, so update those two lines to the new `post-scripts/` path (otherwise the relocated bundle would be committable):

```gitignore
templates/vm-shared/post-scripts/apply-home-jq-transforms.mjs
templates/vm-shared-windows/post-scripts/apply-home-jq-transforms.mjs
```

Delete the stale bundles at the old paths so `init`'s `cpSync` does not carry them into the share root:

```bash
rm -f templates/vm-shared/apply-home-jq-transforms.mjs templates/vm-shared-windows/apply-home-jq-transforms.mjs
```

- [ ] **Step 4: Scaffold custom folders and weave, in `initEnvironment`**

In `src/initEnv.ts`, add `mkdirSync` to the `node:fs` import and import the weave. The weave must be **validated before any share is written** (Global Constraints: no share touched until all checks pass), so plan first, mutate last.

Update the imports at the top (the `./dnsResponder` import was already added in Task 4 Step 0; add `mkdirSync` and the weave functions):

```ts
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envPaths } from './envPaths';
import { sanitizeCredentials } from './sanitizeCredentials';
import { sanitizeCodexCredentials } from './sanitizeCodexCredentials';
import { isDnsResponderBuildArtifact } from './dnsResponder';
import { planAllPhases, executePlans } from './weaveShares';
```

Add these placeholder constants near the top of the file (after the imports):

```ts
const PRE_SCRIPTS_README = `# pre-scripts

Your own VM setup scripts go here. A runnable step is a file named \`NN-name.sh\`
or \`NN-name.ps1\` (two-digit prefix, \`-\` or \`_\` separator, lowercase extension).
They run, in order, **before** the built-in network-isolation step, so they still
have full network access.

Reference sibling files with \`$script_dir/<name>\` (bash) or
\`Join-Path $PSScriptRoot <name>\` (PowerShell). Anything that is not a runnable
step (other extensions, subfolders) is copied through untouched. Run
\`configamatron update-shares\` after editing.
`;

const POST_SCRIPTS_README = `# post-scripts

Your own VM setup scripts go here. A runnable step is a file named \`NN-name.sh\`
or \`NN-name.ps1\` (two-digit prefix, \`-\` or \`_\` separator, lowercase extension).
They run, in order, **after** network isolation and the reboot.

Reference sibling files with \`$script_dir/<name>\` (bash) or
\`Join-Path $PSScriptRoot <name>\` (PowerShell). Anything that is not a runnable
step (other extensions, subfolders) is copied through untouched. Run
\`configamatron update-shares\` after editing.
`;
```

Insert the scaffolding **and the weave preflight** immediately **before** the first `cpSync(join(options.templatesDir, 'vm-shared'), …)` line (i.e. after the codex sanitization block, before any share is created):

```ts
  // Scaffold the user-editable custom script folders first. git does not track
  // empty dirs, so seed each with a placeholder README that survives commit/clone.
  // (These are source folders under .configamatron/, not shares.)
  mkdirSync(paths.preScripts, { recursive: true });
  writeFileSync(join(paths.preScripts, 'README.md'), PRE_SCRIPTS_README);
  mkdirSync(paths.postScripts, { recursive: true });
  writeFileSync(join(paths.postScripts, 'README.md'), POST_SCRIPTS_README);

  // Validate the weave (built-ins + the just-scaffolded custom folders) before
  // touching any share, so a template/naming/collision fault aborts with nothing
  // half-written into vm-shared/.
  const plans = planAllPhases({ templatesDir: options.templatesDir, paths });
```

Then, at the very end of `initEnvironment` (after the `copyFileSync(… paths.gitignore)` line), execute the already-validated plans:

```ts
  // Replace each generated <phase>/ folder with the woven, renumbered output so a
  // freshly initialized environment is runnable without a separate update-shares.
  executePlans(plans);
```

Note: `initEnvironment` still `cpSync`s each whole template share (bringing in `verify-config.*` at the share root and the built-in phase folders verbatim); `executePlans` then replaces each `<phase>/` folder with the woven output. The verbatim phase-folder copy is transient and immediately superseded. Because `planAllPhases` ran before the first `cpSync`, a weave fault leaves no share partially written.

- [ ] **Step 5: Update `tests/unit/templates.test.ts`**

Replace the `expectedTemplateFiles` array entries for the shares with the new phase-folder paths (built-ins keep `nn-` naming in the templates — they are only renumbered in the generated share):

```ts
const expectedTemplateFiles = [
  'vm-shared/pre-scripts/01-apt-packages.sh',
  'vm-shared/pre-scripts/02-install-pnpm.sh',
  'vm-shared/pre-scripts/03-install-tools.sh',
  'vm-shared/pre-scripts/04-configure-tools.sh',
  'vm-shared/pre-scripts/nn-configure-network.sh',
  'vm-shared/pre-scripts/dnsmasq-stub.conf',
  'vm-shared/pre-scripts/60-dns-override.yaml',
  'vm-shared/pre-scripts/configamatron-egress.service',
  'vm-shared/post-scripts/01-auth-config.sh',
  'vm-shared/post-scripts/02-apply-home-jq-transforms.sh',
  'vm-shared/verify-config.sh',
  'proxy/docker-compose.yml',
  'proxy/gate.lua',
  'proxy/host-allow-vm-inbound.ps1',
  'proxy/verify-proxy.ps1',
  'vm-shared-windows/pre-scripts/01-install-packages.ps1',
  'vm-shared-windows/pre-scripts/02-install-pnpm.ps1',
  'vm-shared-windows/pre-scripts/03-install-tools.ps1',
  'vm-shared-windows/pre-scripts/04-configure-tools.ps1',
  'vm-shared-windows/pre-scripts/nn-configure-network.ps1',
  'vm-shared-windows/pre-scripts/dns-responder/ConfigamatronDnsResponder.csproj',
  'vm-shared-windows/pre-scripts/dns-responder/Program.cs',
  'vm-shared-windows/post-scripts/01-auth-config.ps1',
  'vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1',
  'vm-shared-windows/verify-config.ps1',
  'home-jq-transforms/manifest.yaml',
  'home-jq-transforms/vscode-settings.jq',
  'home-jq-transforms/claude-onboarding.jq',
  'configamatron.gitignore',
];
```

Then update every `readFileSync(join(templatesDir(), …))` path in the content-assertion tests to the new locations. The exact renames within this file:
- `'vm-shared-windows', '06-auth-config.ps1'` → `'vm-shared-windows', 'post-scripts', '01-auth-config.ps1'` (three occurrences)
- `'vm-shared-windows', '05-configure-network.ps1'` → `'vm-shared-windows', 'pre-scripts', 'nn-configure-network.ps1'` (three occurrences)
- `'vm-shared-windows', 'verify-config.ps1'` → unchanged (stays at root)
- `'vm-shared-windows', 'dns-responder', 'Program.cs'` → `'vm-shared-windows', 'pre-scripts', 'dns-responder', 'Program.cs'`
- `'vm-shared', '01-apt-packages.sh'` → `'vm-shared', 'pre-scripts', '01-apt-packages.sh'`
- `'vm-shared', '05-configure-network.sh'` → `'vm-shared', 'pre-scripts', 'nn-configure-network.sh'`

- [ ] **Step 6: Update `tests/unit/initEnv.test.ts`**

The generated share now contains woven, renumbered scripts under `<phase>/`. Update the first test's file list (the woven output restarts numbering at `01` per phase and drops the `nn` sentinel to a real number):

```ts
    for (const file of [
      'vm-shared/pre-scripts/01-apt-packages.sh',
      'vm-shared/pre-scripts/05-configure-network.sh',
      'vm-shared/pre-scripts/configamatron-egress.service',
      'vm-shared/post-scripts/01-auth-config.sh',
      'vm-shared/post-scripts/02-apply-home-jq-transforms.sh',
      'vm-shared/verify-config.sh',
      'vm-shared/credentials.json',
      'proxy/docker-compose.yml',
      'proxy/gate.lua',
      'proxy/host-allow-vm-inbound.ps1',
      'proxy/allowlist.txt',
      'vm-shared-windows/pre-scripts/01-install-packages.ps1',
      'vm-shared-windows/pre-scripts/05-configure-network.ps1',
      'vm-shared-windows/post-scripts/01-auth-config.ps1',
      'vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1',
      'vm-shared-windows/verify-config.ps1',
      'vm-shared-windows/pre-scripts/dns-responder/Program.cs',
      'vm-shared-windows/credentials.json',
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
```

In the `'does not copy dns-responder bin/obj build artifacts…'` test, the built-in dns-responder now lives under `pre-scripts/`. Change the two fixture paths and the copied-output path:

```ts
    const templateDnsDir = join(templatesDir(), 'vm-shared-windows', 'pre-scripts', 'dns-responder');
    // …unchanged bin/obj creation…
      const copiedDns = join(dir, ENV_DIR_NAME, 'vm-shared-windows', 'pre-scripts', 'dns-responder');
```

Add a new test asserting the custom folders are scaffolded with READMEs:

```ts
  it('scaffolds empty custom pre/post script folders with placeholder READMEs', () => {
    initEnvironment(options());
    const root = join(dir, ENV_DIR_NAME);
    expect(existsSync(join(root, 'pre-scripts', 'README.md'))).toBe(true);
    expect(existsSync(join(root, 'post-scripts', 'README.md'))).toBe(true);
  });
```

- [ ] **Step 7: Update `tests/e2e/init.test.ts`**

The existing assertions (`allowlist.txt`, `vm-shared/credentials.json`, stdout contains `generate-ca`/`update-shares`/`home-jq-transforms`) still hold. Add one assertion to the first test proving a runnable woven share results:

```ts
      expect(
        existsSync(join(dir, '.configamatron', 'vm-shared', 'pre-scripts', '05-configure-network.sh')),
      ).toBe(true);
      expect(existsSync(join(dir, '.configamatron', 'pre-scripts', 'README.md'))).toBe(true);
```

- [ ] **Step 8: Update `tests/e2e/vmApplier.test.ts` for the relocated bundle**

This packaging test asserts the applier's template path, which moved into `post-scripts/`. Update the two path constants near the top of the file:

```ts
const applierUbuntu = join(
  repoRoot,
  'templates',
  'vm-shared',
  'post-scripts',
  'apply-home-jq-transforms.mjs',
);
const applierWindows = join(
  repoRoot,
  'templates',
  'vm-shared-windows',
  'post-scripts',
  'apply-home-jq-transforms.mjs',
);
```

And update the two `pnpm pack --dry-run` assertions in the `'is listed in the npm package'` test:

```ts
    expect(files).toContain('templates/vm-shared/post-scripts/apply-home-jq-transforms.mjs');
    expect(files).toContain('templates/vm-shared-windows/post-scripts/apply-home-jq-transforms.mjs');
```

- [ ] **Step 9: Run unit tests, typecheck, then build + e2e**

Run: `pnpm vitest run tests/unit/templates.test.ts tests/unit/initEnv.test.ts && pnpm typecheck`
Expected: PASS.

Run: `pnpm build && pnpm test:e2e`
Expected: PASS — `pnpm build` runs `copy-vm-applier.mjs` (now targeting `post-scripts/`), and the init e2e + `vmApplier` packaging test see the relocated bundle.

- [ ] **Step 10: Format, then commit**

```bash
pnpm format
git add templates/ scripts/copy-vm-applier.mjs .gitignore src/initEnv.ts tests/unit/templates.test.ts tests/unit/initEnv.test.ts tests/e2e/init.test.ts tests/e2e/vmApplier.test.ts
git commit -m "feat: reorganize built-in scripts into pre/post folders and weave them in init"
```

---

## Task 7: Weave in `update-shares` (whole-transaction)

Extend `update-shares` so it also weaves the pre/post scripts into the shares, running all preflight (jq previews + weave validation) before mutating anything.

**Files:**

- Modify: `src/commands/updateShares.ts`
- Test: `tests/e2e/updateShares.test.ts`

**Interfaces:**

- Consumes: `planAllPhases`, `executePlans` (Task 4); `templatesDir` from `src/templates.ts`; existing `previewTransforms`, `requireEnvPathsOrExit`.

- [ ] **Step 1: Write the failing test**

Add these tests to `tests/e2e/updateShares.test.ts` (inside the existing `describe.skipIf(!hasJq)(…)` block):

```ts
  it('reweaves pre/post scripts, adding a custom step and dropping deleted ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      const preSrc = join(dir, '.configamatron', 'pre-scripts');
      writeFileSync(join(preSrc, '01-docker.sh'), 'echo docker\n');
      const { exitCode } = await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      expect(exitCode).toBe(0);
      const wovenPre = join(dir, '.configamatron', 'vm-shared', 'pre-scripts');
      // 4 built-in pre steps, then the custom docker step, then the network sentinel
      // renumbered strictly last: 01-04 built-ins, 05-docker, 06-configure-network.
      expect(existsSync(join(wovenPre, '05-docker.sh'))).toBe(true);
      expect(existsSync(join(wovenPre, '06-configure-network.sh'))).toBe(true);

      // Delete the custom step and re-weave: it must disappear (replace, not overlay).
      rmSync(join(preSrc, '01-docker.sh'));
      await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      expect(existsSync(join(wovenPre, '05-docker.sh'))).toBe(false);
      expect(existsSync(join(wovenPre, '05-configure-network.sh'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts the whole run (no share mutated) on an invalid custom script name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      writeFileSync(join(dir, '.configamatron', 'post-scripts', 'bad.sh'), 'oops\n'); // no NN prefix
      const before = existsSync(
        join(dir, '.configamatron', 'vm-shared', 'post-scripts', '02-apply-home-jq-transforms.sh'),
      );
      expect(before).toBe(true);
      const { exitCode, stderr } = await execa('node', [cliPath, 'update-shares'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('bad.sh');
      // The existing woven output is untouched.
      expect(
        existsSync(
          join(dir, '.configamatron', 'vm-shared', 'post-scripts', '02-apply-home-jq-transforms.sh'),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/updateShares.test.ts`
Expected: FAIL — `update-shares` does not yet weave, so `05-docker.sh` is absent and the invalid name is not caught.

- [ ] **Step 3: Write the implementation**

The existing command does its own stage-then-swap loop for `home-jq-transforms`, then would swap the weave separately — two transactions, so a weave failure could leave the jq copies already changed. Fold both into a **single** `executePlans` batch (all staging succeeds before any swap), which also deletes the bespoke copy loop.

In `src/commands/updateShares.ts`, replace the imports so `cpSync`/`renameSync`/`existsSync` (only used by the old loop) are dropped and the weave is added:

```ts
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { previewTransforms } from '../homeJqTransforms';
import { planAllPhases, executePlans, type PhasePlan } from '../weaveShares';
import { templatesDir } from '../templates';
```

(Remove the old `import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';` line — none are needed anymore.)

Then replace everything from the `if (hasError) { … }` guard's end through the end of the old copy loop with:

```ts
      if (hasError) {
        console.error(
          '\nupdate-shares: a transform failed its preview; not copying. Fix the .jq and re-run.',
        );
        process.exitCode = 1;
        return;
      }

      // Preflight the script weave alongside the jq previews: validate naming and
      // resource collisions across both phases and platforms before mutating anything.
      let plans: PhasePlan[];
      try {
        plans = planAllPhases({ templatesDir: templatesDir(), paths });
      } catch (error) {
        console.error(`update-shares: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // The home-jq-transforms refresh joins the same transaction: each share's
      // copy is modeled as a directory-replacement plan (destRel '.' copies the
      // source folder's contents into the staged dir), so all staging completes
      // before any swap.
      const homeJqPlans: PhasePlan[] = paths.vmSharedTargets.map((target) => ({
        livePhaseDir: target.homeJqTransforms,
        actions: [{ kind: 'dir', src: paths.homeJqTransforms, destRel: '.' }],
      }));

      if (options.dryRun) {
        console.log('\nupdate-shares: dry run — no files copied.');
        return;
      }

      executePlans([...plans, ...homeJqPlans]);
      console.log('update-shares: rewove pre/post scripts and refreshed home-jq-transforms in both shares');
```

The resulting order: jq preflight → jq preview loop → `hasError` guard → weave preflight (`planAllPhases`) → build home-jq plans → dry-run return → single `executePlans` (stage all, then swap all). All validation happens before any mutation, and every mutation is one atomic batch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/updateShares.test.ts`
Expected: PASS (including the existing home-jq-transforms tests and the two new ones).

- [ ] **Step 5: Format, then commit**

```bash
pnpm format
git add src/commands/updateShares.ts tests/e2e/updateShares.test.ts
git commit -m "feat: weave pre/post scripts in update-shares as one transaction"
```

---

## Task 8: Documentation and VM harness

Update the run-order docs, the inverted-gitignore + migration guidance, and the VM e2e harness/tests to the new woven `pre-scripts/`/`post-scripts/` paths. The VM suite (`pnpm test:vm`) requires WSL/QEMU and is not part of `pnpm test`; these edits are verified by review + the non-VM gates.

**Files:**

- Modify: `README.md`, `usage-windows-vm.md`, `technical-notes.md`
- Modify: `tests/vm/vm.test.ts`, `tests/vm/harness/share.sh`

**Interfaces:** none.

- [ ] **Step 1: Update `tests/vm/harness/share.sh` to make nested scripts executable**

The share now nests scripts under `pre-scripts/`/`post-scripts/`, so the top-level `*.sh` glob misses them. Replace:

```bash
cp -r "$src"/. "$RUN/share/"
chmod +x "$RUN/share"/*.sh
echo "$RUN/share"
```

with:

```bash
cp -r "$src"/. "$RUN/share/"
find "$RUN/share" -name '*.sh' -exec chmod +x {} +
echo "$RUN/share"
```

- [ ] **Step 2: Update `tests/vm/vm.test.ts` script paths to the woven locations**

With no custom scripts, the woven Linux share has `pre-scripts/05-configure-network.sh`, `post-scripts/01-auth-config.sh`, and `post-scripts/02-apply-home-jq-transforms.sh`. Apply these replacements throughout the file:

- `/mnt/vm-shared/05-configure-network.sh` → `/mnt/vm-shared/pre-scripts/05-configure-network.sh` (3 occurrences: lines ~106, ~183, ~394)
- `/mnt/vm-shared/07-apply-home-jq-transforms.sh` → `/mnt/vm-shared/post-scripts/02-apply-home-jq-transforms.sh` (2 occurrences: ~140, ~152)
- `/mnt/vm-shared/06-auth-config.sh` → `/mnt/vm-shared/post-scripts/01-auth-config.sh` (1 occurrence: ~172)

The `readlink` assertion stays `/mnt/vm-shared/credentials.json`: `01-auth-config.sh` now symlinks to `$(dirname "$script_dir")/credentials.json`, which resolves to exactly that path. Leave the expected value unchanged. Also update the comment references to script numbers (e.g. `07's applier`, `06-auth-config`) for accuracy where they name a path.

Update `tests/vm/harness/seed/user-data`'s comment (line ~13) that says "07's applier runs `node apply-home-jq-transforms.mjs`" to reference the post-scripts applier step; this is a comment-only change.

- [ ] **Step 3: Update `README.md`**

- In the numbered run-order list (lines ~90–97), replace the "run scripts 1 through 7" style with the two-block instruction. Change item 5's reference and the surrounding steps so they read: `cd` into `vm-shared/pre-scripts/` and run every script in order (the last one is `05-configure-network.sh <host-ip>`); switch NAT→host-only and reboot; then `cd` into `vm-shared/post-scripts/` and run every script in order (`01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`). State that the exact count is no longer fixed because customs may add steps.
- Add a short "Customizing setup scripts" subsection near the home-jq-transforms section: `.configamatron/pre-scripts/` and `post-scripts/` hold your own `NN-name.sh`/`NN-name.ps1` steps; pre-scripts run before network isolation (full network access), post-scripts after the reboot; run `configamatron update-shares` after editing; each folder has a `README.md` with the naming rules.
- Update the `.gitignore` guidance (line ~30 area): `.configamatron/` is committed via an **allowlist** — everything is ignored except your authored inputs (`pre-scripts/`, `post-scripts/`, `home-jq-transforms/`, `proxy/allowlist.txt`, and `.gitignore`).
- Add a **migration note** for users upgrading a denylist-era committed environment: a `.gitignore` never untracks indexed files, so either delete-and-re-init, or run `git rm -r --cached .configamatron && git add .configamatron` then commit to re-apply the allowlist (previously-tracked generated files leave the index while staying on disk).

- [ ] **Step 4: Update `usage-windows-vm.md`**

- Change the "Run the numbered scripts" section (lines ~16–31) to the two-block flow: run every script in `vm-shared-windows\pre-scripts\` in order in an elevated PowerShell (last is `.\05-configure-network.ps1 -HostIp <ip>`), switch + reboot, then run every script in `vm-shared-windows\post-scripts\` in order (`.\01-auth-config.ps1`, then `.\02-apply-home-jq-transforms.ps1`). Note the count is no longer fixed.

- [ ] **Step 5: Update `technical-notes.md`**

- Update the `05-configure-network.sh` references (lines ~38, ~47) to note the script now lives in the generated `vm-shared/pre-scripts/` folder (woven, renumbered), and that `pnpm test:vm` runs it from `/mnt/vm-shared/pre-scripts/`.

- [ ] **Step 6: Verify the non-VM gates still pass**

Run: `pnpm typecheck && pnpm test:unit && pnpm format:check`
Expected: PASS. (The VM suite is validated separately via `pnpm test:vm` on a WSL host; it regenerates `.configamatron` — re-run `configamatron init` in the repo, or `update-shares`, before `test:vm` so the dev share reflects the woven layout.)

- [ ] **Step 7: Format, then commit**

```bash
pnpm format
git add README.md usage-windows-vm.md technical-notes.md tests/vm/vm.test.ts tests/vm/harness/share.sh tests/vm/harness/seed/user-data
git commit -m "docs: update run order, gitignore, and VM harness for woven pre/post scripts"
```

---

## Final verification

- [ ] **Run the full non-VM suite**

Run: `pnpm test`
Expected: PASS — `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration` all green.

- [ ] **Commit any formatting fixups**

```bash
pnpm format
git add -A
git commit -m "chore: formatting" || echo "nothing to format"
```

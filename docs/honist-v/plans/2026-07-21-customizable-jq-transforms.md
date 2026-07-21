# Customizable home-settings jq transforms — Implementation Plan

**Goal:** Extract the two inline settings jq transforms into a user-editable, source-controlled `.configamatron/home-jq-transforms/` folder applied by a single final numbered VM script, and consolidate the post-CA scripts.

**Architecture:** One tested TypeScript core (`src/homeJqTransforms.ts`) parses a YAML manifest, resolves per-OS target paths, and applies each `.jq` transform by shelling to `jq`. A tsup-bundled `apply-home-jq-transforms.mjs` (node available in the guest) runs the core from a thin numbered wrapper. The host CLI reuses the core for a new `update-shares` command, and `init` seeds the transforms plus a `.configamatron/.gitignore` that keeps secrets out of source control.

**Tech Stack:** TypeScript, Node 18+, commander, execa, tsup, vitest, `yaml`, jq.

## Global Constraints

- Node floor: `>=18`; tsup target `node18`. (verbatim from `package.json`)
- The VM applier (`src/vmApplyHomeJqTransforms.ts` and everything `src/homeJqTransforms.ts` imports) must use **only** `node:*` built-ins + `yaml` — never `execa`/`commander`/etc. — so the bundle stays self-contained. jq is invoked via `node:child_process` `spawnSync`.
- jq is invoked argv-based (`jq -f <absolute path>` with the JSON on stdin) — never by building a shell string.
- Path expansion vocabulary is exactly: a leading `~` or `~/` → `os.homedir()`; `%NAME%` → `process.env.NAME`. An unset `%NAME%` and a `~name` form are hard errors.
- Atomic writes only: write a temp file then `rename` over the target; never truncate a target on failure.
- Manifest `transform` values are bare `.jq` basenames contained within the transforms folder (reject separators, `..`, absolute paths, symlink escapes).
- Secrets that must never be committed and must appear in `.configamatron/.gitignore`: `proxy/secrets/`, `proxy/ca/key.pem`, `proxy/ca/leaf-key.pem`.
- New `src/` and `tests/` files are eslint+prettier-checked (templates and docs are ignored). Run `pnpm format` before each commit; the `test` script gates on `format:check`, `lint`, `typecheck`.
- Spec: `docs/honist-v/specs/2026-07-20-customizable-jq-transforms-design.md`.

---

### Task 1: envPaths — home-jq-transforms and gitignore paths

**Files:**

- Modify: `src/envPaths.ts`
- Test: `tests/unit/envPaths.test.ts`

**Interfaces:**

- Produces: `EnvPaths.homeJqTransforms: string`, `EnvPaths.gitignore: string`, `VmSharedPaths.homeJqTransforms: string`.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/envPaths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { envPaths } from '../../src/envPaths';

describe('envPaths home-jq-transforms', () => {
  it('locates the source transforms folder and the env gitignore', () => {
    const p = envPaths('/work');
    expect(p.homeJqTransforms).toBe(join('/work', '.configamatron', 'home-jq-transforms'));
    expect(p.gitignore).toBe(join('/work', '.configamatron', '.gitignore'));
  });

  it('gives each share its own home-jq-transforms copy', () => {
    const p = envPaths('/work');
    expect(p.vmSharedTargets[0].homeJqTransforms).toBe(join(p.vmShared, 'home-jq-transforms'));
    expect(p.vmSharedTargets[1].homeJqTransforms).toBe(
      join(p.vmSharedWindows, 'home-jq-transforms'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- envPaths` Expected: FAIL (`homeJqTransforms` undefined).

- [ ] **Step 3: Implement**

In `src/envPaths.ts`, add to `VmSharedPaths`:

```ts
  homeJqTransforms: string;
```

Add to `EnvPaths`:

```ts
  homeJqTransforms: string;
  gitignore: string;
```

In `target()`, add the field:

```ts
  const target = (dir: string): VmSharedPaths => ({
    dir,
    cert: join(dir, 'cert.pem'),
    credentials: join(dir, 'credentials.json'),
    authJson: join(dir, 'auth.json'),
    githubConfig: join(dir, 'github-config.txt'),
    homeJqTransforms: join(dir, 'home-jq-transforms'),
  });
```

In the returned object (near `root`/`proxy`), add:

```ts
    homeJqTransforms: join(root, 'home-jq-transforms'),
    gitignore: join(root, '.gitignore'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- envPaths` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "feat(envPaths): add home-jq-transforms and gitignore paths"
```

---

### Task 2: Core — manifest loading and validation

**Files:**

- Create: `src/homeJqTransforms.ts`
- Test: `tests/unit/homeJqTransforms.test.ts`

**Interfaces:**

- Produces: `interface TransformEntry { transform: string; linux?: string; windows?: string }`; `function loadManifest(dir: string): TransformEntry[]`.

- [ ] **Step 1: Write the failing test** — create `tests/unit/homeJqTransforms.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../../src/homeJqTransforms';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hjt-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string) {
  writeFileSync(join(dir, name), content);
}

describe('loadManifest', () => {
  it('parses a valid manifest', () => {
    write('a.jq', '.');
    write('manifest.yaml', '- transform: a.jq\n  linux: ~/a.json\n  windows: "%APPDATA%/a.json"\n');
    expect(loadManifest(dir)).toEqual([{ transform: 'a.jq', linux: '~/a.json', windows: '%APPDATA%/a.json' }]);
  });

  it('rejects a non-list manifest', () => {
    write('manifest.yaml', 'transform: a.jq\n');
    expect(() => loadManifest(dir)).toThrow('top-level list');
  });

  it('rejects invalid YAML', () => {
    write('manifest.yaml', ': : :\n');
    expect(() => loadManifest(dir)).toThrow('not valid YAML');
  });

  it('rejects an entry with no platform target', () => {
    write('a.jq', '.');
    write('manifest.yaml', '- transform: a.jq\n');
    expect(() => loadManifest(dir)).toThrow("at least one of 'linux'/'windows'");
  });

  it('rejects a transform that is not a .jq basename', () => {
    write('manifest.yaml', '- transform: sub/a.jq\n  linux: ~/a.json\n');
    expect(() => loadManifest(dir)).toThrow('bare filename');
  });

  it('rejects a path-traversing transform', () => {
    write('manifest.yaml', '- transform: ../a.jq\n  linux: ~/a.json\n');
    expect(() => loadManifest(dir)).toThrow('bare filename');
  });

  it('rejects a missing transform file', () => {
    write('manifest.yaml', '- transform: nope.jq\n  linux: ~/a.json\n');
    expect(() => loadManifest(dir)).toThrow('not found');
  });

  it('rejects a symlink that escapes the folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'hjt-out-'));
    writeFileSync(join(outside, 'real.jq'), '.');
    symlinkSync(join(outside, 'real.jq'), join(dir, 'link.jq'));
    write('manifest.yaml', '- transform: link.jq\n  linux: ~/a.json\n');
    try {
      expect(() => loadManifest(dir)).toThrow('outside the transforms folder');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- homeJqTransforms` Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/homeJqTransforms.ts`:

```ts
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface TransformEntry {
  transform: string;
  linux?: string;
  windows?: string;
}

function validateEntry(entry: unknown, index: number, dir: string): TransformEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`manifest entry ${index}: must be a mapping`);
  }
  const e = entry as Record<string, unknown>;
  const transform = e.transform;
  if (typeof transform !== 'string' || transform.length === 0) {
    throw new Error(`manifest entry ${index}: 'transform' is required`);
  }
  if (
    !transform.endsWith('.jq') ||
    transform.includes('/') ||
    transform.includes('\\') ||
    transform.includes('..')
  ) {
    throw new Error(`manifest entry ${index}: 'transform' must be a bare .jq filename (got '${transform}')`);
  }
  const abs = join(dir, transform);
  if (!existsSync(abs)) {
    throw new Error(`manifest entry ${index}: transform file not found: ${transform}`);
  }
  const realDir = realpathSync(resolve(dir));
  const real = realpathSync(abs);
  if (real !== join(realDir, transform)) {
    throw new Error(`manifest entry ${index}: '${transform}' resolves outside the transforms folder`);
  }
  const linux = e.linux;
  const windows = e.windows;
  if (linux !== undefined && typeof linux !== 'string') {
    throw new Error(`manifest entry ${index}: 'linux' must be a string`);
  }
  if (windows !== undefined && typeof windows !== 'string') {
    throw new Error(`manifest entry ${index}: 'windows' must be a string`);
  }
  if (linux === undefined && windows === undefined) {
    throw new Error(`manifest entry ${index}: at least one of 'linux'/'windows' is required`);
  }
  return { transform, linux, windows };
}

export function loadManifest(dir: string): TransformEntry[] {
  const manifestPath = join(dir, 'manifest.yaml');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`could not read manifest at ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(`manifest.yaml is not valid YAML: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('manifest.yaml must be a top-level list of entries');
  }
  return parsed.map((entry, i) => validateEntry(entry, i, dir));
}
```

Note: the symlink test relies on `realpathSync(abs)` differing from `join(realDir, transform)` when the file is a link pointing outside the folder.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- homeJqTransforms` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/homeJqTransforms.ts tests/unit/homeJqTransforms.test.ts
git commit -m "feat(home-jq): manifest loading and validation"
```

---

### Task 3: Core — resolveTarget

**Files:**

- Modify: `src/homeJqTransforms.ts`
- Test: `tests/unit/homeJqTransforms.test.ts`

**Interfaces:**

- Produces: `function resolveTarget(target: string, env: NodeJS.ProcessEnv, home: string): string`.

- [ ] **Step 1: Write the failing test** — add to `tests/unit/homeJqTransforms.test.ts`:

```ts
import { resolveTarget } from '../../src/homeJqTransforms';

describe('resolveTarget', () => {
  const home = '/home/me';
  it('expands a leading ~', () => {
    expect(resolveTarget('~/.claude.json', {}, home)).toBe('/home/me/.claude.json');
    expect(resolveTarget('~', {}, home)).toBe('/home/me');
  });
  it('expands %NAME% from env', () => {
    expect(resolveTarget('%APPDATA%/Code/User/settings.json', { APPDATA: 'C:/AppData' }, home)).toBe(
      'C:/AppData/Code/User/settings.json',
    );
  });
  it('throws on an unset variable', () => {
    expect(() => resolveTarget('%APPDATA%/x', {}, home)).toThrow('is not set');
  });
  it('rejects a ~name form', () => {
    expect(() => resolveTarget('~other/x', {}, home)).toThrow("only ~ / ~/");
  });
  it('leaves an absolute path unchanged', () => {
    expect(resolveTarget('/tmp/out.json', {}, home)).toBe('/tmp/out.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- homeJqTransforms` Expected: FAIL (`resolveTarget` not exported).

- [ ] **Step 3: Implement** — add to `src/homeJqTransforms.ts`:

```ts
export function resolveTarget(target: string, env: NodeJS.ProcessEnv, home: string): string {
  let t = target.replace(/%([^%]+)%/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new Error(`environment variable %${name}% is not set`);
    }
    return value;
  });
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
    t = home + t.slice(1);
  } else if (t.startsWith('~')) {
    throw new Error(`unsupported '~name' path (only ~ / ~/ expand): ${target}`);
  }
  return t;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- homeJqTransforms` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/homeJqTransforms.ts tests/unit/homeJqTransforms.test.ts
git commit -m "feat(home-jq): resolveTarget path expansion"
```

---

### Task 4: Core — applyTransforms, previewTransforms, default jq runner

**Files:**

- Modify: `src/homeJqTransforms.ts`
- Test: `tests/unit/homeJqTransforms.test.ts`

**Interfaces:**

- Produces:
  - `type Platform = 'linux' | 'windows'`
  - `interface JqRunResult { code: number; stdout: string; stderr: string }`
  - `type JqRunner = (transformPath: string, input: string) => JqRunResult`
  - `interface ApplyResult { transform: string; target: string; created: boolean; ok: boolean; error?: string }`
  - `interface PreviewResult { transform: string; linuxTarget: string | null; windowsTarget: string | null; output?: string; error?: string }`
  - `function applyTransforms(opts: { dir: string; platform: Platform; env?: NodeJS.ProcessEnv; home?: string; runJq?: JqRunner }): ApplyResult[]`
  - `function previewTransforms(opts: { dir: string; runJq?: JqRunner }): PreviewResult[]`
  - `const defaultJqRunner: JqRunner`

- [ ] **Step 1: Write the failing test** — add to `tests/unit/homeJqTransforms.test.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { applyTransforms, previewTransforms, type JqRunner } from '../../src/homeJqTransforms';

// A stub runner: applies a fixed transformation regardless of program, so tests
// need no real jq. Keyed off the transform file's basename.
function stubRunner(map: Record<string, (input: string) => { code: number; stdout: string; stderr: string }>): JqRunner {
  return (transformPath, input) => {
    const name = transformPath.split(/[\\/]/).pop()!;
    return map[name]?.(input) ?? { code: 3, stdout: '', stderr: `no stub for ${name}` };
  };
}

describe('applyTransforms', () => {
  it('seeds {} for a missing target and writes the jq output atomically', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${join(dir, 'out.json')}\n`);
    const runJq = stubRunner({ 'a.jq': (input) => ({ code: 0, stdout: `{"seeded":${input === '{}'}}`, stderr: '' }) });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results[0].ok).toBe(true);
    expect(results[0].created).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))).toEqual({ seeded: true });
  });

  it('treats an unparsable existing target as {}', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    const out = join(dir, 'out.json');
    writeFileSync(out, '{not json');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${out}\n`);
    const runJq = stubRunner({ 'a.jq': (input) => ({ code: 0, stdout: input, stderr: '' }) });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results[0].created).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('{}');
  });

  it('leaves a valid-but-wrong-shape target intact when jq fails', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    const out = join(dir, 'out.json');
    writeFileSync(out, '[1,2,3]');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${out}\n`);
    const runJq = stubRunner({ 'a.jq': () => ({ code: 5, stdout: '', stderr: 'Cannot index array with string' }) });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('Cannot index array');
    expect(readFileSync(out, 'utf8')).toBe('[1,2,3]'); // untouched
  });

  it('skips an entry with no target for the platform', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  windows: ${join(dir, 'w.json')}\n`);
    const runJq = stubRunner({ 'a.jq': (input) => ({ code: 0, stdout: input, stderr: '' }) });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results).toEqual([]);
    expect(existsSync(join(dir, 'w.json'))).toBe(false);
  });

  it('applies two entries targeting the same file in manifest order', () => {
    writeFileSync(join(dir, 'one.jq'), '.');
    writeFileSync(join(dir, 'two.jq'), '.');
    const out = join(dir, 'out.json');
    writeFileSync(
      join(dir, 'manifest.yaml'),
      `- transform: one.jq\n  linux: ${out}\n- transform: two.jq\n  linux: ${out}\n`,
    );
    const runJq = stubRunner({
      'one.jq': () => ({ code: 0, stdout: '{"step":1}', stderr: '' }),
      'two.jq': (input) => ({ code: 0, stdout: `{"prev":${JSON.parse(input).step},"step":2}`, stderr: '' }),
    });
    applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ prev: 1, step: 2 });
  });

  it('creates parent directories for the target', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    const out = join(dir, 'nested', 'deep', 'out.json');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${out}\n`);
    const runJq = stubRunner({ 'a.jq': () => ({ code: 0, stdout: '{"ok":true}', stderr: '' }) });
    applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(existsSync(out)).toBe(true);
  });
});

describe('previewTransforms', () => {
  it('returns output and targets for a passing transform', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(join(dir, 'manifest.yaml'), '- transform: a.jq\n  linux: ~/a.json\n  windows: "%APPDATA%/a.json"\n');
    const runJq = stubRunner({ 'a.jq': () => ({ code: 0, stdout: '{"x":1}\n', stderr: '' }) });
    const [p] = previewTransforms({ dir, runJq });
    expect(p).toEqual({ transform: 'a.jq', linuxTarget: '~/a.json', windowsTarget: '%APPDATA%/a.json', output: '{"x":1}' });
  });

  it('captures a jq error', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(join(dir, 'manifest.yaml'), '- transform: a.jq\n  linux: ~/a.json\n');
    const runJq = stubRunner({ 'a.jq': () => ({ code: 2, stdout: '', stderr: 'syntax error' }) });
    const [p] = previewTransforms({ dir, runJq });
    expect(p.error).toContain('syntax error');
    expect(p.output).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- homeJqTransforms` Expected: FAIL (`applyTransforms` not exported).

- [ ] **Step 3: Implement** — add to `src/homeJqTransforms.ts`:

Add imports at the top (merge with existing `node:fs` import):

```ts
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
```

(This widens the existing `node:fs` and `node:path` imports from Task 2 — replace those two import lines with the four lines above.)

Append:

```ts
export type Platform = 'linux' | 'windows';

export interface JqRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type JqRunner = (transformPath: string, input: string) => JqRunResult;

export const defaultJqRunner: JqRunner = (transformPath, input) => {
  const r = spawnSync('jq', ['-f', transformPath], { input, encoding: 'utf8' });
  if (r.error) {
    throw new Error(
      `could not run jq — is it installed and on PATH? (${(r.error as Error).message})`,
    );
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface ApplyResult {
  transform: string;
  target: string;
  created: boolean;
  ok: boolean;
  error?: string;
}

export function applyTransforms(opts: {
  dir: string;
  platform: Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  runJq?: JqRunner;
}): ApplyResult[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const runJq = opts.runJq ?? defaultJqRunner;
  const results: ApplyResult[] = [];
  for (const entry of loadManifest(opts.dir)) {
    const rel = opts.platform === 'windows' ? entry.windows : entry.linux;
    if (rel === undefined) continue;
    const target = resolveTarget(rel, env, home);
    const transformPath = join(opts.dir, entry.transform);

    let input: string;
    let created: boolean;
    if (!existsSync(target)) {
      input = '{}';
      created = true;
    } else {
      const current = readFileSync(target, 'utf8');
      try {
        JSON.parse(current);
        input = current;
      } catch {
        input = '{}';
      }
      created = false;
    }

    const r = runJq(transformPath, input);
    if (r.code !== 0) {
      results.push({
        transform: entry.transform,
        target,
        created,
        ok: false,
        error: r.stderr.trim() || `jq exited ${r.code}`,
      });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, r.stdout);
    renameSync(tmp, target);
    results.push({ transform: entry.transform, target, created, ok: true });
  }
  return results;
}

export interface PreviewResult {
  transform: string;
  linuxTarget: string | null;
  windowsTarget: string | null;
  output?: string;
  error?: string;
}

export function previewTransforms(opts: { dir: string; runJq?: JqRunner }): PreviewResult[] {
  const runJq = opts.runJq ?? defaultJqRunner;
  return loadManifest(opts.dir).map((entry) => {
    const r = runJq(join(opts.dir, entry.transform), '{}');
    const base = {
      transform: entry.transform,
      linuxTarget: entry.linux ?? null,
      windowsTarget: entry.windows ?? null,
    };
    if (r.code !== 0) {
      return { ...base, error: r.stderr.trim() || `jq exited ${r.code}` };
    }
    return { ...base, output: r.stdout.trim() };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- homeJqTransforms` Expected: PASS. Then `pnpm typecheck` Expected: no errors.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/homeJqTransforms.ts tests/unit/homeJqTransforms.test.ts
git commit -m "feat(home-jq): applyTransforms, previewTransforms, jq runner"
```

---

### Task 5: Template transform files and the env .gitignore

**Files:**

- Create: `templates/home-jq-transforms/manifest.yaml`
- Create: `templates/home-jq-transforms/vscode-settings.jq`
- Create: `templates/home-jq-transforms/claude-onboarding.jq`
- Create: `templates/configamatron.gitignore`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: `templatesDir()` from `src/templates.ts`.

- [ ] **Step 1: Write the failing test** — in `tests/unit/templates.test.ts`, add these entries to the `expectedTemplateFiles` array (leave existing entries untouched for now):

```ts
  'home-jq-transforms/manifest.yaml',
  'home-jq-transforms/vscode-settings.jq',
  'home-jq-transforms/claude-onboarding.jq',
  'configamatron.gitignore',
```

And add a new test at the end of the `describe('templates', ...)` block:

```ts
  it('seed transforms reproduce the extracted inline jq programs', () => {
    const vscode = readFileSync(join(templatesDir(), 'home-jq-transforms', 'vscode-settings.jq'), 'utf8');
    expect(vscode).toContain('.["editor.defaultFormatter"] = "esbenp.prettier-vscode"');
    const claude = readFileSync(join(templatesDir(), 'home-jq-transforms', 'claude-onboarding.jq'), 'utf8');
    expect(claude).toContain('.hasCompletedOnboarding = true');
  });

  it('env gitignore template excludes secrets and build artifacts', () => {
    const gi = readFileSync(join(templatesDir(), 'configamatron.gitignore'), 'utf8');
    for (const p of [
      'proxy/secrets/',
      'proxy/ca/key.pem',
      'proxy/ca/leaf-key.pem',
      'vm-shared/github-config.txt',
      'proxy/envoy.yaml',
      'vm-shared-windows/dns-responder/bin',
    ]) {
      expect(gi, p).toContain(p);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- templates` Expected: FAIL (files missing).

- [ ] **Step 3: Create the files.**

`templates/home-jq-transforms/vscode-settings.jq`:

```jq
.["files.autoSave"] = "afterDelay"
| .["editor.formatOnSave"] = true
| .["editor.defaultFormatter"] = "esbenp.prettier-vscode"
| .["[csharp]"] = {"editor.defaultFormatter": "csharpier.csharpier-vscode"}
```

`templates/home-jq-transforms/claude-onboarding.jq`:

```jq
.hasCompletedOnboarding = true
```

`templates/home-jq-transforms/manifest.yaml`:

```yaml
# Each entry applies a jq transform to a settings file in the guest's home.
# transform: a .jq file in this folder. linux/windows: target paths (either may
# be omitted to skip that OS). A leading ~ is the home dir; %NAME% is an env var.
- transform: vscode-settings.jq
  linux: ~/.config/Code/User/settings.json
  windows: "%APPDATA%/Code/User/settings.json"
- transform: claude-onboarding.jq
  linux: ~/.claude.json
  windows: ~/.claude.json
```

`templates/configamatron.gitignore`:

```gitignore
# This directory is meant to be committed EXCEPT for the files below.
# Written by `configamatron init` as .configamatron/.gitignore.

# Real credentials and private keys — never commit these.
proxy/secrets/
proxy/ca/key.pem
proxy/ca/leaf-key.pem

# Per-environment credential placeholders, regenerated by init / write-github-config.
vm-shared/credentials.json
vm-shared/auth.json
vm-shared/github-config.txt
vm-shared-windows/credentials.json
vm-shared-windows/auth.json
vm-shared-windows/github-config.txt

# Regenerable build artifacts.
proxy/envoy.yaml
vm-shared-windows/dns-responder/bin
vm-shared-windows/dns-responder/obj
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- templates` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add templates/home-jq-transforms templates/configamatron.gitignore tests/unit/templates.test.ts
git commit -m "feat(templates): seed home-jq-transforms and env gitignore"
```

---

### Task 6: VM applier entrypoint, tsup bundle, and packaging

**Files:**

- Create: `src/vmApplyHomeJqTransforms.ts`
- Create: `scripts/copy-vm-applier.mjs`
- Modify: `tsup.config.ts`
- Modify: `package.json` (`build` and `prepack` scripts)
- Modify: `.gitignore`
- Modify: `eslint.config.mjs`
- Test: `tests/e2e/vmApplier.test.ts`

**Interfaces:**

- Consumes: `applyTransforms`, `type Platform` from `src/homeJqTransforms.ts`.
- Produces: `templates/vm-shared/apply-home-jq-transforms.mjs` and `templates/vm-shared-windows/apply-home-jq-transforms.mjs` (built), runnable as `node apply-home-jq-transforms.mjs <transforms-dir>`.

- [ ] **Step 1: Write the failing test** — create `tests/e2e/vmApplier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const applierUbuntu = join(repoRoot, 'templates', 'vm-shared', 'apply-home-jq-transforms.mjs');
const applierWindows = join(repoRoot, 'templates', 'vm-shared-windows', 'apply-home-jq-transforms.mjs');

describe('vm applier bundle', () => {
  it('is built into both shares', () => {
    expect(existsSync(applierUbuntu)).toBe(true);
    expect(existsSync(applierWindows)).toBe(true);
  });

  it('applies a transform to its target on this platform (real jq)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'applier-'));
    try {
      const out = join(dir, 'out.json');
      writeFileSync(join(dir, 't.jq'), '.applied = true');
      const key = platform() === 'win32' ? 'windows' : 'linux';
      writeFileSync(join(dir, 'manifest.yaml'), `- transform: t.jq\n  ${key}: ${out.replace(/\\/g, '/')}\n`);
      const { exitCode } = await execa('node', [applierUbuntu, dir]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ applied: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is listed in the npm package', async () => {
    const { stdout } = await execa('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
    });
    const files: string[] = JSON.parse(stdout)[0].files.map((f: { path: string }) => f.path);
    expect(files).toContain('templates/vm-shared/apply-home-jq-transforms.mjs');
    expect(files).toContain('templates/vm-shared-windows/apply-home-jq-transforms.mjs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm test:e2e -- vmApplier` Expected: FAIL (bundle not built).

- [ ] **Step 3: Implement.**

Create `src/vmApplyHomeJqTransforms.ts`:

```ts
import { platform as osPlatform } from 'node:process';
import { applyTransforms, type Platform } from './homeJqTransforms';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: apply-home-jq-transforms <transforms-dir>');
  process.exit(2);
}

const platform: Platform = osPlatform === 'win32' ? 'windows' : 'linux';

try {
  const results = applyTransforms({ dir, platform });
  let failed = false;
  for (const r of results) {
    if (r.ok) {
      console.log(`apply-home-jq-transforms: ${r.created ? 'created' : 'updated'} ${r.target} (${r.transform})`);
    } else {
      failed = true;
      console.error(`apply-home-jq-transforms: FAILED ${r.transform} -> ${r.target}: ${r.error}`);
    }
  }
  if (results.length === 0) {
    console.log('apply-home-jq-transforms: no transforms for this platform');
  }
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(`apply-home-jq-transforms: ${(error as Error).message}`);
  process.exit(1);
}
```

Create `scripts/copy-vm-applier.mjs`:

```js
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'dist', 'apply-home-jq-transforms.js');
for (const share of ['vm-shared', 'vm-shared-windows']) {
  copyFileSync(src, join(root, 'templates', share, 'apply-home-jq-transforms.mjs'));
}
console.log('copied apply-home-jq-transforms.mjs into template shares');
```

Replace `tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'apply-home-jq-transforms': 'src/vmApplyHomeJqTransforms.ts',
  },
  format: ['esm'],
  target: 'node18',
  clean: true,
  // The VM applier bundle must be self-contained (no node_modules in the guest),
  // so inline yaml. Other deps are used only by cli.js, which has node_modules.
  noExternal: ['yaml'],
});
```

In `package.json`, change `build` and add `prepack`:

```json
    "build": "tsup && node scripts/copy-vm-applier.mjs",
    "prepack": "pnpm build",
```

In `.gitignore`, add:

```gitignore
templates/vm-shared/apply-home-jq-transforms.mjs
templates/vm-shared-windows/apply-home-jq-transforms.mjs
```

In `eslint.config.mjs`, extend the ignores so the build helper isn't linted:

```js
  { ignores: ['dist/', 'scripts/'] },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm test:e2e -- vmApplier` Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/vmApplyHomeJqTransforms.ts scripts/copy-vm-applier.mjs tsup.config.ts package.json .gitignore eslint.config.mjs tests/e2e/vmApplier.test.ts
git commit -m "feat(home-jq): bundle the in-VM applier and verify packaging"
```

---

### Task 7: init — seed transforms into three locations and write .gitignore

**Files:**

- Modify: `src/initEnv.ts`
- Test: `tests/unit/initEnv.test.ts`

**Interfaces:**

- Consumes: `EnvPaths.homeJqTransforms`, `EnvPaths.gitignore`, `VmSharedPaths.homeJqTransforms` (Task 1).

- [ ] **Step 1: Write the failing test** — add to `tests/unit/initEnv.test.ts`:

```ts
  it('seeds home-jq-transforms into the source folder and both shares', () => {
    initEnvironment(options());
    const root = join(dir, ENV_DIR_NAME);
    for (const rel of [
      'home-jq-transforms/manifest.yaml',
      'home-jq-transforms/vscode-settings.jq',
      'vm-shared/home-jq-transforms/manifest.yaml',
      'vm-shared-windows/home-jq-transforms/manifest.yaml',
    ]) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
    }
  });

  it('writes a .configamatron/.gitignore that ignores real secrets', () => {
    initEnvironment(options());
    const gi = readFileSync(join(dir, ENV_DIR_NAME, '.gitignore'), 'utf8');
    expect(gi).toContain('proxy/secrets/');
    expect(gi).toContain('proxy/ca/leaf-key.pem');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- initEnv` Expected: FAIL (files not seeded).

- [ ] **Step 3: Implement** — in `src/initEnv.ts`, at the end of `initEnvironment` (after the `for (const target of paths.vmSharedTargets)` loop), add:

```ts
  const templateTransforms = join(options.templatesDir, 'home-jq-transforms');
  cpSync(templateTransforms, paths.homeJqTransforms, { recursive: true });
  for (const target of paths.vmSharedTargets) {
    cpSync(templateTransforms, target.homeJqTransforms, { recursive: true });
  }
  copyFileSync(join(options.templatesDir, 'configamatron.gitignore'), paths.gitignore);
```

`cpSync` and `copyFileSync` are already imported in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- initEnv` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/initEnv.ts tests/unit/initEnv.test.ts
git commit -m "feat(init): seed home-jq-transforms and write env .gitignore"
```

---

### Task 8: update-shares command

**Files:**

- Create: `src/commands/updateShares.ts`
- Modify: `src/cli.ts`
- Test: `tests/e2e/updateShares.test.ts`

**Interfaces:**

- Consumes: `requireEnvPathsOrExit` (`src/envPaths.ts`), `previewTransforms` (`src/homeJqTransforms.ts`).
- Produces: `function registerUpdateShares(program: Command): void`.

- [ ] **Step 1: Write the failing test** — create `tests/e2e/updateShares.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

async function initEnv(dir: string) {
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture], { cwd: dir });
}

describe('configamatron update-shares', () => {
  it('previews transforms and refreshes both share copies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      // Delete a share copy to prove update-shares restores it.
      const winCopy = join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms', 'manifest.yaml');
      rmSync(join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms'), { recursive: true, force: true });
      const { exitCode, stdout } = await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('vscode-settings.jq');
      expect(stdout).toContain('hasCompletedOnboarding'); // {} preview output
      expect(existsSync(winCopy)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run previews without copying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      rmSync(join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms'), { recursive: true, force: true });
      const { exitCode } = await execa('node', [cliPath, 'update-shares', '--dry-run'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(existsSync(join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks the copy when a transform fails its {} preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      const src = join(dir, '.configamatron', 'home-jq-transforms', 'vscode-settings.jq');
      writeFileSync(src, '.["x"] = (1 / 0 broken'); // invalid jq
      rmSync(join(dir, '.configamatron', 'vm-shared', 'home-jq-transforms'), { recursive: true, force: true });
      const { exitCode, stderr } = await execa('node', [cliPath, 'update-shares'], { cwd: dir, reject: false });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not copying');
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'home-jq-transforms'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm test:e2e -- updateShares` Expected: FAIL (unknown command `update-shares`).

- [ ] **Step 3: Implement.**

Create `src/commands/updateShares.ts`:

```ts
import { cpSync, renameSync, rmSync } from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { previewTransforms } from '../homeJqTransforms';

interface UpdateSharesOptions {
  dryRun: boolean;
}

export function registerUpdateShares(program: Command): void {
  program
    .command('update-shares')
    .description('Preview home-jq-transforms and copy them into the VM shares')
    .option('-n, --dry-run', 'preview only; do not copy', false)
    .action((options: UpdateSharesOptions) => {
      const paths = requireEnvPathsOrExit('update-shares');
      if (!paths) return;

      let previews;
      try {
        previews = previewTransforms({ dir: paths.homeJqTransforms });
      } catch (error) {
        console.error(`update-shares: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      let hasError = false;
      for (const p of previews) {
        console.log(`\n${p.transform}`);
        console.log(`  linux:   ${p.linuxTarget ?? '(none)'}`);
        console.log(`  windows: ${p.windowsTarget ?? '(none)'}`);
        if (p.error) {
          hasError = true;
          console.error(`  ERROR applying to {}: ${p.error}`);
        } else {
          console.log(`  {} -> ${p.output}`);
        }
      }

      if (hasError) {
        console.error('\nupdate-shares: a transform failed its preview; not copying. Fix the .jq and re-run.');
        process.exitCode = 1;
        return;
      }

      if (options.dryRun) {
        console.log('\nupdate-shares: dry run — no files copied.');
        return;
      }

      for (const target of paths.vmSharedTargets) {
        const staging = `${target.homeJqTransforms}.staging`;
        rmSync(staging, { recursive: true, force: true });
        try {
          cpSync(paths.homeJqTransforms, staging, { recursive: true });
          rmSync(target.homeJqTransforms, { recursive: true, force: true });
          renameSync(staging, target.homeJqTransforms);
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          console.error(`update-shares: failed to update ${target.homeJqTransforms}: ${(error as Error).message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`update-shares: copied transforms into ${target.homeJqTransforms}`);
      }
    });
}
```

In `src/cli.ts`, add the import and registration:

```ts
import { registerUpdateShares } from './commands/updateShares';
```

```ts
registerUpdateShares(program);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm test:e2e -- updateShares` Expected: PASS. (Requires `jq` on the host PATH.)

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/commands/updateShares.ts src/cli.ts tests/e2e/updateShares.test.ts
git commit -m "feat(cli): add update-shares command"
```

---

### Task 9: init — mention transforms and source control in next steps

**Files:**

- Modify: `src/commands/init.ts`
- Test: `tests/e2e/init.test.ts`

- [ ] **Step 1: Write the failing test** — add to the first test in `tests/e2e/init.test.ts` (inside `scaffolds .configamatron and prints next steps`), after the existing `expect(stdout).toContain('generate-ca');`:

```ts
      expect(stdout).toContain('update-shares');
      expect(stdout).toContain('home-jq-transforms');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm test:e2e -- init` Expected: FAIL (strings absent).

- [ ] **Step 3: Implement** — in `src/commands/init.ts`, add to the `console.log` block after the existing "Then share ..." message:

```ts
      console.log(
        `  Customize settings transforms in ${ENV_DIR_NAME}/home-jq-transforms (commit them; ` +
          `re-run 'configamatron update-shares' after edits). ${ENV_DIR_NAME} is source-controlled ` +
          `except the files its .gitignore excludes.`,
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm test:e2e -- init` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/commands/init.ts tests/e2e/init.test.ts
git commit -m "feat(init): note transform customization and source control in next steps"
```

---

### Task 10: Ubuntu scripts — gh in step 01, strip 04, combine into 05/06/07

**Files:**

- Modify: `templates/vm-shared/01-apt-packages.sh`
- Modify: `templates/vm-shared/04-configure-tools.sh`
- Create: `templates/vm-shared/05-configure-network.sh`
- Create: `templates/vm-shared/06-auth-config.sh`
- Create: `templates/vm-shared/07-apply-home-jq-transforms.sh`
- Delete: `templates/vm-shared/05-github-auth.sh`, `06-trust-ca.sh`, `07-setup-persistence.sh`, `08-claude-config.sh`, `09-codex-config.sh`
- Modify: `tests/unit/templates.test.ts`, `tests/unit/initEnv.test.ts`

- [ ] **Step 1: Update the tests first (they will fail until the files change).**

In `tests/unit/templates.test.ts` `expectedTemplateFiles`, remove the five Ubuntu entries `vm-shared/05-github-auth.sh`, `vm-shared/06-trust-ca.sh`, `vm-shared/07-setup-persistence.sh`, `vm-shared/08-claude-config.sh`, `vm-shared/09-codex-config.sh`, and add:

```ts
  'vm-shared/05-configure-network.sh',
  'vm-shared/06-auth-config.sh',
  'vm-shared/07-apply-home-jq-transforms.sh',
```

Replace the three now-stale Ubuntu content tests. Delete `ubuntu 08-claude-config writes .claude.json with jq` and `ubuntu 04-configure-tools writes settings.json with jq` entirely (that jq now lives in the seed transforms, covered by Task 5). Change the `ubuntu 06-trust-ca merges the Firefox CA with jq` test to read the combined script and keep its assertions:

```ts
  it('ubuntu 05-configure-network merges the Firefox CA with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '05-configure-network.sh'), 'utf8');
    expect(s).toContain('sudo jq . "$policy_file"');
    expect(s).toContain('.policies.Certificates.Install');
    expect(s).not.toContain('python3');
  });
```

Update `ubuntu 01-apt-packages installs jq for JSON edits` to also assert gh:

```ts
  it('ubuntu 01-apt-packages installs jq and gh', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '01-apt-packages.sh'), 'utf8');
    expect(s).toMatch(/apt install -y .*\bjq\b/);
    expect(s).toMatch(/apt install -y .*\bgh\b/);
  });
```

In `tests/unit/initEnv.test.ts`, in the first test's file list, replace `'vm-shared/06-trust-ca.sh'` and `'vm-shared/07-setup-persistence.sh'` and `'vm-shared/09-codex-config.sh'` with:

```ts
      'vm-shared/05-configure-network.sh',
      'vm-shared/06-auth-config.sh',
      'vm-shared/07-apply-home-jq-transforms.sh',
```

Run: `pnpm test:unit -- templates initEnv` Expected: FAIL (files not yet renamed).

- [ ] **Step 2: Edit `01-apt-packages.sh`** — change the install line to add `gh`:

```bash
sudo apt install -y curl git build-essential okular jq gh
```

- [ ] **Step 3: Rewrite `04-configure-tools.sh`** (remove the VS Code settings jq block; keep everything else):

```bash
#!/usr/bin/env bash
set -euo pipefail

## Screen Locking

# Disable the automatic screen lock mechanism
gsettings set org.gnome.desktop.screensaver lock-enabled false

# Set the screen blanking inactivity timeout to "Never" (0)
gsettings set org.gnome.desktop.session idle-delay 0

# VS Code extensions

code --install-extension esbenp.prettier-vscode
code --install-extension csharpier.csharpier-vscode
code --install-extension JakubKozera.csharp-dev-tools

# VS Code settings (files.autoSave, formatter, etc.) are applied later by
# 07-apply-home-jq-transforms.sh from home-jq-transforms/, so users can customize them.

# codebase-memory-mcp
# - install is idempotent, must install after coding agents for it to be configured

curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

## Agent configurations
## Call codex last because it blocks on login request we aren't going to respond to.

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp
```

- [ ] **Step 4: Create `05-configure-network.sh`** (06-trust-ca + 07-setup-persistence combined):

```bash
#!/usr/bin/env bash
set -euo pipefail

host_ip="${1:?usage: 05-configure-network.sh <host-ip> [cert-path]}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_path="${2:-${script_dir}/cert.pem}"

## --- Trust the proxy CA ---

sudo cp "$cert_path" /usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
sudo update-ca-certificates

# Node.js bundles its own CA list and ignores the system trust store, so tools
# built on it (e.g. the claude CLI) still fail with DEPTH_ZERO_SELF_SIGNED_CERT
# against the sandbox proxy unless NODE_EXTRA_CA_CERTS points at the CA.
echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt' | sudo tee /etc/profile.d/node-extra-ca-certs.sh > /dev/null
sudo chmod 644 /etc/profile.d/node-extra-ca-certs.sh

echo "05-configure-network: installed and trusted $cert_path; NODE_EXTRA_CA_CERTS configured for new shells"

# Firefox keeps its own trust store (an NSS cert9.db per profile) and ignores
# both the system CA bundle and NODE_EXTRA_CA_CERTS, so the CA must be registered
# with it separately. An enterprise policy at the standard system-wide location
# does this regardless of how Firefox was installed: apt, snap (Canonical
# special-cased this path), and Mozilla's tarball builds all read
# /etc/firefox/policies/policies.json. Skip gracefully when Firefox is absent.
#
# The cert itself must live in /etc/firefox/policies too: the snap build runs
# strictly confined and its mount namespace shadows /usr/local, so a
# Certificates.Install entry pointing at /usr/local/share/ca-certificates/*
# fails silently. /etc/firefox/policies is the one sanctioned path all builds read.
if command -v firefox > /dev/null 2>&1 || snap list firefox > /dev/null 2>&1; then
  policy_dir=/etc/firefox/policies
  policy_file="${policy_dir}/policies.json"
  ca_for_firefox="${policy_dir}/configamatron-proxy-certificate-authority.pem"
  ca_stale=/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt
  sudo mkdir -p "$policy_dir"
  sudo cp "$cert_path" "$ca_for_firefox"
  sudo chmod 644 "$ca_for_firefox"

  base=$(sudo jq . "$policy_file" 2> /dev/null || echo '{}')
  tmp=$(mktemp)
  printf '%s' "$base" | jq \
    --arg ca "$ca_for_firefox" \
    --arg stale "$ca_stale" \
    '.policies.Certificates.Install = ((.policies.Certificates.Install // []) - [$stale, $ca] + [$ca])' \
    > "$tmp"
  sudo cp "$tmp" "$policy_file"
  rm -f "$tmp"
  sudo chmod 644 "$policy_file"
  echo "05-configure-network: registered CA with Firefox via $policy_file"
else
  echo "05-configure-network: Firefox not found; skipped browser CA registration"
fi

## --- Persistence: dnsmasq + egress + netplan DNS override ---

sudo apt-get install -y dnsmasq

sudo cp "${script_dir}/dnsmasq-stub.conf" /etc/dnsmasq.d/sandbox-stub.conf

sed "s|__HOST_IP__|${host_ip}|g" "${script_dir}/configamatron-egress.service" \
  | sudo tee /etc/systemd/system/configamatron-egress.service > /dev/null

# Discover the primary network interface (physical NIC name, e.g. ens33) so the
# netplan DNS override merges into the active profile. Prefer the default-route
# interface; fall back to the first up, globally-scoped IPv4 interface.
iface="$(ip -o -4 route show default | awk '{print $5}' | head -n1)"
if [[ -z "${iface}" ]]; then
  iface="$(ip -o -4 addr show up scope global | awk '{print $2}' | head -n1)"
fi
if [[ -z "${iface}" ]]; then
  echo "05-configure-network: could not determine the VM's network interface." >&2
  echo "  Bring the VM's network up before running this (NAT or bridged both work)." >&2
  exit 1
fi

sed "s|__IFACE__|${iface}|g" "${script_dir}/60-dns-override.yaml" | sudo tee /etc/netplan/60-dns-override.yaml > /dev/null
sudo chmod 600 /etc/netplan/60-dns-override.yaml
sudo netplan apply

sudo systemctl daemon-reload
sudo systemctl enable --now dnsmasq
sudo systemctl enable configamatron-egress.service
sudo systemctl restart configamatron-egress.service

echo "05-configure-network: dnsmasq and configamatron-egress.service enabled and started; netplan DNS override applied"
```

- [ ] **Step 5: Create `06-auth-config.sh`** (05-github-auth minus the gh install, + 08-claude-config minus its jq block, + 09-codex-config):

```bash
#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

## --- GitHub auth (gh is installed in 01-apt-packages.sh, pre-isolation) ---

config_path="$dir/github-config.txt"
if [ ! -f "$config_path" ]; then
  echo "06-auth-config: $config_path not found. Run 'configamatron write-github-config' on the host first." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$config_path"

if [ -z "${GITHUB_USERNAME:-}" ] || [ -z "${GITHUB_EMAIL:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "06-auth-config: $config_path is missing GITHUB_USERNAME, GITHUB_EMAIL, or GITHUB_TOKEN" >&2
  exit 1
fi

git config --global user.name "$GITHUB_USERNAME"
git config --global user.email "$GITHUB_EMAIL"
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

## --- Claude placeholder credential (onboarding flag is applied in step 07) ---

mkdir -p "$HOME/.claude"
# Symlink so it tracks the shared placeholder (regenerated on re-init). The
# placeholder never expires, so the CLI never rewrites it.
ln -sfn "${dir}/credentials.json" "$HOME/.claude/.credentials.json"

## --- Codex placeholder credential ---

mkdir -p "$HOME/.codex"
ln -sfn "${dir}/auth.json" "$HOME/.codex/auth.json"

echo "06-auth-config: git identity + gh auth configured for $GITHUB_USERNAME <$GITHUB_EMAIL>; linked placeholder claude + codex credentials"
```

- [ ] **Step 6: Create `07-apply-home-jq-transforms.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$script_dir/apply-home-jq-transforms.mjs" "$script_dir/home-jq-transforms"
```

- [ ] **Step 7: Delete the five superseded scripts.**

```bash
git rm templates/vm-shared/05-github-auth.sh templates/vm-shared/06-trust-ca.sh templates/vm-shared/07-setup-persistence.sh templates/vm-shared/08-claude-config.sh templates/vm-shared/09-codex-config.sh
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test:unit -- templates initEnv` Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add templates/vm-shared tests/unit/templates.test.ts tests/unit/initEnv.test.ts
git commit -m "refactor(vm-shared): gh in step 01; combine into 05/06/07; drop inline jq"
```

---

### Task 11: Windows scripts — strip 04, combine into 05/06/07

**Files:**

- Modify: `templates/vm-shared-windows/04-configure-tools.ps1`
- Create: `templates/vm-shared-windows/05-configure-network.ps1`
- Create: `templates/vm-shared-windows/06-auth-config.ps1`
- Create: `templates/vm-shared-windows/07-apply-home-jq-transforms.ps1`
- Delete: `templates/vm-shared-windows/05-github-auth.ps1`, `06-trust-ca.ps1`, `07-setup-network.ps1`, `08-claude-config.ps1`, `09-codex-config.ps1`
- Modify: `tests/unit/templates.test.ts`, `tests/unit/initEnv.test.ts`

- [ ] **Step 1: Update the tests first.**

In `tests/unit/templates.test.ts` `expectedTemplateFiles`, remove `vm-shared-windows/05-github-auth.ps1`, `vm-shared-windows/06-trust-ca.ps1`, `vm-shared-windows/08-claude-config.ps1`, `vm-shared-windows/09-codex-config.ps1`, `vm-shared-windows/07-setup-network.ps1`, and add:

```ts
  'vm-shared-windows/05-configure-network.ps1',
  'vm-shared-windows/06-auth-config.ps1',
  'vm-shared-windows/07-apply-home-jq-transforms.ps1',
```

Replace the stale Windows content tests. Delete `windows 08-claude-config writes .claude.json with jq` and `windows 04-configure-tools writes settings.json with jq` (that jq is now in the seed transforms). Update the three others to point at the new filenames:

```ts
  it('windows 06-auth-config parses the double-quoted github-config format', () => {
    const script = readFileSync(join(templatesDir(), 'vm-shared-windows', '06-auth-config.ps1'), 'utf8');
    expect(script).toContain('GITHUB_USERNAME');
    expect(script).toContain("Trim('\"')");
  });

  it('windows 06-auth-config fails loudly when gh auth login or setup-git fails', () => {
    const script = readFileSync(join(templatesDir(), 'vm-shared-windows', '06-auth-config.ps1'), 'utf8');
    expect(script).toMatch(/gh auth login --with-token\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
    expect(script).toMatch(/gh auth setup-git\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  });

  it('windows 05-configure-network covers CA trust surfaces; 06-auth-config installs the placeholder', () => {
    const net = readFileSync(join(templatesDir(), 'vm-shared-windows', '05-configure-network.ps1'), 'utf8');
    expect(net).toContain('certutil');
    expect(net).toContain('NODE_EXTRA_CA_CERTS');
    expect(net).toContain('http.sslBackend schannel');
    const auth = readFileSync(join(templatesDir(), 'vm-shared-windows', '06-auth-config.ps1'), 'utf8');
    expect(auth).toContain('.credentials.json');
  });

  it('windows DNS redirect wires responder to the host IP and adapter DNS', () => {
    const net = readFileSync(join(templatesDir(), 'vm-shared-windows', '05-configure-network.ps1'), 'utf8');
    expect(net).toContain('Register-ScheduledTask');
    expect(net).toContain('ConfigamatronDnsResponder');
    expect(net).toContain('responder-config.txt');
    expect(net).toContain('Set-DnsClientServerAddress');
    expect(net).toContain("'127.0.0.1'");
    expect(net).toContain('dns-responder-build');
    expect(net).toContain('Copy-Item');

    const prog = readFileSync(join(templatesDir(), 'vm-shared-windows', 'dns-responder', 'Program.cs'), 'utf8');
    expect(prog).toContain('responder-config.txt');
    expect(prog).toContain('53');
  });
```

In `tests/unit/initEnv.test.ts`, in the first test's file list, replace `'vm-shared-windows/07-setup-network.ps1'` and `'vm-shared-windows/09-codex-config.ps1'` with:

```ts
      'vm-shared-windows/05-configure-network.ps1',
      'vm-shared-windows/06-auth-config.ps1',
      'vm-shared-windows/07-apply-home-jq-transforms.ps1',
```

Run: `pnpm test:unit -- templates initEnv` Expected: FAIL (files not yet renamed).

- [ ] **Step 2: Rewrite `04-configure-tools.ps1`** (drop the VS Code settings jq block):

```powershell
$ErrorActionPreference = 'Stop'

# Never sleep / never blank the display (analog of Ubuntu's screensaver disable).
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0

# VS Code extensions

code --install-extension esbenp.prettier-vscode
code --install-extension csharpier.csharpier-vscode
code --install-extension JakubKozera.csharp-dev-tools

# VS Code settings are applied later by 07-apply-home-jq-transforms.ps1 from
# home-jq-transforms/, so users can customize them.

# codebase-memory-mcp
# - install is idempotent, must install after coding agents for it to be configured

$codebaseMemoryInstaller = Join-Path $env:TEMP 'codebase-memory-mcp-install.ps1'
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile $codebaseMemoryInstaller
Unblock-File $codebaseMemoryInstaller
& $codebaseMemoryInstaller
Remove-Item $codebaseMemoryInstaller

# Register the context7 MCP server for both agents (mirrors Ubuntu 04).
## Call codex last because it blocks on login request we aren't going to respond to.

claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex; VS Code Prettier extension installed."
```

- [ ] **Step 3: Create `05-configure-network.ps1`** (06-trust-ca + 07-setup-network combined):

```powershell
#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$HostIp, [string]$CertPath)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CertPath) { $CertPath = Join-Path $scriptDir 'cert.pem' }

if (-not (Test-Path $CertPath)) {
  Write-Error "05-configure-network: $CertPath not found. Run 'configamatron generate-ca' on the host first."
  exit 1
}

# --- Trust the proxy CA ---

# 1) Windows machine Root store — covers .NET (uses the store) and schannel.
certutil -f -addstore Root $CertPath | Out-Null

# 2) Node tools (claude/codex) ignore the Windows store, so point NODE_EXTRA_CA_CERTS
#    at a stable copy. Machine scope so every new shell inherits it.
$caDir = 'C:\ProgramData\configamatron'
New-Item -ItemType Directory -Force -Path $caDir | Out-Null
$caStable = Join-Path $caDir 'proxy-ca.pem'
Copy-Item -Force $CertPath $caStable
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $caStable, 'Machine')

# 3) Git for Windows: use the Windows store (schannel).
git config --global http.sslBackend schannel

Write-Host "05-configure-network: imported $CertPath into LocalMachine\Root; NODE_EXTRA_CA_CERTS=$caStable; git sslBackend=schannel"

# --- DNS responder ---

# Stop any already-running responder first: Windows locks a running exe, so a
# rerun's `dotnet publish` below would fail to overwrite it otherwise.
$taskName = 'ConfigamatronDnsResponder'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name $taskName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
}

# 1) Publish the shipped C# catch-all DNS responder to a stable location. Copy the
#    source to a writable build dir first (the share is read-only for dotnet's obj/).
$installDir = 'C:\ProgramData\configamatron\dns-responder'
$buildDir = 'C:\ProgramData\configamatron\dns-responder-build'
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path (Join-Path $scriptDir 'dns-responder') '*') -Destination $buildDir
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
  (Join-Path $buildDir 'bin'), (Join-Path $buildDir 'obj')
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
dotnet publish $buildDir -c Release -o $installDir

# 2) Write the host IP where the responder reads it (analog of dnsmasq-stub.conf).
Set-Content -Path (Join-Path $installDir 'responder-config.txt') -Value $HostIp -NoNewline

# 3) Register a startup Scheduled Task: runs at boot as SYSTEM, restarts on failure.
$exe = Join-Path $installDir 'ConfigamatronDnsResponder.exe'
$action = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ConfigamatronDnsResponder' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'ConfigamatronDnsResponder'

# 4) Point every up adapter's DNS at the local responder; suppress DHCP DNS.
$ifaces = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' } |
  Select-Object -ExpandProperty InterfaceAlias
if (-not $ifaces) { Write-Error "05-configure-network: could not determine the VM's network interface."; exit 1 }
foreach ($iface in $ifaces) {
  Set-DnsClientServerAddress -InterfaceAlias $iface -ServerAddresses '127.0.0.1'
}
Clear-DnsClientCache

Write-Host "05-configure-network: CA trusted; DNS responder installed (-> $HostIp), scheduled at startup; DNS set to 127.0.0.1 on: $($ifaces -join ', ')"
```

- [ ] **Step 4: Create `06-auth-config.ps1`** (05-github-auth + 08-claude-config minus jq + 09-codex-config):

```powershell
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- GitHub auth (GitHub.cli is installed in 01-install-packages.ps1) ---

$configPath = Join-Path $scriptDir 'github-config.txt'
if (-not (Test-Path $configPath)) {
  Write-Error "06-auth-config: $configPath not found. Run 'configamatron write-github-config' on the host first."
  exit 1
}

# github-config.txt is shell-style KEY="value" lines. Strip the surrounding quotes.
$cfg = @{}
foreach ($line in Get-Content $configPath) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $cfg[$matches[1]] = $matches[2].Trim('"') }
}
foreach ($k in 'GITHUB_USERNAME', 'GITHUB_EMAIL', 'GITHUB_TOKEN') {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrEmpty($cfg[$k])) {
    Write-Error "06-auth-config: $configPath is missing $k"; exit 1
  }
}

git config --global user.name  $cfg['GITHUB_USERNAME']
git config --global user.email $cfg['GITHUB_EMAIL']
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
if ($LASTEXITCODE -ne 0) { Write-Error "06-auth-config: gh auth login failed"; exit 1 }
gh auth setup-git
if ($LASTEXITCODE -ne 0) { Write-Error "06-auth-config: gh auth setup-git failed"; exit 1 }

# --- Claude placeholder credential (onboarding flag is applied in step 07) ---

$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
Copy-Item -Force (Join-Path $scriptDir 'credentials.json') (Join-Path $claudeDir '.credentials.json')

# --- Codex placeholder credential ---

$codexDir = Join-Path $env:USERPROFILE '.codex'
New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
Copy-Item -Force (Join-Path $scriptDir 'auth.json') (Join-Path $codexDir 'auth.json')

Write-Host "06-auth-config: gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>; placeholder claude + codex credentials installed"
```

- [ ] **Step 5: Create `07-apply-home-jq-transforms.ps1`:**

```powershell
$ErrorActionPreference = 'Stop'

& node (Join-Path $PSScriptRoot 'apply-home-jq-transforms.mjs') (Join-Path $PSScriptRoot 'home-jq-transforms')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

- [ ] **Step 6: Delete the five superseded scripts.**

```bash
git rm templates/vm-shared-windows/05-github-auth.ps1 templates/vm-shared-windows/06-trust-ca.ps1 templates/vm-shared-windows/07-setup-network.ps1 templates/vm-shared-windows/08-claude-config.ps1 templates/vm-shared-windows/09-codex-config.ps1
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test:unit -- templates initEnv` Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add templates/vm-shared-windows tests/unit/templates.test.ts tests/unit/initEnv.test.ts
git commit -m "refactor(vm-shared-windows): combine into 05/06/07; drop inline jq"
```

---

### Task 12: Update verify-config script references

**Files:**

- Modify: `templates/vm-shared/verify-config.sh`
- Modify: `templates/vm-shared-windows/verify-config.ps1`

- [ ] **Step 1: Edit `templates/vm-shared/verify-config.sh`** — update the renumbered references (these are the only lines that mention old script numbers/names):

- Line ~60: `'no DNAT rule found and no host-ip argument given -- has 07-setup-persistence.sh run?'` → `... has 05-configure-network.sh run?'`
- Line ~63: `section 'CA trust (06)'` → `section 'CA trust (05)'`
- Line ~92: `"missing or stale $ff_ca -- re-run 06-trust-ca.sh"` → `... re-run 05-configure-network.sh"`
- Line ~115: `section 'DNS stub (07)'` → `section 'DNS stub (05)'`
- Line ~146: `section 'Routing / NAT (07)'` → `section 'Routing / NAT (05)'`
- Line ~180: `"missing $cred -- run 08-claude-config.sh to link vm-shared/credentials.json"` → `... run 06-auth-config.sh to link vm-shared/credentials.json"`

- [ ] **Step 2: Edit `templates/vm-shared-windows/verify-config.ps1`:**

- Line ~26: `'no responder config and no host-ip arg -- has 07-setup-network.ps1 run?'` → `... has 05-configure-network.ps1 run?'`
- Line ~55: `"missing $cred -- run 08-claude-config.ps1"` → `... run 06-auth-config.ps1"`

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -rn '0[5-9]-\(github-auth\|trust-ca\|setup-persistence\|setup-network\|claude-config\|codex-config\)\|(06)\|(07)' templates/vm-shared/verify-config.sh templates/vm-shared-windows/verify-config.ps1` Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add templates/vm-shared/verify-config.sh templates/vm-shared-windows/verify-config.ps1
git commit -m "docs(verify): update script references to new numbering"
```

---

### Task 13: Update README and Windows usage run-order docs

**Files:**

- Modify: `README.md`
- Modify: `usage-windows-vm.md`

- [ ] **Step 1: Replace the Ubuntu run list in `README.md`** (the numbered list under "Run the numbered scripts from the VM", currently items 1–9) with:

```markdown
1. `01-apt-packages.sh`
2. `02-install-pnpm.sh`
3. Open a new terminal, then `03-install-tools.sh`
4. Open a new terminal, then `04-configure-tools.sh` — a browser opens for context7 login; close it and cancel the script if you don't want to use credentials.
5. `05-configure-network.sh <host-ip>` — `<host-ip>` is printed by proxy setup. Trusts the proxy CA (defaults to the `cert.pem` beside the script; pass a path as the 2nd argument to override), installs dnsmasq + the `configamatron-egress.service` DNAT rules, and points the VM's resolver at the local stub.
6. Switch the VM's network from NAT to host-only, then reboot so the boot-time rules take effect.
7. `06-auth-config.sh` — run after isolation + reboot. Configures git/gh from the placeholder PAT (validated against api.github.com through the proxy) and links the placeholder claude and codex credentials.
8. `07-apply-home-jq-transforms.sh` — run last. Applies every transform in `home-jq-transforms/` to its target settings file (VS Code settings, claude onboarding, and anything you added).
```

- [ ] **Step 2: Update the `.configamatron` source-control note in `README.md`.** Replace the line that says `.configamatron` scaffolding should not be committed (currently: "Do not commit to source control, includes credentials that the isolating proxy may inject.") with:

```markdown
1. `configamatron init` — creates `.configamatron/` scaffolding. It is meant to be committed **except** for the files its bundled `.gitignore` excludes (real credentials, private keys, and regenerable build artifacts). Customize `.configamatron/home-jq-transforms/` to change settings transforms, then run `configamatron update-shares`.
```

- [ ] **Step 3: Add a "Customizing settings transforms" section to `README.md`** (after the run-order section):

```markdown
## Customizing settings transforms

`.configamatron/home-jq-transforms/` holds a `manifest.yaml` plus `.jq` files that edit
settings files in the guest's home directory. Each manifest entry names a `.jq` transform and
its `linux` and/or `windows` target path (a leading `~` is the home dir; `%NAME%` is an
environment variable). Step 07 applies them all, seeding an empty `{}` when a target is
missing. Add or edit transforms, then run `configamatron update-shares` to copy them into the
VM shares (`-n`/`--dry-run` previews without copying). A transform whose `{}` preview fails
blocks the copy.
```

- [ ] **Step 4: Replace the Windows run list in `usage-windows-vm.md`** (items 1–9) with:

```markdown
1. `.\01-install-packages.ps1`
2. `.\02-install-pnpm.ps1`
3. New terminal, then `.\03-install-tools.ps1`
4. New terminal, then `.\04-configure-tools.ps1`
5. `.\05-configure-network.ps1 -HostIp <ip>` — `<ip>` is printed by proxy setup. Trusts the proxy CA (`-CertPath` overrides the default `cert.pem` beside the script), publishes the DNS responder as a startup task, and points the VM's DNS at it. Requires an elevated PowerShell.
6. Switch the VM's network from NAT to **host-only**, then reboot so isolation takes effect.
7. `.\06-auth-config.ps1` — run **after** isolation + reboot. Configures git/gh from the placeholder PAT and installs the placeholder claude and codex credentials.
8. `.\07-apply-home-jq-transforms.ps1` — run last. Applies every transform in `home-jq-transforms/` to its target settings file.
```

- [ ] **Step 5: Commit**

```bash
git add README.md usage-windows-vm.md
git commit -m "docs: new run order, source-control note, and transform customization"
```

---

### Task 14: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test` Expected: PASS through `format:check`, `lint`, `typecheck`, unit, build, e2e, integration.

- [ ] **Step 2: Manual smoke test of the applier end-to-end**

Run:

```bash
node -e "const {mkdtempSync,writeFileSync,readFileSync}=require('fs');const {tmpdir}=require('os');const {join}=require('path');const d=mkdtempSync(join(tmpdir(),'smoke-'));writeFileSync(join(d,'t.jq'),'.ok=true');const o=join(d,'out.json').replace(/\\\\/g,'/');writeFileSync(join(d,'manifest.yaml'),'- transform: t.jq\n  linux: '+o+'\n  windows: '+o+'\n');const {execFileSync}=require('child_process');execFileSync('node',['templates/vm-shared/apply-home-jq-transforms.mjs',d],{stdio:'inherit'});console.log(readFileSync(o,'utf8'));"
```

Expected: prints `apply-home-jq-transforms: created ...` and `{"ok":true}`.

- [ ] **Step 3: Confirm no real secret is committable**

Run: `grep -rn 'proxy/secrets/\|proxy/ca/key.pem\|proxy/ca/leaf-key.pem' templates/configamatron.gitignore` Expected: all three present.

- [ ] **Step 4: Commit any formatting fixups (if `pnpm format` changed anything)**

```bash
pnpm format
git add -A
git commit -m "chore: formatting" || echo "nothing to format"
```

---

## Self-Review

**Spec coverage:**

- Source-control `.gitignore` (secrets/keys/placeholders/build artifacts) → Task 5 (template) + Task 7 (init writes it) + Task 14 (verify).
- Manifest format + validation (basename `.jq`, containment, traversal, unset var, `~name`) → Tasks 2, 3.
- Path expansion `~` / `%NAME%`, core-implemented → Task 3.
- Core `applyTransforms` (seed `{}`, unparsable→`{}`, valid-wrong-shape leaves intact, atomic write, mkdir, manifest order) + `previewTransforms` + injectable argv jq runner → Task 4.
- In-VM applier bundle, tsup entry, `noExternal: yaml`, emit into both shares, gitignore artifact, `prepack` build, packaging test → Task 6.
- Path-safe wrappers (`$BASH_SOURCE`/`$PSScriptRoot`, absolute paths) → Tasks 10 (step 6), 11 (step 5).
- Script consolidation + gh in step 01 + new run order + Windows `#Requires`/named params → Tasks 10, 11.
- `init` seeds three locations + writes `.gitignore` + next-steps message → Tasks 7, 9.
- `update-shares` preview, stage-then-swap, jq-error blocks copy, `-n/--dry-run`, host-jq check → Task 8.
- verify-config + docs updates → Tasks 12, 13.
- Testing (unit stubbed, e2e real jq, packaging, wrapper) → Tasks 2–8, 14.

**Placeholder scan:** none — every code step shows complete content.

**Type consistency:** `TransformEntry`, `Platform`, `JqRunner`, `JqRunResult`, `ApplyResult`, `PreviewResult`, `loadManifest`, `resolveTarget`, `applyTransforms`, `previewTransforms`, `defaultJqRunner`, `registerUpdateShares`, `EnvPaths.homeJqTransforms`/`gitignore`, `VmSharedPaths.homeJqTransforms` are defined once (Tasks 1–4, 8) and referenced consistently thereafter.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

export interface TransformEntry {
  transform: string;
  linux?: string;
  windows?: string;
}

// The transforms folder is authored by the user and trusted, so validation only
// catches honest mistakes (missing file, no target) — no path-traversal hardening.
function validateEntry(entry: unknown, index: number, dir: string): TransformEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`manifest entry ${index}: must be a mapping`);
  }
  const e = entry as Record<string, unknown>;
  const transform = e.transform;
  if (typeof transform !== 'string' || transform.length === 0) {
    throw new Error(`manifest entry ${index}: 'transform' is required`);
  }
  if (!existsSync(join(dir, transform))) {
    throw new Error(`manifest entry ${index}: transform file not found: ${transform}`);
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
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(tmp, r.stdout);
      renameSync(tmp, target);
    } catch (writeError) {
      rmSync(tmp, { force: true });
      results.push({
        transform: entry.transform,
        target,
        created,
        ok: false,
        error: (writeError as Error).message,
      });
      continue;
    }
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

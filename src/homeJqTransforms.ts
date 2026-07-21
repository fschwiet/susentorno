import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

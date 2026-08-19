import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export type StampInputs = Record<string, string | number>;

/** Metadata, not an input: recorded so a time-limited image can expire. */
export const STAMP_BUILT_AT_KEY = 'builtAt';

/**
 * One digest per input, rather than one digest over all of them. The Ubuntu
 * pipeline's single hash cannot answer "which input changed?", and the Windows
 * pipeline's rebuild costs 60-120 minutes — enough that the error message owes
 * the reader a reason.
 */
export function computeStampMap(inputs: StampInputs): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    const text = String(value);
    map[key] = createHash('sha256')
      .update(`${Buffer.byteLength(text, 'utf8')}:`)
      .update(text, 'utf8')
      .digest('hex');
  }
  return map;
}

export function readStampMap(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return Object.fromEntries(entries);
  } catch {
    // A truncated or hand-edited stamp means "unknown", not "crash the tier".
    return null;
  }
}

/** Write only after a clean build; a partial image is never cache-valid. */
export function writeStampMap(path: string, map: Record<string, string>): void {
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
}

export function clearStampMap(path: string): void {
  rmSync(path, { force: true });
}

/** Input names that differ, including additions and removals. Sorted. */
export function diffStampMaps(
  previous: Record<string, string> | null,
  next: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  keys.delete(STAMP_BUILT_AT_KEY);
  return [...keys].filter((key) => (previous ?? {})[key] !== next[key]).sort();
}

/** Whole days since the recorded build, or null when the stamp predates the field. */
export function stampAgeDays(map: Record<string, string>, now: Date = new Date()): number | null {
  const builtAt = map[STAMP_BUILT_AT_KEY];
  if (builtAt === undefined) return null;
  const then = Date.parse(builtAt);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

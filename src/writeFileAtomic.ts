import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Replace `target` with `data` via a temp file in the same directory and a rename, so a
 * reader never sees a half-written file. The temp file is removed if either step fails,
 * and the error is rethrown.
 */
export function writeFileAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

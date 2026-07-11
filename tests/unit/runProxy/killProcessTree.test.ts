import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../../../src/runProxy/killProcessTree';

const parentScript = fileURLToPath(
  new URL('../../fixtures/processTree/parent.mjs', import.meta.url),
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('killProcessTree', () => {
  it('kills the spawned process and the descendant it spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'killtree-'));
    const pidFile = join(dir, 'grandchild.pid');
    try {
      const parent = execa(process.execPath, [parentScript, pidFile], {
        detached: process.platform !== 'win32',
      });
      parent.catch(() => {
        // Expected: we forcefully kill this process below.
      });
      expect(parent.pid).toBeDefined();
      const parentPid = parent.pid!;

      let grandchildPid = -1;
      await waitFor(() => {
        try {
          grandchildPid = Number(readFileSync(pidFile, 'utf8'));
          return true;
        } catch {
          return false;
        }
      }, 5000);

      expect(isAlive(parentPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      await killProcessTree(parentPid, 'SIGINT');
      await waitFor(() => !isAlive(parentPid) && !isAlive(grandchildPid), 5000);

      expect(isAlive(parentPid)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

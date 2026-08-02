import { describe, it, expect, vi } from 'vitest';
import {
  getDedicatedNodePath,
  ensureDedicatedNodeCopy,
  relaunchIfNeeded,
  relaunchFailedWithNoChild,
  type EnsureCopyDeps,
  type RelaunchDeps,
} from '../../src/runHosting/relaunchViaDedicatedNode';

describe('dedicated-node runtime relaunch', () => {
  describe('dedicated node path resolution', () => {
    it('joins the given homedir with the fixed .susentorno-host convention', () => {
      expect(getDedicatedNodePath('C:\\Users\\alice')).toBe(
        'C:\\Users\\alice\\.susentorno-host\\run-proxy-node.exe',
      );
    });
  });

  describe('dedicated node copy freshness', () => {
    const DEDICATED = 'C:\\Users\\alice\\.susentorno-host\\run-proxy-node.exe';
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
      expect(deps.mkdir).toHaveBeenCalledWith('C:\\Users\\alice\\.susentorno-host');
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
        hashFile: vi.fn((path: string) => Promise.resolve(path === SOURCE ? 'hash-a' : 'hash-b')),
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

  describe('relaunch decision', () => {
    const DEDICATED = 'C:\\Users\\alice\\.susentorno-host\\run-proxy-node.exe';
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
        execPath: 'C:\\USERS\\ALICE\\.susentorno-HOST\\RUN-PROXY-NODE.EXE',
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
      expect(result).toEqual({ relaunched: true, childMayHaveAlerted: true, exitCode: 0 });
    });

    it('propagates a non-zero exit code', async () => {
      const deps = makeDeps({ spawn: vi.fn(async () => ({ exitCode: 7 })) });
      const result = await relaunchIfNeeded(deps);
      expect(result).toEqual({ relaunched: true, childMayHaveAlerted: true, exitCode: 7 });
    });

    it('falls back to a fixed exit code when the child was terminated by signal', async () => {
      const deps = makeDeps({ spawn: vi.fn(async () => ({ signal: 'SIGTERM' })) });
      const result = await relaunchIfNeeded(deps);
      expect(result).toEqual({ relaunched: true, childMayHaveAlerted: false, exitCode: 1 });
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining('terminated by signal SIGTERM'),
      );
    });

    it('falls back to a fixed exit code when spawn could not launch the process at all', async () => {
      const deps = makeDeps({ spawn: vi.fn(async () => ({})) });
      const result = await relaunchIfNeeded(deps);
      expect(result).toEqual({ relaunched: true, childMayHaveAlerted: false, exitCode: 1 });
      expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('failed to launch'));
    });
  });

  describe('relaunchFailedWithNoChild', () => {
    it('is false when relaunch did not happen at all', () => {
      expect(relaunchFailedWithNoChild({ relaunched: false })).toBe(false);
    });

    it('is false when the child ran far enough to have had a chance to alert', () => {
      expect(
        relaunchFailedWithNoChild({ relaunched: true, childMayHaveAlerted: true, exitCode: 0 }),
      ).toBe(false);
    });

    it('is true when the child was signal-killed, or the relaunch mechanism failed before any child ran — both report childMayHaveAlerted: false', () => {
      expect(
        relaunchFailedWithNoChild({ relaunched: true, childMayHaveAlerted: false, exitCode: 1 }),
      ).toBe(true);
    });
  });
});

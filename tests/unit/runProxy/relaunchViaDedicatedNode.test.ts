import { describe, it, expect, vi } from 'vitest';
import {
  getDedicatedNodePath,
  ensureDedicatedNodeCopy,
  type EnsureCopyDeps,
} from '../../../src/runProxy/relaunchViaDedicatedNode';

describe('getDedicatedNodePath', () => {
  it('joins the given homedir with the fixed .configamatron-host convention', () => {
    expect(getDedicatedNodePath('C:\\Users\\alice')).toBe(
      'C:\\Users\\alice\\.configamatron-host\\run-proxy-node.exe',
    );
  });
});

describe('ensureDedicatedNodeCopy', () => {
  const DEDICATED = 'C:\\Users\\alice\\.configamatron-host\\run-proxy-node.exe';
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
    expect(deps.mkdir).toHaveBeenCalledWith('C:\\Users\\alice\\.configamatron-host');
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
      hashFile: vi.fn((path: string) =>
        Promise.resolve(path === SOURCE ? 'hash-a' : 'hash-b'),
      ),
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

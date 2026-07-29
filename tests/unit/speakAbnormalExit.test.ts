import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';

const spawnMock = vi.fn<
  (command: string, args: string[], options: Record<string, unknown>) => unknown
>(() => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const { speakAbnormalExit, createSpeakDeps } = await import('../../src/runProxy/speakAbnormalExit');
type SpeakAbnormalExitDeps = import('../../src/runProxy/speakAbnormalExit').SpeakAbnormalExitDeps;

describe('abnormal-exit spoken alert', () => {
  it('spawns a detached PowerShell one-liner invoking the SAPI COM voice, naming Configamatron', () => {
    const spawn = vi.fn();
    const deps: SpeakAbnormalExitDeps = { spawn };

    speakAbnormalExit(deps);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('powershell.exe');
    const script = args.join(' ');
    expect(script).toContain('SAPI.SpVoice');
    expect(script).toContain('Configamatron is down');
  });

  it('is best-effort: does not throw when the injected spawn throws', () => {
    const deps: SpeakAbnormalExitDeps = {
      spawn: () => {
        throw new Error('boom');
      },
    };

    expect(() => speakAbnormalExit(deps)).not.toThrow();
  });

  it('uses a real spawn implementation by default without throwing synchronously', () => {
    expect(() => speakAbnormalExit()).not.toThrow();
  });

  it('spawns detached, with stdio ignored, and cwd outside the caller directory', () => {
    spawnMock.mockClear();

    createSpeakDeps().spawn('powershell.exe', ['-NoProfile']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0];
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    // The detached child outlives the caller; it must never sit inside a directory
    // the caller (e.g. a test harness) may delete right after this returns.
    expect(options.cwd).toBe(homedir());
  });
});

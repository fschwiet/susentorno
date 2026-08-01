import { describe, it, expect, vi } from 'vitest';
import {
  createAbnormalExitAlert,
  buildSpeakCommand,
  speakAlert,
  type AbnormalExitAlertDeps,
} from '../../src/runProxy/abnormalExitAlert';

const mockUnref = vi.fn();
const mockExeca = vi.fn<(...args: unknown[]) => { unref: typeof mockUnref }>(() => ({
  unref: mockUnref,
}));
vi.mock('execa', () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

function makeDeps(overrides: Partial<AbnormalExitAlertDeps> = {}): AbnormalExitAlertDeps {
  return {
    platform: 'win32',
    speak: vi.fn(),
    ...overrides,
  };
}

describe('createAbnormalExitAlert', () => {
  it('speaks on the first trigger', () => {
    const deps = makeDeps();
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();

    expect(deps.speak).toHaveBeenCalledTimes(1);
  });

  it('never speaks a second time in the same process', () => {
    const deps = makeDeps();
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();
    alert.trigger();
    alert.trigger();

    expect(deps.speak).toHaveBeenCalledTimes(1);
  });

  it('does not speak on a non-Windows platform', () => {
    const deps = makeDeps({ platform: 'linux' });
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();

    expect(deps.speak).not.toHaveBeenCalled();
  });

  it('swallows an exception from a failing speak call instead of throwing', () => {
    const deps = makeDeps({
      speak: vi.fn(() => {
        throw new Error('spawn exploded');
      }),
    });
    const alert = createAbnormalExitAlert(deps);

    expect(() => alert.trigger()).not.toThrow();
  });

  it('still counts a throwing speak call as having triggered, so it is not retried', () => {
    const deps = makeDeps({
      speak: vi.fn(() => {
        throw new Error('spawn exploded');
      }),
    });
    const alert = createAbnormalExitAlert(deps);

    alert.trigger();
    alert.trigger();

    expect(deps.speak).toHaveBeenCalledTimes(1);
  });
});

describe('buildSpeakCommand', () => {
  it('drives the SAPI COM voice, not System.Speech', () => {
    const command = buildSpeakCommand('susentorno is down');

    expect(command).toContain('New-Object -ComObject SAPI.SpVoice');
    expect(command).toContain(".Speak('susentorno is down')");
  });

  it('escapes an embedded single quote for PowerShell single-quoted strings', () => {
    const command = buildSpeakCommand("it's down");

    expect(command).toContain(".Speak('it''s down')");
  });
});

describe('speakAlert', () => {
  it('spawns a detached, unreferenced powershell.exe that is never awaited', () => {
    mockExeca.mockClear();
    mockUnref.mockClear();

    speakAlert();

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExeca.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-Command');
    expect(args[args.length - 1]).toContain('SAPI.SpVoice');
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });
});

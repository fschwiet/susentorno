import { describe, it, expect, vi } from 'vitest';
import { createAbnormalExitAlert, type AbnormalExitAlertDeps } from '../../src/runProxy/abnormalExitAlert';

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

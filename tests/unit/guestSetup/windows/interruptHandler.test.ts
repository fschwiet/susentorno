import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CLEANUP_DEADLINE_MS,
  watchForInterrupt,
} from '../../../../src/guestSetup/windows/interruptHandler';

function setup() {
  const source = new EventEmitter();
  const controller = new AbortController();
  const messages: string[] = [];
  const exits: number[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const stop = watchForInterrupt({
    source,
    controller,
    print: (line) => messages.push(line),
    exit: (code) => {
      exits.push(code);
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
  });
  return { source, controller, messages, exits, timers, stop };
}

describe('watchForInterrupt', () => {
  it('does nothing until an interrupt arrives', () => {
    const { controller, exits } = setup();
    expect(controller.signal.aborted).toBe(false);
    expect(exits).toEqual([]);
  });

  it('aborts the in-flight work on the first Ctrl+C, and says how to force an exit', () => {
    const { source, controller, messages, exits } = setup();
    source.emit('SIGINT');
    expect(controller.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    expect(messages.join('\n')).toMatch(/cancelling/i);
    expect(messages.join('\n')).toMatch(/Ctrl\+C again/);
  });

  it('exits immediately with 130 on the second Ctrl+C, skipping the remaining cleanup', () => {
    const { source, exits, messages } = setup();
    source.emit('SIGINT');
    source.emit('SIGINT');
    expect(exits).toEqual([130]);
    expect(messages.join('\n')).toMatch(/exiting immediately/i);
  });

  it('bounds cleanup at about 30 seconds, then exits 130', () => {
    const { source, exits, timers } = setup();
    source.emit('SIGINT');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(30_000);
    expect(CLEANUP_DEADLINE_MS).toBe(30_000);
    timers[0].callback();
    expect(exits).toEqual([130]);
  });

  it('stops listening, and stops the cleanup timer, once the run is over', () => {
    const { source, controller, timers, exits, stop } = setup();
    source.emit('SIGINT');
    stop();
    expect(timers[0].cleared).toBe(true);
    expect(source.listenerCount('SIGINT')).toBe(0);
    source.emit('SIGINT');
    expect(exits).toEqual([]);
    expect(controller.signal.aborted).toBe(true);
  });
});

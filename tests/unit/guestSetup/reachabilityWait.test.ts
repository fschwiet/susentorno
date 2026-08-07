import { describe, it, expect } from 'vitest';
import { waitForReachable } from '../../../src/guestSetup/reachabilityWait';

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('waitForReachable', () => {
  it('returns immediately when the first candidate is reachable', async () => {
    const clock = fakeClock();
    const result = await waitForReachable({
      getCandidates: () => ['192.168.67.50'],
      connect: async () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toEqual({ reachable: true, address: '192.168.67.50' });
  });

  it('times out when nothing is ever reachable', async () => {
    const clock = fakeClock();
    const result = await waitForReachable({
      getCandidates: () => ['192.168.67.50'],
      connect: async () => false,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 30_000,
      pollIntervalMs: 10_000,
    });
    expect(result).toEqual({ reachable: false });
  });

  it('succeeds once a candidate address appears after several empty polls', async () => {
    const clock = fakeClock();
    let poll = 0;
    const result = await waitForReachable({
      getCandidates: () => {
        poll += 1;
        return poll < 3 ? [] : ['192.168.67.60'];
      },
      connect: async (address) => address === '192.168.67.60',
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 60_000,
      pollIntervalMs: 10_000,
    });
    expect(result).toEqual({ reachable: true, address: '192.168.67.60' });
    expect(poll).toBe(3);
  });

  it('reports progress on every poll that does not find a reachable candidate', async () => {
    const clock = fakeClock();
    const progressAt: number[] = [];
    await waitForReachable({
      getCandidates: () => [],
      connect: async () => false,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 25_000,
      pollIntervalMs: 10_000,
      onProgress: (elapsedMs) => progressAt.push(elapsedMs),
    });
    expect(progressAt).toEqual([0, 10_000, 20_000]);
  });

  it('races the prompted address against a Hyper-V-discovered one, either winning', async () => {
    const clock1 = fakeClock();
    const onlyPromptedReachable = await waitForReachable({
      getCandidates: () => ['prompted-address', 'hyperv-address'],
      connect: async (address) => address === 'prompted-address',
      now: clock1.now,
      sleep: clock1.sleep,
    });
    expect(onlyPromptedReachable).toEqual({ reachable: true, address: 'prompted-address' });

    const clock2 = fakeClock();
    const onlyHyperVReachable = await waitForReachable({
      getCandidates: () => ['prompted-address', 'hyperv-address'],
      connect: async (address) => address === 'hyperv-address',
      now: clock2.now,
      sleep: clock2.sleep,
    });
    expect(onlyHyperVReachable).toEqual({ reachable: true, address: 'hyperv-address' });
  });

  it('polls repeatedly against an unresponsive port before giving up', async () => {
    const clock = fakeClock();
    let connectCalls = 0;
    const result = await waitForReachable({
      getCandidates: () => ['192.168.67.50'],
      connect: async () => {
        connectCalls += 1;
        return false;
      },
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 20_000,
      pollIntervalMs: 10_000,
    });
    expect(result).toEqual({ reachable: false });
    expect(connectCalls).toBeGreaterThan(1);
  });
});

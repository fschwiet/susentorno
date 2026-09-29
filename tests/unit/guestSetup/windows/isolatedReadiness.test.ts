import { describe, it, expect } from 'vitest';
import {
  WindowsGuestError,
  type WindowsGuestExecutor,
  type WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import {
  ISOLATED_PROBE_HEADER,
  ISOLATED_READINESS_DEADLINE_MS,
  IsolatedReadinessError,
  buildIsolatedProbeScript,
  evaluateIsolatedFacts,
  waitForIsolatedNetwork,
  type IsolatedProbeFacts,
} from '../../../../src/guestSetup/windows/isolatedReadiness';
import { fakeClock, isolatedFacts } from './flowFakes';

const HOST_IP = '192.168.67.1';

const ok = (facts: IsolatedProbeFacts): WindowsGuestResult => ({
  exitCode: 0,
  stdout: JSON.stringify(facts),
  stderr: '',
  timedOut: false,
});

function scriptedExecutor(answer: (attempt: number) => WindowsGuestResult | Error): {
  executor: WindowsGuestExecutor;
  scripts: string[];
  timeouts: number[];
} {
  const scripts: string[] = [];
  const timeouts: number[] = [];
  return {
    scripts,
    timeouts,
    executor: {
      vmName: 'win-dev',
      async invoke(script, options) {
        scripts.push(script);
        timeouts.push(options.timeoutMs);
        const result = answer(scripts.length);
        if (result instanceof Error) throw result;
        return result;
      },
      async drainCancelled() {},
      async dispose() {},
    },
  };
}

describe('buildIsolatedProbeScript', () => {
  const script = buildIsolatedProbeScript(HOST_IP);

  it('is recognizable by its header and probes the host address it was given', () => {
    expect(script.startsWith(ISOLATED_PROBE_HEADER)).toBe(true);
    expect(script).toContain(`'${HOST_IP}'`);
  });

  it('asks the host, not the guest resolver, for the lookup and connects to the proxy stack', () => {
    expect(script).toMatch(/Resolve-DnsName[^\n]*-Server \$hostIp/);
    expect(script).toContain('BeginConnect($hostIp, 443');
  });
});

describe('evaluateIsolatedFacts', () => {
  it('is satisfied by a DHCP lease in the host subnet, the host as gateway and resolver, a lookup, and a proxy connection', () => {
    expect(evaluateIsolatedFacts(isolatedFacts(), HOST_IP)).toEqual([]);
  });

  it('names a missing DHCP lease', () => {
    const unmet = evaluateIsolatedFacts(isolatedFacts({ Addresses: [] }), HOST_IP);
    expect(unmet.map((u) => u.condition)).toContain('lease');
    expect(unmet.find((u) => u.condition === 'lease')!.detail).toContain('no DHCP-assigned');
  });

  it('does not accept a statically configured address as a lease', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({
        Addresses: [
          { InterfaceIndex: 7, Address: '192.168.67.44', PrefixLength: 24, Origin: 'Manual' },
        ],
      }),
      HOST_IP,
    );
    expect(unmet.map((u) => u.condition)).toContain('lease');
  });

  it('does not accept a DHCP lease outside the host subnet', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({
        Addresses: [
          { InterfaceIndex: 7, Address: '172.29.240.9', PrefixLength: 20, Origin: 'Dhcp' },
        ],
      }),
      HOST_IP,
    );
    const lease = unmet.find((u) => u.condition === 'lease')!;
    expect(lease.detail).toContain('172.29.240.9');
    expect(lease.detail).toContain(HOST_IP);
  });

  it('names a gateway that is not the host', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({ Routes: [{ InterfaceIndex: 7, NextHop: '192.168.67.254' }] }),
      HOST_IP,
    );
    expect(unmet.map((u) => u.condition)).toEqual(['gateway']);
    expect(unmet[0].detail).toContain('192.168.67.254');
  });

  it('names a missing default route', () => {
    const unmet = evaluateIsolatedFacts(isolatedFacts({ Routes: [] }), HOST_IP);
    expect(unmet.map((u) => u.condition)).toEqual(['gateway']);
  });

  it('names a resolver that is not the host', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({ DnsServers: [{ InterfaceIndex: 7, Servers: ['8.8.8.8'] }] }),
      HOST_IP,
    );
    expect(unmet.map((u) => u.condition)).toEqual(['dns']);
    expect(unmet[0].detail).toContain('8.8.8.8');
  });

  it('names a failed lookup through the host', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({ Lookup: { Ok: false, Detail: 'DNS name does not exist' } }),
      HOST_IP,
    );
    expect(unmet.map((u) => u.condition)).toEqual(['dns']);
    expect(unmet[0].detail).toContain('DNS name does not exist');
  });

  it('names a proxy stack that cannot be reached', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({ Proxy: { Ok: false, Detail: 'connection refused' } }),
      HOST_IP,
    );
    expect(unmet.map((u) => u.condition)).toEqual(['proxy']);
    expect(unmet[0].detail).toContain('connection refused');
  });

  it('names every unmet condition at once', () => {
    const unmet = evaluateIsolatedFacts(
      isolatedFacts({
        Addresses: [],
        Routes: [],
        DnsServers: [],
        Lookup: { Ok: false, Detail: 'timeout' },
        Proxy: { Ok: false, Detail: 'timeout' },
      }),
      HOST_IP,
    );
    expect(unmet.map((u) => u.condition)).toEqual(['lease', 'gateway', 'dns', 'proxy']);
  });
});

describe('waitForIsolatedNetwork', () => {
  it('returns as soon as every condition holds, without waiting', async () => {
    const guest = scriptedExecutor(() => ok(isolatedFacts()));
    const clock = fakeClock();
    await waitForIsolatedNetwork(guest.executor, { hostIp: HOST_IP, ...clock });
    expect(guest.scripts).toHaveLength(1);
    expect(clock.time).toBe(0);
  });

  it('polls until the network comes up, even through probe failures while the guest settles', async () => {
    const guest = scriptedExecutor((attempt) =>
      attempt === 1
        ? new WindowsGuestError('transport', 'not yet')
        : attempt === 2
          ? ok(isolatedFacts({ Addresses: [] }))
          : ok(isolatedFacts()),
    );
    const clock = fakeClock();
    await waitForIsolatedNetwork(guest.executor, { hostIp: HOST_IP, ...clock });
    expect(guest.scripts).toHaveLength(3);
    expect(clock.time).toBeGreaterThan(0);
  });

  it('gives up after 3 minutes and names each condition still unmet, pointing at run-hosting', async () => {
    const guest = scriptedExecutor(() =>
      ok(isolatedFacts({ Proxy: { Ok: false, Detail: 'connection refused' } })),
    );
    const clock = fakeClock();
    const failure = await waitForIsolatedNetwork(guest.executor, {
      hostIp: HOST_IP,
      ...clock,
    }).catch((error: unknown) => error);
    expect(ISOLATED_READINESS_DEADLINE_MS).toBe(180_000);
    expect(clock.time).toBe(180_000);
    expect(failure).toBeInstanceOf(IsolatedReadinessError);
    const error = failure as IsolatedReadinessError;
    expect(error.unmet.map((u) => u.condition)).toEqual(['proxy']);
    expect(error.message).toContain("'win-dev'");
    expect(error.message).toContain('3 minutes');
    expect(error.message).toContain('the proxy stack');
    expect(error.message).toContain('connection refused');
    expect(error.message).toContain('susentorno run-hosting');
    expect(error.message).toContain(HOST_IP);
  });

  it('names the lease when the guest never got one', async () => {
    const guest = scriptedExecutor(() => ok(isolatedFacts({ Addresses: [] })));
    const error = (await waitForIsolatedNetwork(guest.executor, {
      hostIp: HOST_IP,
      ...fakeClock(),
    }).catch((e: unknown) => e)) as IsolatedReadinessError;
    expect(error.unmet.map((u) => u.condition)).toContain('lease');
    expect(error.message).toContain('DHCP lease');
  });

  it('reports the last probe failure when the guest never answered a probe', async () => {
    const guest = scriptedExecutor(() => new WindowsGuestError('transport', 'the VM went away'));
    const error = (await waitForIsolatedNetwork(guest.executor, {
      hostIp: HOST_IP,
      ...fakeClock(),
    }).catch((e: unknown) => e)) as IsolatedReadinessError;
    expect(error).toBeInstanceOf(IsolatedReadinessError);
    expect(error.message).toContain('the VM went away');
  });

  it('prints an elapsed-time heartbeat about every 15 seconds while waiting', async () => {
    const guest = scriptedExecutor(() => ok(isolatedFacts({ Addresses: [] })));
    const beats: number[] = [];
    await waitForIsolatedNetwork(guest.executor, {
      hostIp: HOST_IP,
      ...fakeClock(),
      onHeartbeat: (elapsed, unmet) => {
        beats.push(elapsed);
        expect(unmet.length).toBeGreaterThan(0);
      },
    }).catch(() => {});
    expect(beats.length).toBeGreaterThanOrEqual(11);
    expect(beats.length).toBeLessThanOrEqual(13);
    expect(beats[0]).toBeGreaterThanOrEqual(15_000);
    expect(beats[0]).toBeLessThan(25_000);
  });

  it('never retries an authentication rejection into a timeout', async () => {
    const guest = scriptedExecutor(
      () => new WindowsGuestError('authentication', 'The guest rejected the credential.'),
    );
    const clock = fakeClock();
    await expect(
      waitForIsolatedNetwork(guest.executor, { hostIp: HOST_IP, ...clock }),
    ).rejects.toMatchObject({ kind: 'authentication' });
    expect(guest.scripts).toHaveLength(1);
  });

  it('stops on cancellation', async () => {
    const guest = scriptedExecutor(() => new WindowsGuestError('cancelled', 'cancelled'));
    await expect(
      waitForIsolatedNetwork(guest.executor, { hostIp: HOST_IP, ...fakeClock() }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('bounds each probe so one hung probe cannot outlast the deadline', async () => {
    const guest = scriptedExecutor(() => ok(isolatedFacts()));
    await waitForIsolatedNetwork(guest.executor, { hostIp: HOST_IP, ...fakeClock() });
    expect(guest.timeouts[0]).toBeLessThanOrEqual(60_000);
  });
});

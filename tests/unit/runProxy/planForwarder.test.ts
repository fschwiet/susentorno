import { describe, it, expect } from 'vitest';
import { planForwarder } from '../../../src/runProxy/forwarder';

const base = { noForward: false, httpPort: 80, httpsPort: 443 };

describe('planForwarder', () => {
  it('is disabled when noForward is set', () => {
    expect(planForwarder({ ...base, noForward: true }, () => '192.168.241.1')).toEqual({
      kind: 'disabled',
    });
  });

  it('starts with same-port rules when an address is resolved', () => {
    expect(planForwarder(base, () => '192.168.241.1')).toEqual({
      kind: 'start',
      listenAddress: '192.168.241.1',
      rules: [
        { listenPort: 80, connectPort: 80 },
        { listenPort: 443, connectPort: 443 },
      ],
    });
  });

  it('prefers an explicit forwardListen over discovery', () => {
    const plan = planForwarder({ ...base, forwardListen: '10.1.2.3' }, () => '192.168.241.1');
    expect(plan).toMatchObject({ kind: 'start', listenAddress: '10.1.2.3' });
  });

  it('errors when enabled but no address can be resolved', () => {
    const plan = planForwarder(base, () => null);
    expect(plan.kind).toBe('error');
    if (plan.kind === 'error') expect(plan.message).toContain('--forward-listen');
  });

  it('honors custom ports', () => {
    expect(planForwarder({ ...base, httpPort: 8080, httpsPort: 8443 }, () => '10.0.0.1')).toEqual({
      kind: 'start',
      listenAddress: '10.0.0.1',
      rules: [
        { listenPort: 8080, connectPort: 8080 },
        { listenPort: 8443, connectPort: 8443 },
      ],
    });
  });
});

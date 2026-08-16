import { describe, expect, it } from 'vitest';
import { describeHeldGatewayPorts } from '../checkGatewayPortsFree';

describe('describeHeldGatewayPorts', () => {
  it('returns null when neither port is held', () => {
    expect(describeHeldGatewayPorts(false, false)).toBeNull();
  });

  it('blames run-hosting when both ports are held', () => {
    const message = describeHeldGatewayPorts(true, true)!;
    expect(message).toContain('run-hosting');
    expect(message).toContain('127.0.0.1:80');
    expect(message).toContain('127.0.0.1:443');
  });

  it('names IIS or a dev server, not run-hosting, when only :80 is held', () => {
    const message = describeHeldGatewayPorts(true, false)!;
    expect(message).toContain('127.0.0.1:80');
    expect(message).not.toContain('127.0.0.1:443');
    expect(message).toContain('IIS');
    expect(message).not.toContain('run-hosting');
  });

  it('names IIS or a dev server, not run-hosting, when only :443 is held', () => {
    const message = describeHeldGatewayPorts(false, true)!;
    expect(message).toContain('127.0.0.1:443');
    expect(message).not.toContain('127.0.0.1:80');
    expect(message).toContain('IIS');
    expect(message).not.toContain('run-hosting');
  });
});

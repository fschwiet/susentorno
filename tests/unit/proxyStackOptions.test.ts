import { describe, expect, it } from 'vitest';
import { buildForwardArgs, buildGatewayPortEnv, HTTP_PORT, HTTPS_PORT } from '../proxyStack';

describe('buildForwardArgs', () => {
  it('defaults to --no-forward, matching every proxy-stack caller', () => {
    expect(buildForwardArgs({})).toEqual(['--no-forward']);
  });

  it('drops --no-forward and passes --isolation-name when forwarding is requested', () => {
    expect(buildForwardArgs({ forward: { isolationName: 'test' } })).toEqual([
      '--isolation-name',
      'test',
    ]);
  });

  it('never emits both flags — run-hosting rejects that combination', () => {
    const args = buildForwardArgs({ forward: { isolationName: 'test' } });
    expect(args).not.toContain('--no-forward');
  });
});

describe('buildGatewayPortEnv', () => {
  it('pins the gateway to 18080/18443 by default', () => {
    expect(buildGatewayPortEnv({})).toEqual({
      ENVOY_HTTP_PORT: String(HTTP_PORT),
      ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    });
  });

  it('leaves both unset when forwarding, so the gateway takes its 80/443 defaults', () => {
    expect(buildGatewayPortEnv({ forward: { isolationName: 'test' } })).toEqual({});
  });
});

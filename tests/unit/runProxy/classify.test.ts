import { describe, it, expect } from 'vitest';
import { classify } from '../../../src/runProxy/classify';
import type { AccessLine } from '../../../src/runProxy/parseLine';

function line(over: Partial<AccessLine>): AccessLine {
  return {
    pathId: 'term',
    time: '2026-07-06T12:00:00',
    serverName: '-',
    authority: '-',
    codeDetails: '-',
    ...over,
  };
}

describe('classify', () => {
  it('maps terminate to ALLOW CRED with the SNI as domain', () => {
    expect(classify(line({ pathId: 'term', serverName: 'api.anthropic.com' }))).toEqual({
      time: '2026-07-06T12:00:00',
      tag: 'ALLOW CRED',
      domain: 'api.anthropic.com',
    });
  });

  it('maps passthrough to ALLOW PASS', () => {
    expect(classify(line({ pathId: 'pass', serverName: 'pypi.org' })).tag).toBe('ALLOW PASS');
  });

  it('maps deny443 to BLOCK TLS', () => {
    expect(classify(line({ pathId: 'deny443', serverName: 'nope.example.com' })).tag).toBe(
      'BLOCK TLS',
    );
  });

  it('uses the authority as domain on port 80 and maps via_upstream to ALLOW HTTP', () => {
    expect(
      classify(
        line({ pathId: 'http', authority: 'archive.ubuntu.com', codeDetails: 'via_upstream' }),
      ),
    ).toEqual({ time: '2026-07-06T12:00:00', tag: 'ALLOW HTTP', domain: 'archive.ubuntu.com' });
  });

  it('maps a port-80 direct_response to BLOCK HTTP', () => {
    expect(
      classify(
        line({ pathId: 'http', authority: 'nope.example.com', codeDetails: 'direct_response' }),
      ).tag,
    ).toBe('BLOCK HTTP');
  });
});

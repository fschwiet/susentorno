import { describe, it, expect } from 'vitest';
import { classify } from '../../src/runProxy/classify';
import type { AccessLine } from '../../src/runProxy/parseLine';

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

describe('access-log line classification', () => {
  it("maps the 'term' path to ALLOW CRED with the SNI as domain", () => {
    expect(classify(line({ pathId: 'term', serverName: 'api.anthropic.com' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW CRED', domain: 'api.anthropic.com' },
    ]);
  });

  it('maps passthrough to ALLOW PASS', () => {
    expect(classify(line({ pathId: 'pass', serverName: 'pypi.org' }))[0].tag).toBe('ALLOW PASS');
  });

  it('maps deny443 to BLOCK TLS', () => {
    expect(classify(line({ pathId: 'deny443', serverName: 'nope.example.com' }))[0].tag).toBe(
      'BLOCK TLS',
    );
  });

  it('uses the authority as domain on port 80 and maps via_upstream to ALLOW HTTP', () => {
    expect(
      classify(
        line({ pathId: 'http', authority: 'archive.ubuntu.com', codeDetails: 'via_upstream' }),
      ),
    ).toEqual([{ time: '2026-07-06T12:00:00', tag: 'ALLOW HTTP', domain: 'archive.ubuntu.com' }]);
  });

  it('maps a port-80 direct_response to BLOCK HTTP', () => {
    expect(
      classify(
        line({ pathId: 'http', authority: 'nope.example.com', codeDetails: 'direct_response' }),
      )[0].tag,
    ).toBe('BLOCK HTTP');
  });

  it('emits one AUTH CANDIDATE entry per present header, skipping "-"', () => {
    const result = classify(
      line({
        pathId: 'cand',
        serverName: 'partner.example.com',
        authHeaders: ['Bearer abc12', '-', 'sk-ant-key01', '-', '-'],
      }),
    );
    expect(result).toEqual([
      {
        time: '2026-07-06T12:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        protocol: 'https',
        header: 'Authorization',
        value: 'Bearer abc12',
      },
      {
        time: '2026-07-06T12:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        protocol: 'https',
        header: 'X-API-Key',
        value: 'sk-ant-key01',
      },
    ]);
  });

  it('emits no entries for a cand line with all headers absent', () => {
    expect(
      classify(
        line({
          pathId: 'cand',
          serverName: 'partner.example.com',
          authHeaders: ['-', '-', '-', '-', '-'],
        }),
      ),
    ).toEqual([]);
  });

  it('classifies an mcp pathId as ALLOW MCP', () => {
    expect(classify(line({ pathId: 'mcp', serverName: 'filesystem.internal' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW MCP', domain: 'filesystem.internal' },
    ]);
  });
});

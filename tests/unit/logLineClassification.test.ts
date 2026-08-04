import { describe, it, expect } from 'vitest';
import { classify } from '../../src/runHosting/classify';
import type { AccessLine } from '../../src/runHosting/parseLine';

function line(over: Partial<AccessLine>): AccessLine {
  return { pathId: 'term', time: '2026-07-06T12:00:00', serverName: '-', authority: '-', codeDetails: '-', ...over };
}

describe('access-log line classification', () => {
  it('classifies TLS paths with port 443', () => {
    expect(classify(line({ pathId: 'term', serverName: 'api.anthropic.com' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW CRED', domain: 'api.anthropic.com', port: 443 },
    ]);
    expect(classify(line({ pathId: 'passopen', serverName: 'open.example.com:443' }))[0].tag).toBe('ALLOW OPEN');
    expect(classify(line({ pathId: 'blocklist', serverName: 'blocked.example.com' }))[0].tag).toBe('BLOCK LIST');
    expect(classify(line({ pathId: 'deny443', serverName: 'nope.example.com' }))[0].tag).toBe('BLOCK TLS');
  });

  it('classifies http routes with port 80', () => {
    expect(classify(line({ pathId: 'http', authority: 'archive.ubuntu.com:80', routeName: 'matched' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW HTTP', domain: 'archive.ubuntu.com', port: 80 },
    ]);
    expect(classify(line({ pathId: 'http', authority: 'nope.example.com', routeName: 'default-deny' }))[0].tag).toBe('BLOCK HTTP');
    expect(classify(line({ pathId: 'http', authority: 'blocked.example.com', routeName: 'blocked' }))[0].tag).toBe('BLOCK LIST');
    expect(classify(line({ pathId: 'http', authority: 'open.example.com', routeName: 'open' }))[0].tag).toBe('ALLOW OPEN');
  });

  it('emits port 443 auth-candidate entries and skips absent headers', () => {
    expect(classify(line({ pathId: 'cand', serverName: 'partner.example.com', authHeaders: ['Bearer abc12', '-', 'sk-ant-key01', '-', '-'] }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'AUTH CANDIDATE', domain: 'partner.example.com', port: 443, protocol: 'https', header: 'Authorization', value: 'Bearer abc12' },
      { time: '2026-07-06T12:00:00', tag: 'AUTH CANDIDATE', domain: 'partner.example.com', port: 443, protocol: 'https', header: 'X-API-Key', value: 'sk-ant-key01' },
    ]);
  });

  it('classifies MCP as ALLOW MCP', () => {
    expect(classify(line({ pathId: 'mcp', serverName: 'filesystem.internal' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW MCP', domain: 'filesystem.internal', port: 443 },
    ]);
  });
});

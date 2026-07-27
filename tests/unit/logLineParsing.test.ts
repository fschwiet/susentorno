import { describe, it, expect } from 'vitest';
import { parseLine } from '../../src/runProxy/parseLine';

describe('access-log line parsing', () => {
  it('parses a well-formed CFGM line', () => {
    const line =
      'CFGM|term|2026-07-06T12:04:31|api.anthropic.com|api.anthropic.com|via_upstream|200|-|842|1531';
    expect(parseLine(line)).toEqual({
      pathId: 'term',
      time: '2026-07-06T12:04:31',
      serverName: 'api.anthropic.com',
      authority: 'api.anthropic.com',
      codeDetails: 'via_upstream',
      responseCode: '200',
      responseFlags: '-',
      duration: '842',
      bytesSent: '1531',
    });
  });

  it('tolerates a docker compose log prefix before the marker', () => {
    const line = 'envoy-1  | CFGM|deny443|2026-07-06T12:00:00|blocked.example.com|-|-|-|NR|3|0';
    expect(parseLine(line)?.pathId).toBe('deny443');
    expect(parseLine(line)?.serverName).toBe('blocked.example.com');
    expect(parseLine(line)?.responseFlags).toBe('NR');
  });

  it('returns null for Envoy operational lines', () => {
    expect(parseLine('[2026-07-06 12:00:00.000][1][info][main] starting')).toBeNull();
  });

  it('returns null for an unknown path-id', () => {
    expect(parseLine('CFGM|bogus|2026-07-06T12:04:31|-|-|-')).toBeNull();
  });

  it('returns null when the field count is wrong', () => {
    expect(parseLine('CFGM|term|2026-07-06T12:04:31|only-four')).toBeNull();
  });

  it('returns null for the old 6-field non-cand shape (now missing 4 required fields)', () => {
    expect(
      parseLine('CFGM|term|2026-07-06T12:04:31|api.anthropic.com|api.anthropic.com|via_upstream'),
    ).toBeNull();
  });

  it('parses an 11-field cand line into authHeaders', () => {
    const line =
      'CFGM|cand|2026-07-18T09:00:00|partner.example.com|partner.example.com|via_upstream|Bearer abc12|-|sk-ant-key01|-|-';
    expect(parseLine(line)).toEqual({
      pathId: 'cand',
      time: '2026-07-18T09:00:00',
      serverName: 'partner.example.com',
      authority: 'partner.example.com',
      codeDetails: 'via_upstream',
      authHeaders: ['Bearer abc12', '-', 'sk-ant-key01', '-', '-'],
    });
  });

  it('returns null for a cand line without 11 fields', () => {
    expect(
      parseLine(
        'CFGM|cand|2026-07-18T09:00:00|partner.example.com|partner.example.com|via_upstream',
      ),
    ).toBeNull();
  });

  it('returns null for a non-cand line with 11 fields', () => {
    expect(parseLine('CFGM|term|t|s|a|d|x|x|x|x|x')).toBeNull();
  });
});

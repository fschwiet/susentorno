import { describe, it, expect } from 'vitest';
import { parseAllowlist, formatAllowlist, type Allowlist } from '../../src/allowlist';

describe('formatAllowlist', () => {
  it('writes sorted passthrough and terminate sections', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };

    expect(formatAllowlist(allowlist)).toBe(
      [
        '# passthrough',
        '**.chatgpt.com:443',
        'archive.ubuntu.com:80',
        '',
        '# terminate',
        'api.anthropic.com:443',
        'claude.com:443',
        '',
      ].join('\n'),
    );
  });
});

describe('parseAllowlist', () => {
  it('splits entries into passthrough and terminate by section header', () => {
    const content = [
      '# passthrough',
      '**.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });

  it('round-trips through formatAllowlist', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };

    expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });

  it('drops an exact-duplicate line within a section, keeping first-occurrence order', () => {
    const content = [
      '# passthrough',
      'archive.ubuntu.com:80',
      '**.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });

  it('keeps the same host in both passthrough and terminate independently', () => {
    const content = [
      '# passthrough',
      'shared.example.com:443',
      '',
      '# terminate',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['shared.example.com:443'],
      terminate: ['shared.example.com:443'],
      invalid: [],
    });
  });

  it('flags a mid-string wildcard as invalid instead of treating it as passthrough', () => {
    const content = [
      '# passthrough',
      'crl*.digicert.com:80',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['crl*.digicert.com:80'],
    });
  });

  it('flags any wildcard in the terminate section as invalid, valid shape or not', () => {
    const content = [
      '# passthrough',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      '**.anthropic.com:443',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['**.anthropic.com:443'],
    });
  });

  it('dedupes repeated invalid entries', () => {
    const content = [
      '# passthrough',
      'crl*.digicert.com:80',
      'crl*.digicert.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      terminate: ['api.anthropic.com:443'],
      invalid: ['crl*.digicert.com:80'],
    });
  });
});

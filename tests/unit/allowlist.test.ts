import { describe, it, expect } from 'vitest';
import {
  parseAllowlist,
  formatAllowlist,
  terminateTlsHosts,
  type Allowlist,
} from '../../src/allowlist';

describe('formatAllowlist', () => {
  it('writes sorted passthrough and terminate sections', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };

    expect(formatAllowlist(allowlist)).toBe(
      [
        '#pragma passthrough',
        '*.chatgpt.com:443',
        'archive.ubuntu.com:80',
        '',
        '#pragma claude authenticated',
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
      '#pragma passthrough',
      '*.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });

  it('recognizes #pragma section headers', () => {
    const content = [
      '#pragma passthrough',
      '*.chatgpt.com:443',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.chatgpt.com:443'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('throws on an unrecognized #pragma line', () => {
    expect(() => parseAllowlist('#pragma bogus\n')).toThrow('Invalid pragma: "#pragma bogus"');
  });

  it('throws a migration hint on the legacy # terminate header', () => {
    expect(() => parseAllowlist('# terminate\napi.anthropic.com:443\n')).toThrow(
      'Legacy allowlist header "# terminate"; use "#pragma claude authenticated"',
    );
  });

  it('throws a migration hint on the legacy # passthrough header', () => {
    expect(() => parseAllowlist('# passthrough\npypi.org:443\n')).toThrow(
      'Legacy allowlist header "# passthrough"; use "#pragma passthrough"',
    );
  });

  it('still ignores non-pragma comment lines', () => {
    const content = [
      '#pragma passthrough',
      '## a free-text comment',
      'pypi.org:443',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['pypi.org:443'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('round-trips through formatAllowlist', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
      invalid: [],
    };

    expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });

  it('drops an exact-duplicate line within a section, keeping first-occurrence order', () => {
    const content = [
      '#pragma passthrough',
      'archive.ubuntu.com:80',
      '*.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    });
  });

  it('keeps the same host in both passthrough and terminate independently', () => {
    const content = [
      '#pragma passthrough',
      'shared.example.com:443',
      '',
      '#pragma claude authenticated',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['shared.example.com:443'],
      terminate: ['shared.example.com:443'],
      invalid: [],
    });
  });

  it('flags a **.host wildcard as invalid instead of normalizing it', () => {
    const content = [
      '#pragma passthrough',
      '**.ubuntu.com:80',
      'archive.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['**.ubuntu.com:80'],
    });
  });

  it('keeps *.host but flags the **.host spelling of the same host as invalid', () => {
    const content = [
      '#pragma passthrough',
      '*.ubuntu.com:80',
      '**.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['**.ubuntu.com:80'],
    });
  });

  it('prunes an exact passthrough entry covered by a same-port wildcard', () => {
    const content = [
      '#pragma passthrough',
      '*.ubuntu.com:80',
      'archive.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('does not prune an exact entry at a different port than the wildcard', () => {
    const content = [
      '#pragma passthrough',
      '*.ubuntu.com:80',
      'archive.ubuntu.com:443',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80', 'archive.ubuntu.com:443'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it("does not prune the wildcard's own bare base domain, since it is not a subdomain", () => {
    const content = [
      '#pragma passthrough',
      '*.ubuntu.com:80',
      'ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80', 'ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: [],
    });
  });

  it('does not prune a terminate entry covered by a passthrough wildcard', () => {
    const content = [
      '#pragma passthrough',
      '*.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      'archive.ubuntu.com:80',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['*.ubuntu.com:80'],
      terminate: ['archive.ubuntu.com:80'],
      invalid: [],
    });
  });

  it('flags a mid-string wildcard as invalid instead of treating it as passthrough', () => {
    const content = [
      '#pragma passthrough',
      'crl*.digicert.com:80',
      'archive.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
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
      '#pragma passthrough',
      'archive.ubuntu.com:80',
      '',
      '#pragma claude authenticated',
      '*.anthropic.com:443',
      'api.anthropic.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443'],
      invalid: ['*.anthropic.com:443'],
    });
  });

  it('dedupes repeated invalid entries', () => {
    const content = [
      '#pragma passthrough',
      'crl*.digicert.com:80',
      'crl*.digicert.com:80',
      '',
      '#pragma claude authenticated',
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

describe('terminateTlsHosts', () => {
  it('returns terminate :443 hosts without the port and excludes passthrough', () => {
    const allowlist: Allowlist = {
      passthrough: ['pypi.org:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
      invalid: [],
    };
    expect(terminateTlsHosts(allowlist)).toEqual(['api.anthropic.com', 'claude.com']);
  });

  it('ignores non-:443 terminate entries', () => {
    const allowlist: Allowlist = { passthrough: [], terminate: ['example.com:80'], invalid: [] };
    expect(terminateTlsHosts(allowlist)).toEqual([]);
  });
});

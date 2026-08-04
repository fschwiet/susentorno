import { describe, it, expect } from 'vitest';
import {
  parseAllowListFile,
  parseAuthListFile,
  combinePolicy,
  formatAllowListFile,
  formatAuthListFile,
  terminateTlsHosts,
  type Allowlist,
} from '../../src/allowlist';
import { parseBlockListFile } from '../../src/blockList';

const noBlocks = parseBlockListFile('');

describe('allow-list parsing', () => {
  it('parses flat host:port lines and ignores comments', () => {
    expect(parseAllowListFile('#pragma passthrough\n*.chatgpt.com:443\npypi.org:443\n')).toEqual({
      entries: ['*.chatgpt.com:443', 'pypi.org:443'],
      warnings: [],
    });
  });

  it('dedupes, rejects unsupported wildcards, and prunes covered exact entries', () => {
    expect(
      parseAllowListFile(
        [
          '*.ubuntu.com:80',
          'archive.ubuntu.com:80',
          'archive.ubuntu.com:443',
          '**.bad.com:80',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      entries: ['*.ubuntu.com:80', 'archive.ubuntu.com:443'],
      warnings: ["unsupported wildcard syntax, excluded: '**.bad.com:80'"],
    });
  });

  it('does not prune a wildcard base domain or a different port', () => {
    expect(parseAllowListFile('*.ubuntu.com:80\nubuntu.com:80\n')).toEqual({
      entries: ['*.ubuntu.com:80', 'ubuntu.com:80'],
      warnings: [],
    });
  });
});

describe('auth-list parsing', () => {
  it('splits the four pragma sections', () => {
    expect(
      parseAuthListFile(
        [
          '#pragma claude authenticated',
          'api.anthropic.com:443',
          '',
          '#pragma github authenticated',
          'github.com:443',
          '',
          '#pragma codex authenticated',
          'chatgpt.com:443',
          '',
          '#pragma auth candidate',
          'partner.example.com:443',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['github.com:443'],
      codexAuthenticated: ['chatgpt.com:443'],
      authCandidate: ['partner.example.com:443'],
      warnings: [],
    });
  });

  it('ignores orphan and comment lines, but rejects invalid pragmas and legacy terminate', () => {
    expect(
      parseAuthListFile(
        'orphan.example.com:443\n#pragma claude authenticated\n## c\napi.example.com:443\n',
      ).claudeAuthenticated,
    ).toEqual(['api.example.com:443']);
    expect(() => parseAuthListFile('#pragma bogus\n')).toThrow('Invalid pragma: "#pragma bogus"');
    expect(() => parseAuthListFile('# terminate\n')).toThrow(
      'Legacy allowlist header "# terminate"; use "#pragma claude authenticated"',
    );
  });

  it('rejects wildcards and dedupes entries within sections', () => {
    expect(
      parseAuthListFile(
        [
          '#pragma claude authenticated',
          '*.anthropic.com:443',
          'api.anthropic.com:443',
          'api.anthropic.com:443',
        ].join('\n'),
      ),
    ).toEqual({
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      warnings: ["unsupported wildcard syntax, excluded: '*.anthropic.com:443'"],
    });
  });
});

describe('formatting', () => {
  it('formats allow-list as sorted flat lines', () => {
    expect(formatAllowListFile(['archive.ubuntu.com:80', '*.chatgpt.com:443'])).toBe(
      '*.chatgpt.com:443\narchive.ubuntu.com:80\n',
    );
  });

  it('formats auth-list with sorted present-only sections', () => {
    expect(
      formatAuthListFile({
        claudeAuthenticated: ['claude.com:443', 'api.anthropic.com:443'],
        githubAuthenticated: ['github.com:443'],
        codexAuthenticated: [],
        authCandidate: ['b.example.com:443', 'a.example.com:443'],
      }),
    ).toBe(
      [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        'claude.com:443',
        '',
        '#pragma github authenticated',
        'github.com:443',
        '',
        '#pragma auth candidate',
        'a.example.com:443',
        'b.example.com:443',
        '',
      ].join('\n'),
    );
  });
});

describe('combinePolicy', () => {
  it('combines lists and resolves exact collisions by auth priority', () => {
    const allowList = parseAllowListFile('shared.example.com:443\n');
    const authList = parseAuthListFile(
      [
        '#pragma claude authenticated',
        'shared.example.com:443',
        '',
        '#pragma auth candidate',
        'shared.example.com:443',
        '',
      ].join('\n'),
    );
    expect(combinePolicy(allowList, authList, noBlocks)).toEqual({
      passthrough: [],
      claudeAuthenticated: [],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: ['shared.example.com:443'],
      blocked: [],
      warnings: [
        "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated and authCandidate; using authCandidate",
      ],
    });
  });

  it('prunes exact and wildcard block matches before collision resolution', () => {
    const allowList = parseAllowListFile(
      'blocked.example.com:443\nads.doubleclick.net:80\ndoubleclick.net:80\n',
    );
    const authList = parseAuthListFile(
      ['#pragma claude authenticated', 'blocked.example.com:443', ''].join('\n'),
    );
    const result = combinePolicy(
      allowList,
      authList,
      parseBlockListFile('blocked.example.com\n*.doubleclick.net\n'),
    );
    expect(result.passthrough).toEqual(['doubleclick.net:80']);
    expect(result.claudeAuthenticated).toEqual([]);
    expect(result.blocked).toEqual(['blocked.example.com', '*.doubleclick.net']);
    expect(result.warnings).toEqual([
      "blocked: 'blocked.example.com:443' removed from passthrough (matches block-list.txt)",
      "blocked: 'ads.doubleclick.net:80' removed from passthrough (matches block-list.txt)",
      "blocked: 'blocked.example.com:443' removed from claudeAuthenticated (matches block-list.txt)",
    ]);
  });
});

describe('terminateTlsHosts', () => {
  it('returns all auth :443 hosts without ports and excludes other ports', () => {
    const authList = parseAuthListFile(
      [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        'plain.example.com:80',
        '',
        '#pragma github authenticated',
        'github.com:443',
        '',
        '#pragma codex authenticated',
        'chatgpt.com:443',
        '',
        '#pragma auth candidate',
        'partner.example.com:443',
        '',
      ].join('\n'),
    );
    expect(terminateTlsHosts(authList)).toEqual([
      'api.anthropic.com',
      'github.com',
      'chatgpt.com',
      'partner.example.com',
    ]);
  });

  it('accepts the fully combined Allowlist shape', () => {
    const combined: Allowlist = {
      passthrough: [],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      blocked: [],
      warnings: [],
    };
    expect(terminateTlsHosts(combined)).toEqual(['api.anthropic.com']);
  });
});

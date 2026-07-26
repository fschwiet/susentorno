import { describe, it, expect } from 'vitest';
import {
  parseAllowlist,
  formatAllowlist,
  terminateTlsHosts,
  type Allowlist,
} from '../../src/allowlist';

describe('allowlist parsing, formatting & collision resolution', () => {
  describe('formatting', () => {
    it('writes sorted passthrough and claude authenticated sections', () => {
      const allowlist: Allowlist = {
        passthrough: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
        claudeAuthenticated: ['claude.com:443', 'api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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

  describe('passthrough & claude-authenticated sections', () => {
    it('splits entries into passthrough and claude authenticated by section header', () => {
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
        claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      });
    });

    it('round-trips through formatAllowlist', () => {
      const allowlist: Allowlist = {
        passthrough: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
        claudeAuthenticated: ['claude.com:443', 'api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      };

      expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
        passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
        claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: ["unsupported wildcard syntax, excluded: '**.ubuntu.com:80'"],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: ["unsupported wildcard syntax, excluded: '**.ubuntu.com:80'"],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      });
    });

    it('does not prune a claude-authenticated entry covered by a passthrough wildcard', () => {
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
        claudeAuthenticated: ['archive.ubuntu.com:80'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: ["unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'"],
      });
    });

    it('flags any wildcard in the claude authenticated section as invalid, valid shape or not', () => {
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: ["unsupported wildcard syntax, excluded: '*.anthropic.com:443'"],
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
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: ["unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'"],
      });
    });

    describe('collision resolution', () => {
      it('resolves a passthrough+claudeAuthenticated collision to claudeAuthenticated with a warning', () => {
        const content = [
          '#pragma passthrough',
          'shared.example.com:443',
          '',
          '#pragma claude authenticated',
          'shared.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: [],
          claudeAuthenticated: ['shared.example.com:443'],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [
            "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated",
          ],
        });
      });

      it('does not treat a wildcard-covered claude-authenticated host as a collision', () => {
        const content = [
          '#pragma passthrough',
          '*.example.com:443',
          '',
          '#pragma claude authenticated',
          'foo.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: ['*.example.com:443'],
          claudeAuthenticated: ['foo.example.com:443'],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [],
        });
      });

      it('emits an invalid-syntax warning and a collision warning together, syntax first', () => {
        const content = [
          '#pragma passthrough',
          'crl*.digicert.com:80',
          'shared.example.com:443',
          '',
          '#pragma claude authenticated',
          'shared.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: [],
          claudeAuthenticated: ['shared.example.com:443'],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [
            "unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'",
            "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated",
          ],
        });
      });
    });
  });

  describe('auth-candidate section', () => {
    it('parses the #pragma auth candidate section like claude authenticated', () => {
      const content = [
        '#pragma passthrough',
        'pypi.org:443',
        '',
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma auth candidate',
        'partner.example.com:443',
        '',
      ].join('\n');

      expect(parseAllowlist(content)).toEqual({
        passthrough: ['pypi.org:443'],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: ['partner.example.com:443'],
        warnings: [],
      });
    });

    it('flags a wildcard in the auth candidate section as invalid', () => {
      const content = [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma auth candidate',
        '*.partner.example.com:443',
        'partner.example.com:443',
        '',
      ].join('\n');

      expect(parseAllowlist(content)).toEqual({
        passthrough: [],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: ['partner.example.com:443'],
        warnings: ["unsupported wildcard syntax, excluded: '*.partner.example.com:443'"],
      });
    });

    describe('collision resolution', () => {
      it('resolves a claudeAuthenticated+authCandidate collision to authCandidate with a warning', () => {
        const content = [
          '#pragma claude authenticated',
          'shared.example.com:443',
          '',
          '#pragma auth candidate',
          'shared.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: [],
          claudeAuthenticated: [],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: ['shared.example.com:443'],
          warnings: [
            "collision: 'shared.example.com:443' listed in claudeAuthenticated and authCandidate; using authCandidate",
          ],
        });
      });

      it('resolves a passthrough+authCandidate collision to authCandidate with a warning', () => {
        const content = [
          '#pragma passthrough',
          'shared.example.com:443',
          '',
          '#pragma auth candidate',
          'shared.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: [],
          claudeAuthenticated: [],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: ['shared.example.com:443'],
          warnings: [
            "collision: 'shared.example.com:443' listed in passthrough and authCandidate; using authCandidate",
          ],
        });
      });

      it('resolves a host present in all three sections to authCandidate, naming all three', () => {
        const content = [
          '#pragma passthrough',
          'shared.example.com:443',
          '',
          '#pragma claude authenticated',
          'shared.example.com:443',
          '',
          '#pragma auth candidate',
          'shared.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: [],
          claudeAuthenticated: [],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: ['shared.example.com:443'],
          warnings: [
            "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated and authCandidate; using authCandidate",
          ],
        });
      });
    });

    describe('formatting', () => {
      it('omits the auth candidate section from formatAllowlist when empty', () => {
        const allowlist: Allowlist = {
          passthrough: ['pypi.org:443'],
          claudeAuthenticated: ['api.anthropic.com:443'],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [],
        };
        expect(formatAllowlist(allowlist)).toBe(
          [
            '#pragma passthrough',
            'pypi.org:443',
            '',
            '#pragma claude authenticated',
            'api.anthropic.com:443',
            '',
          ].join('\n'),
        );
      });

      it('writes and round-trips the auth candidate section when present', () => {
        const allowlist: Allowlist = {
          passthrough: [],
          claudeAuthenticated: ['api.anthropic.com:443'],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: ['b.example.com:443', 'a.example.com:443'],
          warnings: [],
        };
        const formatted = formatAllowlist(allowlist);
        expect(formatted).toBe(
          [
            '#pragma passthrough',
            '',
            '#pragma claude authenticated',
            'api.anthropic.com:443',
            '',
            '#pragma auth candidate',
            'a.example.com:443',
            'b.example.com:443',
            '',
          ].join('\n'),
        );
        expect(parseAllowlist(formatted)).toEqual({
          passthrough: [],
          claudeAuthenticated: ['api.anthropic.com:443'],
          githubAuthenticated: [],
          codexAuthenticated: [],
          authCandidate: ['a.example.com:443', 'b.example.com:443'],
          warnings: [],
        });
      });
    });
  });

  describe('github-authenticated section', () => {
    it('parses the #pragma github authenticated section as its own field', () => {
      const content = [
        '#pragma passthrough',
        'pypi.org:443',
        '',
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma github authenticated',
        'github.com:443',
        'api.github.com:443',
        '',
      ].join('\n');

      expect(parseAllowlist(content)).toEqual({
        passthrough: ['pypi.org:443'],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: ['github.com:443', 'api.github.com:443'],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      });
    });

    it('flags a wildcard in the github section as invalid', () => {
      const content = [
        '#pragma github authenticated',
        '*.github.com:443',
        'github.com:443',
        '',
      ].join('\n');

      expect(parseAllowlist(content)).toEqual({
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: ['github.com:443'],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: ["unsupported wildcard syntax, excluded: '*.github.com:443'"],
      });
    });

    describe('collision resolution', () => {
      it('resolves a claude+github collision to github with a warning', () => {
        const content = [
          '#pragma claude authenticated',
          'shared.example.com:443',
          '',
          '#pragma github authenticated',
          'shared.example.com:443',
          '',
        ].join('\n');

        expect(parseAllowlist(content)).toEqual({
          passthrough: [],
          claudeAuthenticated: [],
          githubAuthenticated: ['shared.example.com:443'],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [
            "collision: 'shared.example.com:443' listed in claudeAuthenticated and githubAuthenticated; using githubAuthenticated",
          ],
        });
      });
    });

    describe('formatting', () => {
      it('round-trips the github section through formatAllowlist', () => {
        const allowlist: Allowlist = {
          passthrough: [],
          claudeAuthenticated: ['api.anthropic.com:443'],
          githubAuthenticated: ['github.com:443', 'api.github.com:443'],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [],
        };
        const formatted = formatAllowlist(allowlist);
        expect(formatted).toBe(
          [
            '#pragma passthrough',
            '',
            '#pragma claude authenticated',
            'api.anthropic.com:443',
            '',
            '#pragma github authenticated',
            'api.github.com:443',
            'github.com:443',
            '',
          ].join('\n'),
        );
        expect(parseAllowlist(formatted)).toEqual({
          passthrough: [],
          claudeAuthenticated: ['api.anthropic.com:443'],
          githubAuthenticated: ['api.github.com:443', 'github.com:443'],
          codexAuthenticated: [],
          authCandidate: [],
          warnings: [],
        });
      });
    });
  });

  describe('codex-authenticated section', () => {
    it('parses a codex authenticated section', () => {
      const parsed = parseAllowlist(
        ['#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
      );
      expect(parsed.codexAuthenticated).toEqual(['chatgpt.com:443']);
    });

    describe('formatting', () => {
      it('round-trips a codex section through formatAllowlist', () => {
        const parsed = parseAllowlist(
          ['#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
        );
        expect(formatAllowlist(parsed)).toContain('#pragma codex authenticated');
        expect(formatAllowlist(parsed)).toContain('chatgpt.com:443');
      });
    });
  });

  describe('terminateTlsHosts', () => {
    it('returns claude-authenticated :443 hosts without the port and excludes passthrough', () => {
      const allowlist: Allowlist = {
        passthrough: ['pypi.org:443', 'archive.ubuntu.com:80'],
        claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      };
      expect(terminateTlsHosts(allowlist)).toEqual(['api.anthropic.com', 'claude.com']);
    });

    it('ignores non-:443 entries', () => {
      const allowlist: Allowlist = {
        passthrough: [],
        claudeAuthenticated: ['example.com:80'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      };
      expect(terminateTlsHosts(allowlist)).toEqual([]);
    });

    it('includes auth candidate :443 hosts alongside claude hosts', () => {
      const allowlist: Allowlist = {
        passthrough: [],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: ['partner.example.com:443', 'plain.example.com:80'],
        warnings: [],
      };
      expect(terminateTlsHosts(allowlist)).toEqual(['api.anthropic.com', 'partner.example.com']);
    });

    it('includes github :443 hosts in terminateTlsHosts', () => {
      const allowlist: Allowlist = {
        passthrough: [],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: ['github.com:443', 'api.github.com:443'],
        codexAuthenticated: [],
        authCandidate: [],
        warnings: [],
      };
      expect(terminateTlsHosts(allowlist)).toEqual([
        'api.anthropic.com',
        'github.com',
        'api.github.com',
      ]);
    });

    it('includes codex hosts in terminateTlsHosts', () => {
      const parsed = parseAllowlist(
        ['#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
      );
      expect(terminateTlsHosts(parsed)).toContain('chatgpt.com');
    });
  });
});

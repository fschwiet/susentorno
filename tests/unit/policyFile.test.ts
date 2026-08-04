import { describe, it, expect } from 'vitest';
import { parsePolicyFile } from '../../src/policyFile';

describe('policy import (network/allow → allowlist)', () => {
  describe('collecting network/allow rules', () => {
    it('collects network/allow resources, splitting claude-authenticated hosts from passthrough', () => {
      const content = [
        'PROVENANCE   APPLIES_TO      POLICY/RULE                    TYPE               DECISION   RESOURCES',
        'local        all             default-ai-services            network            allow      **.chatgpt.com:443',
        '                                                                                          api.anthropic.com:443',
        '                                                                                          claude.com:443',
        '',
        'local        all             default-os-packages            network            allow      archive.ubuntu.com:80',
        '',
        'local        all             default-fs-read-allow-all      filesystem:read    allow      **',
        '',
        'kit          sandbox:onion   kit:onion                      network            allow      claude.com:443',
      ].join('\n');

      expect(parsePolicyFile(content)).toEqual({
        passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
        claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: [],
        warnings: [],
      });
    });

    it('normalizes **.host and skips unsupported wildcard patterns', () => {
      const content = [
        'PROVENANCE   APPLIES_TO   POLICY/RULE   TYPE      DECISION   RESOURCES',
        'local        all          svc           network   allow      **.chatgpt.com:443',
        '                                                             *.already.com:443',
        '                                                             foo*.bar.com:443',
        '                                                             api.anthropic.com:443',
      ].join('\n');

      expect(parsePolicyFile(content)).toEqual({
        passthrough: ['*.already.com:443', '*.chatgpt.com:443'],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: [],
        warnings: ["unsupported wildcard syntax, excluded: 'foo*.bar.com:443'"],
      });
    });
  });

  describe('no matching rules', () => {
    it('returns empty arrays when there are no network/allow rows', () => {
      const content = [
        'PROVENANCE   APPLIES_TO      POLICY/RULE                    TYPE               DECISION   RESOURCES',
        'local        all             default-fs-write-allow-all     filesystem:write   allow      **',
      ].join('\n');

      expect(parsePolicyFile(content)).toEqual({
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: [],
        warnings: [],
      });
    });
  });
});

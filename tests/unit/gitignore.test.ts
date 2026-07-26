import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { templatesDir } from '../../src/templates';

describe('environment ignore rules', () => {
  const gitignore = readFileSync(join(templatesDir(), 'configamatron.gitignore'), 'utf8');

  describe('customization surface', () => {
    it('ignores everything by default', () => expect(gitignore).toMatch(/^\*$/m));
    it('re-includes the user-authored customization surface', () => {
      for (const line of [
        '!/.gitignore',
        '!/pre-scripts/',
        '!/pre-scripts/**',
        '!/post-scripts/',
        '!/post-scripts/**',
        '!/home-jq-transforms/',
        '!/home-jq-transforms/**',
        '!/proxy/',
        '!/proxy/allowlist.txt',
      ]) {
        expect(gitignore, line).toContain(line);
      }
    });
  });

  describe('secrets', () => {
    it('does not enumerate secrets to exclude', () => {
      expect(gitignore).not.toContain('proxy/secrets/');
      expect(gitignore).not.toContain('credentials.json');
    });
  });
});

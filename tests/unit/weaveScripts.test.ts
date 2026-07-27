import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFolderContents, renumber } from '../../src/weaveScripts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function touch(name: string) {
  writeFileSync(join(dir, name), '');
}

describe('pre-/post-isolation step weaving', () => {
  describe('ordering', () => {
    it('returns empty contents for a missing folder', () => {
      const r = readFolderContents({
        dir: join(dir, 'nope'),
        extension: 'sh',
        allowSentinel: false,
        strictExtension: false,
      });
      expect(r.scripts).toEqual([]);
      expect(r.passthrough).toEqual([]);
    });

    it('orders scripts by prefix and keeps the remainder for renaming', () => {
      touch('02-second.sh');
      touch('01_first.sh');
      const r = readFolderContents({
        dir,
        extension: 'sh',
        allowSentinel: false,
        strictExtension: false,
      });
      expect(r.scripts.map((s) => s.sourceName)).toEqual(['01_first.sh', '02-second.sh']);
      expect(r.scripts[0].remainder).toBe('first.sh');
      expect(r.scripts[1].remainder).toBe('second.sh');
    });

    it('breaks a prefix tie by full filename, byte-ordinal ascending', () => {
      touch('01-bravo.sh');
      touch('01-alpha.sh');
      const r = readFolderContents({
        dir,
        extension: 'sh',
        allowSentinel: false,
        strictExtension: false,
      });
      expect(r.scripts.map((s) => s.sourceName)).toEqual(['01-alpha.sh', '01-bravo.sh']);
    });

    it('filters to the requested extension and treats the other platform as neither script nor passthrough', () => {
      touch('01-linux.sh');
      touch('01-windows.ps1');
      const r = readFolderContents({
        dir,
        extension: 'sh',
        allowSentinel: false,
        strictExtension: false,
      });
      expect(r.scripts.map((s) => s.sourceName)).toEqual(['01-linux.sh']);
      expect(r.passthrough).toEqual([]);
    });

    it('honors the nn sentinel when allowSentinel is true and sorts it last', () => {
      touch('nn-network.sh');
      touch('05-late.sh');
      const r = readFolderContents({
        dir,
        extension: 'sh',
        allowSentinel: true,
        strictExtension: true,
      });
      expect(r.scripts.map((s) => s.sourceName)).toEqual(['05-late.sh', 'nn-network.sh']);
    });

    it('collects non-script files and directories as passthrough', () => {
      touch('dnsmasq-stub.conf');
      mkdirSync(join(dir, 'lib'));
      const r = readFolderContents({
        dir,
        extension: 'sh',
        allowSentinel: false,
        strictExtension: false,
      });
      const names = r.passthrough.map((p) => `${p.name}:${p.isDirectory}`).sort();
      expect(names).toEqual(['dnsmasq-stub.conf:false', 'lib:true']);
    });
  });

  describe('customization-input validation', () => {
    it('rejects the nn sentinel when allowSentinel is false', () => {
      touch('nn-network.sh');
      expect(() =>
        readFolderContents({ dir, extension: 'sh', allowSentinel: false, strictExtension: false }),
      ).toThrow(/nn/);
    });

    it('rejects an empty name, a bad prefix, and an uppercase extension, listing every offender', () => {
      touch('01-.sh');
      touch('1-bad.sh');
      touch('01-up.SH');
      touch('ok.txt');
      let message = '';
      try {
        readFolderContents({ dir, extension: 'sh', allowSentinel: false, strictExtension: false });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('01-.sh');
      expect(message).toContain('1-bad.sh');
      expect(message).toContain('01-up.SH');
      expect(message).not.toContain('ok.txt');
    });

    it('rejects an opposite-extension script in a built-in folder (strictExtension)', () => {
      touch('01-stray.ps1');
      expect(() =>
        readFolderContents({ dir, extension: 'sh', allowSentinel: true, strictExtension: true }),
      ).toThrow(/01-stray\.ps1/);
    });
  });

  describe('renumbering', () => {
    it('renumbers contiguously and builds output names from the remainder', () => {
      const scripts = [
        {
          sourcePath: '/a/04-configure.sh',
          sourceName: '04-configure.sh',
          remainder: 'configure.sh',
          ext: 'sh' as const,
          sentinel: false,
        },
        {
          sourcePath: '/b/nn-network.sh',
          sourceName: 'nn-network.sh',
          remainder: 'network.sh',
          ext: 'sh' as const,
          sentinel: true,
        },
      ];
      expect(renumber(scripts)).toEqual([
        { sourcePath: '/a/04-configure.sh', outputName: '01-configure.sh' },
        { sourcePath: '/b/nn-network.sh', outputName: '02-network.sh' },
      ]);
    });

    it('fails loud when the combined count exceeds 99', () => {
      const scripts = Array.from({ length: 100 }, (_, i) => ({
        sourcePath: `/x/${i}.sh`,
        sourceName: `${i}.sh`,
        remainder: 'x.sh',
        ext: 'sh' as const,
        sentinel: false,
      }));
      expect(() => renumber(scripts)).toThrow(/99/);
    });
  });
});

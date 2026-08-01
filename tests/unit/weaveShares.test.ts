import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envPaths } from '../../src/envPaths';
import { planAllPhases, weaveShares } from '../../src/weaveShares';

function findPlan(plans: ReturnType<typeof planAllPhases>, dirEndsWith: string) {
  return plans.find((p) => p.livePhaseDir.replace(/\\/g, '/').endsWith(dirEndsWith));
}

let work: string;
let templates: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'weave-shares-'));
  templates = join(work, 'templates');
  for (const share of ['vm-shared', 'vm-shared-windows']) {
    mkdirSync(join(templates, share, 'pre-scripts'), { recursive: true });
    mkdirSync(join(templates, share, 'post-scripts'), { recursive: true });
  }
  writeFileSync(join(templates, 'vm-shared', 'pre-scripts', '01-apt.sh'), 'apt');
  writeFileSync(join(templates, 'vm-shared', 'pre-scripts', 'nn-network.sh'), 'net');
  writeFileSync(join(templates, 'vm-shared', 'pre-scripts', 'dnsmasq.conf'), 'conf');
  writeFileSync(join(templates, 'vm-shared', 'post-scripts', '01-auth.sh'), 'auth');
  writeFileSync(join(templates, 'vm-shared-windows', 'pre-scripts', '01-pkg.ps1'), 'pkg');
  writeFileSync(join(templates, 'vm-shared-windows', 'pre-scripts', 'nn-network.ps1'), 'net');
  writeFileSync(join(templates, 'vm-shared-windows', 'post-scripts', '01-auth.ps1'), 'auth');
  mkdirSync(join(work, '.susentorno', 'pre-scripts'), { recursive: true });
  mkdirSync(join(work, '.susentorno', 'post-scripts'), { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('VM share weaving', () => {
  describe('built-ins', () => {
    it('renumbers built-ins with the sentinel last and copies passthrough', () => {
      const paths = envPaths(work);
      weaveShares({ templatesDir: templates, paths });
      expect(readdirSync(paths.vmSharedTargets[0].preScripts).sort()).toEqual([
        '01-apt.sh',
        '02-network.sh',
        'dnsmasq.conf',
      ]);
    });

    it('replaces phase folders, dropping deleted custom files', () => {
      const paths = envPaths(work);
      const custom = join(paths.preScripts, '01-docker.sh');
      writeFileSync(custom, 'docker');
      weaveShares({ templatesDir: templates, paths });
      rmSync(custom);
      weaveShares({ templatesDir: templates, paths });
      expect(existsSync(join(paths.vmSharedTargets[0].preScripts, '02-docker.sh'))).toBe(false);
    });
  });

  describe('customization inputs into both shares', () => {
    it('weaves a custom pre-script before the network sentinel', () => {
      const paths = envPaths(work);
      writeFileSync(join(paths.preScripts, '01-docker.sh'), 'docker');
      weaveShares({ templatesDir: templates, paths });
      expect(readdirSync(paths.vmSharedTargets[0].preScripts).sort()).toEqual([
        '01-apt.sh',
        '02-docker.sh',
        '03-network.sh',
        'dnsmasq.conf',
      ]);
    });

    it('copies custom passthrough into both shares', () => {
      const paths = envPaths(work);
      mkdirSync(join(paths.preScripts, 'lib'));
      writeFileSync(join(paths.preScripts, 'lib', 'helper.sh'), 'h');
      weaveShares({ templatesDir: templates, paths });
      for (const target of paths.vmSharedTargets) {
        expect(existsSync(join(target.preScripts, 'lib', 'helper.sh'))).toBe(true);
      }
    });
  });

  describe('invalid customization inputs', () => {
    it('aborts without mutating shares and aggregates bad names', () => {
      const paths = envPaths(work);
      writeFileSync(join(paths.preScripts, 'bad-pre.sh'), 'x');
      writeFileSync(join(paths.postScripts, 'bad-post.sh'), 'x');
      expect(() => planAllPhases({ templatesDir: templates, paths })).toThrow(
        /bad-pre[\s\S]*bad-post/,
      );
      expect(existsSync(paths.vmSharedTargets[0].preScripts)).toBe(false);
    });

    it('fails loud on a resource-vs-generated-script collision', () => {
      const paths = envPaths(work);
      mkdirSync(join(paths.preScripts, '02-network.sh'));
      let message = '';
      try {
        planAllPhases({ templatesDir: templates, paths });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/02-network\.sh[\s\S]*built-in script[\s\S]*custom resource/);
    });
  });

  describe('generated post-scripts', () => {
    it('folds a generated post-script into the post-scripts plan as a built-in, after the on-disk built-ins', () => {
      const paths = envPaths(work);
      const genDir = mkdtempSync(join(tmpdir(), 'gen-post-script-'));
      const genPath = join(genDir, 'mcp-servers.sh');
      writeFileSync(genPath, '#!/bin/bash\necho mcp\n');

      try {
        const plans = planAllPhases({
          templatesDir: templates,
          paths,
          generatedPostScripts: [{ ext: 'sh', remainder: 'mcp-servers.sh', sourcePath: genPath }],
        });

        const shPostScripts = findPlan(plans, 'vm-shared/post-scripts');
        const names = shPostScripts!.actions.map((a) => a.destRel);
        expect(names).toContain('02-mcp-servers.sh'); // after the one on-disk built-in (01-auth.sh)

        const ps1PostScripts = findPlan(plans, 'vm-shared-windows/post-scripts');
        expect(ps1PostScripts!.actions.map((a) => a.destRel)).not.toContain('02-mcp-servers.sh');
      } finally {
        rmSync(genDir, { recursive: true, force: true });
      }
    });
  });
});

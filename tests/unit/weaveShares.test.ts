import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envPaths } from '../../src/envPaths';
import { planAllPhases, weaveShares } from '../../src/weaveShares';

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
  mkdirSync(join(work, '.configamatron', 'pre-scripts'), { recursive: true });
  mkdirSync(join(work, '.configamatron', 'post-scripts'), { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('weaveShares', () => {
  it('renumbers built-ins with the sentinel last and copies passthrough', () => {
    const paths = envPaths(work);
    weaveShares({ templatesDir: templates, paths });
    expect(readdirSync(paths.vmSharedTargets[0].preScripts).sort()).toEqual([
      '01-apt.sh',
      '02-network.sh',
      'dnsmasq.conf',
    ]);
  });

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

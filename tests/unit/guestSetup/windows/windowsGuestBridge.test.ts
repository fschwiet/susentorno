import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { envPaths } from '../../../../src/envPaths';
import { packageRoot, templatesDir, windowsGuestBridgePath } from '../../../../src/templates';
import { planAllPhases } from '../../../../src/weaveShares';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('the shipped PowerShell Direct bridge template', () => {
  const bridge = readFileSync(windowsGuestBridgePath(), 'utf8');

  it('is resolved from the package root and exists', () => {
    expect(existsSync(windowsGuestBridgePath())).toBe(true);
    expect(relative(packageRoot(), windowsGuestBridgePath()).replace(/\\/g, '/')).toBe(
      'templates/powershell/windowsGuestBridge.ps1',
    );
  });

  it('sits outside every VM-share template directory', () => {
    const shareDirs = readdirSync(templatesDir()).filter((name) => name.startsWith('vm-shared-'));
    expect(shareDirs.length).toBeGreaterThan(0);
    for (const share of shareDirs) {
      const files = walk(join(templatesDir(), share)).map((file) => file.toLowerCase());
      expect(files.some((file) => file.includes('windowsguestbridge'))).toBe(false);
    }
  });

  it('is never planned into a guest share by update-shares', () => {
    const paths = envPaths(join(packageRoot(), 'test-results', 'bridge-not-woven'));
    const plans = planAllPhases({ templatesDir: templatesDir(), paths });
    const planned = plans.flatMap((plan) => plan.actions.map((a) => `${a.src} ${a.destRel}`));
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.some((entry) => entry.toLowerCase().includes('windowsguestbridge'))).toBe(false);
  });

  it('takes only the VM name as a parameter, so no secret can arrive in argv', () => {
    const params = bridge.match(/^param\(([\s\S]*?)^\)/m)?.[1] ?? '';
    expect(params.match(/\[\w+\]\s*\$\w+/g)).toEqual(['[string] $VMName']);
  });

  it('reads its request from stdin', () => {
    expect(bridge).toContain('[Console]::In.ReadToEnd()');
  });

  it('repairs the PowerShell 5.1 module path before the first ConvertTo-SecureString', () => {
    const repair = bridge.indexOf('$env:PSModulePath =');
    const secure = bridge.indexOf('= ConvertTo-SecureString');
    expect(repair).toBeGreaterThan(-1);
    expect(repair).toBeLessThan(secure);
    expect(bridge).toContain('System32\\WindowsPowerShell\\v1.0\\Modules');
  });

  it('runs the guest child with the fixed flags and suppresses progress records', () => {
    expect(bridge).toContain('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand');
    expect(bridge).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(bridge).toContain('Invoke-Command -VMName');
    expect(bridge).not.toContain('-ComputerName');
  });
});

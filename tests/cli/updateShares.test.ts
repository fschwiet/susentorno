import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;

async function initEnv(dir: string) {
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: dir },
  );
}

describe.skipIf(!hasJq)('configamatron update-shares', () => {
  it('previews transforms and refreshes both share copies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      // Delete a share copy to prove update-shares restores it.
      const winCopy = join(
        dir,
        '.configamatron',
        'vm-shared-windows',
        'home-jq-transforms',
        'manifest.yaml',
      );
      rmSync(join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms'), {
        recursive: true,
        force: true,
      });
      const { exitCode, stdout } = await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('vscode-settings.jq');
      expect(stdout).toContain('hasCompletedOnboarding'); // {} preview output
      expect(existsSync(winCopy)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run previews without copying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      rmSync(join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms'), {
        recursive: true,
        force: true,
      });
      const { exitCode } = await execa('node', [cliPath, 'update-shares', '--dry-run'], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(
        existsSync(join(dir, '.configamatron', 'vm-shared-windows', 'home-jq-transforms')),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks the copy when a transform fails its {} preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      const src = join(dir, '.configamatron', 'home-jq-transforms', 'vscode-settings.jq');
      writeFileSync(src, '.["x"] = (1 / 0 broken'); // invalid jq
      rmSync(join(dir, '.configamatron', 'vm-shared', 'home-jq-transforms'), {
        recursive: true,
        force: true,
      });
      const { exitCode, stderr } = await execa('node', [cliPath, 'update-shares'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not copying');
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'home-jq-transforms'))).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reweaves pre/post scripts, adding a custom step and dropping deleted ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      const preSrc = join(dir, '.configamatron', 'pre-scripts');
      writeFileSync(join(preSrc, '01-docker.sh'), 'echo docker\n');
      await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      const wovenPre = join(dir, '.configamatron', 'vm-shared', 'pre-scripts');
      expect(existsSync(join(wovenPre, '05-docker.sh'))).toBe(true);
      expect(existsSync(join(wovenPre, '06-configure-network.sh'))).toBe(true);
      rmSync(join(preSrc, '01-docker.sh'));
      await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      expect(existsSync(join(wovenPre, '05-docker.sh'))).toBe(false);
      expect(existsSync(join(wovenPre, '05-configure-network.sh'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts the whole run on an invalid custom script name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      writeFileSync(join(dir, '.configamatron', 'post-scripts', 'bad.sh'), 'oops\n');
      const existing = join(
        dir,
        '.configamatron',
        'vm-shared',
        'post-scripts',
        '02-apply-home-jq-transforms.sh',
      );
      const { exitCode, stderr } = await execa('node', [cliPath, 'update-shares'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('bad.sh');
      expect(existsSync(existing)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates a re-runnable MCP registration post-script when mcp-servers.yaml declares servers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      writeFileSync(
        join(dir, '.configamatron', 'mcp-servers.yaml'),
        ['servers:', '  - name: filesystem', '    hostname: filesystem.internal', '    command: run-fs', ''].join(
          '\n',
        ),
      );

      await execa('node', [cliPath, 'update-shares'], { cwd: dir });

      const shDir = join(dir, '.configamatron', 'vm-shared', 'post-scripts');
      const generatedName = readdirSync(shDir).find((f) => f.includes('mcp-servers'));
      expect(generatedName).toBeDefined();
      const content = readFileSync(join(shDir, generatedName!), 'utf8');
      expect(content).toContain(
        'claude mcp add --scope user --transport http filesystem https://filesystem.internal',
      );

      const ps1Dir = join(dir, '.configamatron', 'vm-shared-windows', 'post-scripts');
      const generatedPs1Name = readdirSync(ps1Dir).find((f) => f.includes('mcp-servers'));
      expect(generatedPs1Name).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits no MCP post-script when mcp-servers.yaml is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-shares-'));
    try {
      await initEnv(dir);
      await execa('node', [cliPath, 'update-shares'], { cwd: dir });
      const shDir = join(dir, '.configamatron', 'vm-shared', 'post-scripts');
      expect(readdirSync(shDir).some((f) => f.includes('mcp-servers'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

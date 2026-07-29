import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import { join, delimiter, dirname } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const mcpFakeCliDir = fileURLToPath(new URL('../fixtures/mcpFakeCli', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;

// The MCP registration step it tests can shell out to real `claude`/`codex`
// CLIs when they exist on the developer's own PATH -- which would mutate the
// developer's real agent configuration. To make that impossible, these tests
// run the generated step against a PATH built only from a fixed, minimal set
// of directories needed to run bash/PowerShell (never the ambient PATH), plus
// a directory holding only the fake CLIs the test opts in.
function resolveGitBashDir(): string {
  try {
    const out = execSync('where bash', { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? dirname(first.trim()) : '';
  } catch {
    return '';
  }
}
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
// Git bash must be searched before System32 -- Windows ships its own WSL
// `bash.exe` launcher there, which would otherwise shadow the real git-bash
// and misinterpret the POSIX script path.
const SAFE_PATH_DIRS = [
  resolveGitBashDir(),
  join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  join(systemRoot, 'System32'),
  systemRoot,
].filter(Boolean);

function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
}

async function initEnv(dir: string) {
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: dir },
  );
}

let fakeCliPathDirCounter = 0;

/** Builds a fresh PATH dir containing only the requested fake agent CLIs (bash +
 *  .cmd forms). Each call gets its own directory so an earlier call's binaries
 *  (e.g. a `codex` fake from a "both present" scenario) can never leak into a
 *  later call that means to test one CLI being absent. */
function makeFakeCliPathDir(root: string, agents: ('claude' | 'codex')[]): string {
  const dir = join(root, `fake-path-${fakeCliPathDirCounter++}`);
  mkdirSync(dir, { recursive: true });
  for (const agent of agents) {
    cpSync(join(mcpFakeCliDir, agent), join(dir, agent));
    cpSync(join(mcpFakeCliDir, `${agent}.cmd`), join(dir, `${agent}.cmd`));
  }
  return dir;
}

interface RunStepResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string[];
}

async function runShStep(
  scriptPath: string,
  fakePathDir: string,
  env: Record<string, string>,
  logPath: string,
): Promise<RunStepResult> {
  writeFileSync(logPath, '');
  const result = await execa('bash', [toPosixPath(scriptPath)], {
    reject: false,
    env: {
      ...process.env,
      ...env,
      PATH: [fakePathDir, ...SAFE_PATH_DIRS].join(delimiter),
      MCP_FAKE_LOG: logPath,
    },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    log: readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

async function runPs1Step(
  scriptPath: string,
  fakePathDir: string,
  env: Record<string, string>,
  logPath: string,
): Promise<RunStepResult> {
  writeFileSync(logPath, '');
  const result = await execa('powershell', ['-NoProfile', '-File', scriptPath], {
    reject: false,
    env: {
      ...process.env,
      ...env,
      PATH: [fakePathDir, ...SAFE_PATH_DIRS].join(delimiter),
      MCP_FAKE_LOG: logPath,
    },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    log: readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  };
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

  describe('MCP server registration step', () => {
    function mcpServersYaml(name: string, url: string): string {
      return `- name: ${name}\n  url: ${url}\n  command: "my-server --bind {ip} --port {port}"\n`;
    }

    it('generates the step in both .sh and .ps1 once a server is declared', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'update-shares-mcp-'));
      try {
        await initEnv(dir);
        writeFileSync(
          join(dir, '.configamatron', 'mcp-servers.yaml'),
          mcpServersYaml('filesystem', 'https://filesystem.mcp.internal/mcp'),
        );
        await execa('node', [cliPath, 'update-shares'], { cwd: dir });
        const shStep = join(
          dir,
          '.configamatron',
          'vm-shared',
          'post-scripts',
          '03-register-mcp-servers.sh',
        );
        const ps1Step = join(
          dir,
          '.configamatron',
          'vm-shared-windows',
          'post-scripts',
          '03-register-mcp-servers.ps1',
        );
        expect(existsSync(shStep)).toBe(true);
        expect(existsSync(ps1Step)).toBe(true);
        expect(readFileSync(shStep, 'utf8')).toContain(
          "claude mcp add --transport http 'filesystem' 'https://filesystem.mcp.internal/mcp'",
        );
        expect(readFileSync(ps1Step, 'utf8')).toContain(
          "claude mcp add --transport http 'filesystem' 'https://filesystem.mcp.internal/mcp'",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['sh', 'vm-shared', '03-register-mcp-servers.sh', runShStep],
      ['ps1', 'vm-shared-windows', '03-register-mcp-servers.ps1', runPs1Step],
    ] as const)(
      '(%s) registers with both agents, re-registers on a changed url, skips an absent CLI, and fails only on a present CLI add error',
      async (_label, shareDir, stepName, runStep) => {
        const dir = mkdtempSync(join(tmpdir(), 'update-shares-mcp-'));
        try {
          await initEnv(dir);
          writeFileSync(
            join(dir, '.configamatron', 'mcp-servers.yaml'),
            mcpServersYaml('filesystem', 'https://filesystem.mcp.internal/mcp'),
          );
          await execa('node', [cliPath, 'update-shares'], { cwd: dir });
          const stepPath = join(dir, '.configamatron', shareDir, 'post-scripts', stepName);
          const logPath = join(dir, 'mcp-fake.log');

          // Both CLIs present, add succeeds, and remove reports "not found" (the
          // default, best-effort-ignored first-run case) -> converges, exit 0.
          const bothPresent = makeFakeCliPathDir(dir, ['claude', 'codex']);
          const first = await runStep(
            stepPath,
            bothPresent,
            { MCP_FAKE_REMOVE_EXIT: '1', MCP_FAKE_ADD_EXIT: '0' },
            logPath,
          );
          expect(first.exitCode).toBe(0);
          expect(first.log).toEqual([
            'claude mcp remove filesystem',
            'claude mcp add --transport http filesystem https://filesystem.mcp.internal/mcp',
            'codex mcp remove filesystem',
            'codex mcp add filesystem --url https://filesystem.mcp.internal/mcp',
          ]);

          // Rerunnability: change the url in mcp-servers.yaml, reweave, and rerun —
          // the new registration call carries the new url (replacing the old one).
          writeFileSync(
            join(dir, '.configamatron', 'mcp-servers.yaml'),
            mcpServersYaml('filesystem', 'https://filesystem-v2.mcp.internal/mcp'),
          );
          await execa('node', [cliPath, 'update-shares'], { cwd: dir });
          const second = await runStep(
            stepPath,
            bothPresent,
            { MCP_FAKE_REMOVE_EXIT: '0', MCP_FAKE_ADD_EXIT: '0' },
            logPath,
          );
          expect(second.exitCode).toBe(0);
          expect(second.log).toEqual([
            'claude mcp remove filesystem',
            'claude mcp add --transport http filesystem https://filesystem-v2.mcp.internal/mcp',
            'codex mcp remove filesystem',
            'codex mcp add filesystem --url https://filesystem-v2.mcp.internal/mcp',
          ]);

          // Absent CLI: only claude present -> skip message for codex, still exit 0.
          const claudeOnly = makeFakeCliPathDir(dir, ['claude']);
          const skipRun = await runStep(
            stepPath,
            claudeOnly,
            { MCP_FAKE_REMOVE_EXIT: '1', MCP_FAKE_ADD_EXIT: '0' },
            logPath,
          );
          expect(skipRun.exitCode).toBe(0);
          expect(skipRun.stdout + skipRun.stderr).toContain(
            'codex CLI not found on PATH; skipping codex registration',
          );
          expect(skipRun.log.some((l) => l.startsWith('codex'))).toBe(false);

          // Add-failure policy: a present CLI's add returns an error -> the step
          // fails non-zero (removal failure is never the cause: remove also fails
          // here and that alone must not fail the step, as proven by the first run).
          const failRun = await runStep(
            stepPath,
            bothPresent,
            { MCP_FAKE_REMOVE_EXIT: '1', MCP_FAKE_ADD_EXIT: '1' },
            logPath,
          );
          expect(failRun.exitCode).not.toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
});

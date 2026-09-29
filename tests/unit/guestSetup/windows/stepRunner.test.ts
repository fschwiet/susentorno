import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuestScript } from '../../../../src/guestSetup/listScripts';
import {
  WindowsGuestError,
  type WindowsGuestExecutor,
  type WindowsGuestResult,
} from '../../../../src/guestSetup/windows/guestExecutor';
import {
  boundStepOutput,
  buildStepWrapper,
  runWindowsSteps,
  WindowsStepError,
  WINDOWS_STEP_TIMEOUT_MS,
} from '../../../../src/guestSetup/windows/stepRunner';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const step = (filename: string): GuestScript => ({
  path: `C:\\host\\${filename}`,
  filename,
  slug: /^\d{2}-(.+)\.ps1$/i.exec(filename)![1],
});
const ok = (stdout = '', stderr = ''): WindowsGuestResult => ({
  exitCode: 0,
  stdout,
  stderr,
  timedOut: false,
});

describe('buildStepWrapper', () => {
  const wrapper = buildStepWrapper({
    directory: '\\\\172.29.240.1\\vm-shared-windows\\pre-scripts',
    filename: "01-it's.ps1",
  });

  it('fixes the error preference, sets the working directory literally, and uses the call operator', () => {
    expect(wrapper).toContain("$ErrorActionPreference = 'Stop'");
    expect(wrapper).toContain('Set-Location -LiteralPath $phaseDirectory');
    expect(wrapper).toContain('& $stepPath');
  });

  it('carries the phase directory and the step path only as base64 data, never as source text', () => {
    expect(wrapper).not.toContain('172.29.240.1');
    expect(wrapper).not.toContain('vm-shared-windows');
    expect(wrapper).not.toContain("it's");
    expect(wrapper).toContain(b64('\\\\172.29.240.1\\vm-shared-windows\\pre-scripts'));
    expect(wrapper).toContain(b64("\\\\172.29.240.1\\vm-shared-windows\\pre-scripts\\01-it's.ps1"));
  });

  it('passes no runner argument by default', () => {
    expect(wrapper).not.toContain('-HostIp');
  });

  it('passes -HostIp, as data, only when asked to', () => {
    const withIp = buildStepWrapper({
      directory: '\\\\h\\s\\pre-scripts',
      filename: '01-configure-network.ps1',
      hostIp: '192.168.67.1',
    });
    expect(withIp).toContain('& $stepPath -HostIp $hostIp');
    expect(withIp).not.toContain('192.168.67.1');
    expect(withIp).toContain(b64('192.168.67.1'));
  });

  it('never decides success or failure from a bare $LASTEXITCODE', () => {
    // A step that accepted a native failure and then finished cleanly has $? true.
    expect(wrapper).toMatch(/if \(\$\?\) \{ exit 0 \}/);
  });
});

// The wrapper's exit semantics are Windows PowerShell 5.1 behavior; prove them for real.
describe.skipIf(process.platform !== 'win32')('buildStepWrapper on Windows PowerShell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'susentorno-wrapper-'));
  let counter = 0;
  const run = (body: string, filename = `01-case-${++counter}.ps1`, hostIp?: string) => {
    writeFileSync(join(dir, filename), body);
    const wrapper = buildStepWrapper({ directory: dir, filename, hostIp });
    const loader =
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
      `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(wrapper)}'))))`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', loader],
      { encoding: 'utf8' },
    );
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it.each([
    ['a clean step', 'Write-Output hi', 0],
    ['an explicit exit N', 'exit 5', 5],
    ['an explicit exit 0', 'exit 0', 0],
    ['an uncaught terminating error', 'throw "boom"', 1],
    [
      'an accepted native failure then a clean finish (a stale $LASTEXITCODE)',
      'cmd /c exit 3; Write-Output done',
      0,
    ],
    ['an explicit exit after a native failure', 'cmd /c exit 3; exit 9', 9],
  ] as const)('%s', (_name, body, expected) => {
    expect(run(body).code).toBe(expected);
  });

  it('reports an uncaught error on stderr', () => {
    expect(run('throw "boom-message"').stderr).toContain('boom-message');
  });

  it('runs the step from the phase directory and hands configure-network its -HostIp', () => {
    const result = run(
      'param([string]$HostIp) (Get-Location).Path; "ip=$HostIp"',
      '02-configure-network.ps1',
      '192.168.67.1',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(dir);
    expect(result.stdout).toContain('ip=192.168.67.1');
  });

  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('boundStepOutput', () => {
  it('leaves output at or under the ceiling untouched', () => {
    expect(boundStepOutput('hello', 5)).toEqual({
      text: 'hello',
      truncated: false,
      totalBytes: 5,
      omittedBytes: 0,
    });
  });

  it('keeps the head and the tail with a truncation marker and reports what was dropped', () => {
    const text = `${'H'.repeat(100)}${'m'.repeat(1000)}${'T'.repeat(100)}`;
    const bounded = boundStepOutput(text, 200);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totalBytes).toBe(1200);
    expect(bounded.omittedBytes).toBe(1000);
    expect(bounded.text.startsWith('H'.repeat(100))).toBe(true);
    expect(bounded.text.endsWith('T'.repeat(100))).toBe(true);
    expect(bounded.text).toContain('[... 1000 bytes truncated ...]');
  });

  it('never splits a multi-byte character at a cut', () => {
    const bounded = boundStepOutput('\u00e9'.repeat(1000), 101);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).not.toContain('\uFFFD');
  });
});

interface Recorded {
  script: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

function fakeExecutor(answer: (script: string, call: number) => WindowsGuestResult | Error) {
  const calls: Recorded[] = [];
  const executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'> = {
    vmName: 'win-dev',
    async invoke(script, options) {
      calls.push({ script, timeoutMs: options.timeoutMs, signal: options.signal });
      const result = answer(script, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { executor, calls };
}

const base = {
  directory: 'pre-scripts' as const,
  shareHostIp: '172.29.240.1',
  shareName: 'vm-shared-windows',
  internalSwitchHostIp: '192.168.67.1',
  phaseLabel: 'G6',
};

async function failureOf(work: Promise<unknown>): Promise<WindowsStepError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WindowsStepError) return error;
    throw error;
  }
  throw new Error('expected a step failure');
}

describe('runWindowsSteps', () => {
  const scripts = [step('01-a.ps1'), step('02-configure-network.ps1'), step('03-c.ps1')];

  it('runs every step once, in order, each with the 30 minute deadline, and reports success', async () => {
    const { executor, calls } = fakeExecutor(() => ok());
    await runWindowsSteps({ ...base, executor, scripts, out: () => {} });
    expect(calls).toHaveLength(3);
    expect(WINDOWS_STEP_TIMEOUT_MS).toBe(30 * 60_000);
    expect(calls.map((c) => c.timeoutMs)).toEqual([1_800_000, 1_800_000, 1_800_000]);
    const unc = '\\\\172.29.240.1\\vm-shared-windows\\pre-scripts';
    expect(calls[0].script).toContain(b64(`${unc}\\01-a.ps1`));
    expect(calls[1].script).toContain(b64(`${unc}\\02-configure-network.ps1`));
    expect(calls[2].script).toContain(b64(`${unc}\\03-c.ps1`));
  });

  it('gives -HostIp to configure-network alone', async () => {
    const { executor, calls } = fakeExecutor(() => ok());
    await runWindowsSteps({ ...base, executor, scripts, out: () => {} });
    expect(calls.map((c) => c.script.includes('-HostIp'))).toEqual([false, true, false]);
    expect(calls[1].script).toContain(b64('192.168.67.1'));
  });

  it('announces the phase and filename before each step, then emits its captured streams with that context', async () => {
    const out: string[] = [];
    const { executor } = fakeExecutor((_s, call) =>
      call === 1 ? ok('line one\nline two\n', 'warn\n') : ok(),
    );
    await runWindowsSteps({
      ...base,
      executor,
      scripts: scripts.slice(0, 2),
      out: (l) => out.push(l),
    });
    expect(out[0]).toBe('setup-guest-windows: G6 running step pre-scripts/01-a.ps1 (1 of 2)');
    expect(out).toContain('setup-guest-windows: G6 pre-scripts/01-a.ps1 stdout:');
    expect(out).toContain('  line one');
    expect(out).toContain('  line two');
    expect(out).toContain('setup-guest-windows: G6 pre-scripts/01-a.ps1 stderr:');
    expect(out).toContain('  warn');
    expect(out.indexOf('  line two')).toBeLessThan(
      out.indexOf(
        'setup-guest-windows: G6 running step pre-scripts/02-configure-network.ps1 (2 of 2)',
      ),
    );
    // Nothing is announced for an empty stream.
    expect(out.filter((l) => l.endsWith('02-configure-network.ps1 stdout:'))).toEqual([]);
  });

  it('classifies a nonzero exit, naming the filename and code and keeping the captured output', async () => {
    const { executor } = fakeExecutor((_s, call) =>
      call === 2 ? { exitCode: 5, stdout: 'so', stderr: 'it broke', timedOut: false } : ok(),
    );
    const out: string[] = [];
    const error = await failureOf(
      runWindowsSteps({ ...base, executor, scripts, out: (l) => out.push(l) }),
    );
    expect(error.kind).toBe('exit');
    expect(error.filename).toBe('02-configure-network.ps1');
    expect(error.exitCode).toBe(5);
    expect(error.message).toContain('02-configure-network.ps1');
    expect(error.message).toContain('code 5');
    expect(error.message).toContain('it broke');
    expect(out).toContain('  it broke');
  });

  it('classifies a guest-side deadline as a timeout, not an exit', async () => {
    const { executor } = fakeExecutor(() => ({
      exitCode: 124,
      stdout: '',
      stderr: '',
      timedOut: true,
    }));
    const error = await failureOf(runWindowsSteps({ ...base, executor, scripts, out: () => {} }));
    expect(error.kind).toBe('timeout');
    expect(error.filename).toBe('01-a.ps1');
    expect(error.message).toContain('30 minutes');
  });

  it('classifies a wedged-bridge deadline as a timeout too', async () => {
    const { executor } = fakeExecutor(() => new WindowsGuestError('deadline', 'killed'));
    const error = await failureOf(runWindowsSteps({ ...base, executor, scripts, out: () => {} }));
    expect(error.kind).toBe('timeout');
  });

  it.each(['transport', 'authentication', 'protocol'] as const)(
    'classifies a %s failure as a transport failure that names the step',
    async (kind) => {
      const { executor } = fakeExecutor(() => new WindowsGuestError(kind, 'the reason'));
      const error = await failureOf(runWindowsSteps({ ...base, executor, scripts, out: () => {} }));
      expect(error.kind).toBe('transport');
      expect(error.filename).toBe('01-a.ps1');
      expect(error.message).toContain('the reason');
    },
  );

  it('classifies a cancelled invocation as a cancellation', async () => {
    const { executor } = fakeExecutor(() => new WindowsGuestError('cancelled', 'cancelled'));
    const error = await failureOf(runWindowsSteps({ ...base, executor, scripts, out: () => {} }));
    expect(error.kind).toBe('cancelled');
    expect(error.filename).toBe('01-a.ps1');
  });

  it('does not start a step once the signal is aborted', async () => {
    const controller = new AbortController();
    const { executor, calls } = fakeExecutor((_s, call) => {
      if (call === 1) controller.abort();
      return ok();
    });
    const error = await failureOf(
      runWindowsSteps({ ...base, executor, scripts, out: () => {}, signal: controller.signal }),
    );
    expect(error.kind).toBe('cancelled');
    expect(error.filename).toBe('02-configure-network.ps1');
    expect(calls).toHaveLength(1);
  });

  it('fails fast: no step after a failure is started and none is retried', async () => {
    const { executor, calls } = fakeExecutor((_s, call) =>
      call === 1 ? { exitCode: 1, stdout: '', stderr: '', timedOut: false } : ok(),
    );
    await failureOf(runWindowsSteps({ ...base, executor, scripts, out: () => {} }));
    expect(calls).toHaveLength(1);
  });

  it('reports each step as it starts, so an interrupt can name it', async () => {
    const started: string[] = [];
    const { executor } = fakeExecutor(() => ok());
    await runWindowsSteps({
      ...base,
      executor,
      scripts,
      out: () => {},
      onStep: (filename) => started.push(filename),
    });
    expect(started).toEqual(['01-a.ps1', '02-configure-network.ps1', '03-c.ps1']);
  });

  it('bounds each stream at the ceiling, keeping head and tail, and says so', async () => {
    const big = `${'H'.repeat(50)}${'x'.repeat(500)}${'T'.repeat(50)}`;
    const { executor } = fakeExecutor(() => ok(big, big));
    const out: string[] = [];
    await runWindowsSteps({
      ...base,
      executor,
      scripts: [step('01-a.ps1')],
      out: (l) => out.push(l),
      outputCeilingBytes: 100,
    });
    const text = out.join('\n');
    expect(text).toContain('H'.repeat(50));
    expect(text).toContain('T'.repeat(50));
    expect(text).not.toContain('x'.repeat(100));
    expect(text).toContain('[... 500 bytes truncated ...]');
    expect(text).toContain('stdout (truncated: kept 100 of 600 bytes):');
    expect(text).toContain('stderr (truncated: kept 100 of 600 bytes):');
  });
});

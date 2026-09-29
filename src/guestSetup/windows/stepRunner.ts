import type { GuestScript } from '../listScripts';
import { WindowsGuestError, type WindowsGuestExecutor } from './guestExecutor';
import { CONFIGURE_NETWORK_SLUG } from './stepPlan';

/** Each step gets 30 minutes: slow installs have room, a hung step still ends. */
export const WINDOWS_STEP_TIMEOUT_MS = 30 * 60_000;
/** Each captured stream is kept in memory up to this many bytes, head and tail. */
export const STEP_OUTPUT_CEILING_BYTES = 8 * 1024 * 1024;

const EXCERPT_CHARS = 2000;

export type WindowsStepDirectory = 'pre-scripts' | 'post-scripts';

export type WindowsStepFailureKind = 'exit' | 'timeout' | 'cancelled' | 'transport';

/**
 * A step that did not succeed. The four kinds are distinct outcomes, and each
 * names the step's directory and filename.
 *
 * - `exit`: the step ran to a nonzero exit.
 * - `timeout`: the step hit its deadline and was stopped.
 * - `cancelled`: the caller aborted before or during the step.
 * - `transport`: the step never produced a result (PowerShell Direct or the
 *   bridge failed, including a rejected credential).
 */
export class WindowsStepError extends Error {
  readonly kind: WindowsStepFailureKind;
  readonly directory: WindowsStepDirectory;
  readonly filename: string;
  readonly exitCode?: number;

  constructor(
    kind: WindowsStepFailureKind,
    directory: WindowsStepDirectory,
    filename: string,
    message: string,
    exitCode?: number,
  ) {
    super(message);
    this.name = 'WindowsStepError';
    this.kind = kind;
    this.directory = directory;
    this.filename = filename;
    this.exitCode = exitCode;
  }
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export interface StepWrapperOptions {
  /** The phase's UNC directory, e.g. `\\<ip>\<share>\pre-scripts`. */
  directory: string;
  filename: string;
  /** Set for `configure-network` alone. */
  hostIp?: string;
}

/**
 * The fixed wrapper one step runs under. Everything that varies (the phase
 * directory, the step path, the host IP) reaches it as base64 data, decoded
 * into variables, so no path is ever interpolated into executable source.
 *
 * `$?` is what tells an explicit `exit N` (false, with the code in
 * `$LASTEXITCODE`) from a step that accepted a native failure and finished
 * cleanly (true, with a stale `$LASTEXITCODE`): the latter is success.
 */
export function buildStepWrapper(options: StepWrapperOptions): string {
  const stepPath = `${options.directory}\\${options.filename}`;
  const decode = (variable: string, value: string): string =>
    `  $${variable} = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(value)}'))`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    decode('phaseDirectory', options.directory),
    decode('stepPath', stepPath),
  ];
  if (options.hostIp !== undefined) lines.push(decode('hostIp', options.hostIp));
  lines.push(
    '  Set-Location -LiteralPath $phaseDirectory',
    '  $global:LASTEXITCODE = $null',
    options.hostIp === undefined ? '  & $stepPath' : '  & $stepPath -HostIp $hostIp',
    '  if ($?) { exit 0 }',
    '  $code = $LASTEXITCODE',
    '  if ($code -is [int] -and $code -ne 0) { exit $code }',
    '  exit 1',
    '} catch {',
    '  [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())',
    '  exit 1',
    '}',
  );
  return lines.join('\n');
}

export interface BoundedStepOutput {
  text: string;
  truncated: boolean;
  totalBytes: number;
  omittedBytes: number;
}

/**
 * Keeps at most `ceilingBytes` of UTF-8 (half from the head, half from the
 * tail) with a marker between them. Cuts never split a character.
 */
export function boundStepOutput(text: string, ceilingBytes: number): BoundedStepOutput {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= ceilingBytes) {
    return { text, truncated: false, totalBytes: bytes.length, omittedBytes: 0 };
  }
  const half = Math.floor(ceilingBytes / 2);
  let headEnd = half;
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
  let tailStart = bytes.length - half;
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
  const omittedBytes = tailStart - headEnd;
  return {
    text:
      `${bytes.subarray(0, headEnd).toString('utf8')}\n[... ${omittedBytes} bytes truncated ...]\n` +
      bytes.subarray(tailStart).toString('utf8'),
    truncated: true,
    totalBytes: bytes.length,
    omittedBytes,
  };
}

export interface RunWindowsStepsOptions {
  executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'>;
  scripts: GuestScript[];
  directory: WindowsStepDirectory;
  /** The host address the guest reaches the VM share at during this phase. */
  shareHostIp: string;
  shareName: string;
  /** Handed to `configure-network` as `-HostIp`, in either phase. */
  internalSwitchHostIp: string;
  /** The flow phase these steps run in, for announcements (for example 'G6'). */
  phaseLabel: string;
  out: (line: string) => void;
  signal?: AbortSignal;
  /** Called as each step starts. */
  onStep?: (filename: string) => void;
  outputCeilingBytes?: number;
}

function excerpt(stderr: string, stdout: string): string {
  const text = (stderr.trim() || stdout.trim()).slice(-EXCERPT_CHARS);
  return text ? ` Last output: ${text}` : '';
}

/**
 * The Windows step runner: one executor invocation per step, in order, each
 * under a fixed wrapper and a 30 minute deadline. Exit `0` is the only
 * success. It stops at the first step that does not succeed and never retries.
 * Deliberately separate from the Unix pre- and post-script runners; only the
 * discovered-step model is shared.
 */
export async function runWindowsSteps(options: RunWindowsStepsOptions): Promise<void> {
  const { executor, scripts, directory, out, phaseLabel } = options;
  const ceiling = options.outputCeilingBytes ?? STEP_OUTPUT_CEILING_BYTES;
  const uncDirectory = `\\\\${options.shareHostIp}\\${options.shareName}\\${directory}`;

  for (const [index, script] of scripts.entries()) {
    const { filename } = script;
    const where = `${directory}/${filename}`;
    const cancelled = (): WindowsStepError =>
      new WindowsStepError('cancelled', directory, filename, `Step ${where} was cancelled.`);
    if (options.signal?.aborted) throw cancelled();

    options.onStep?.(filename);
    out(
      `setup-guest-windows: ${phaseLabel} running step ${where} (${index + 1} of ${scripts.length})`,
    );

    const wrapper = buildStepWrapper({
      directory: uncDirectory,
      filename,
      hostIp: script.slug === CONFIGURE_NETWORK_SLUG ? options.internalSwitchHostIp : undefined,
    });

    let result;
    try {
      result = await executor.invoke(wrapper, {
        timeoutMs: WINDOWS_STEP_TIMEOUT_MS,
        signal: options.signal,
      });
    } catch (error) {
      if (!(error instanceof WindowsGuestError)) throw error;
      if (error.kind === 'cancelled') throw cancelled();
      if (error.kind === 'deadline') throw timedOut(directory, filename);
      throw new WindowsStepError(
        'transport',
        directory,
        filename,
        `Step ${where} could not be run on '${executor.vmName}' (${error.kind}): ${error.message}`,
      );
    }

    const streams = [
      ['stdout', boundStepOutput(result.stdout, ceiling)],
      ['stderr', boundStepOutput(result.stderr, ceiling)],
    ] as const;
    for (const [name, bounded] of streams) {
      if (bounded.totalBytes === 0) continue;
      const note = bounded.truncated
        ? ` (truncated: kept ${bounded.totalBytes - bounded.omittedBytes} of ${bounded.totalBytes} bytes)`
        : '';
      out(`setup-guest-windows: ${phaseLabel} ${where} ${name}${note}:`);
      for (const line of bounded.text.replace(/\r?\n$/, '').split(/\r?\n/)) out(`  ${line}`);
    }

    if (result.timedOut) throw timedOut(directory, filename);
    if (result.exitCode !== 0) {
      throw new WindowsStepError(
        'exit',
        directory,
        filename,
        `Step ${where} exited with code ${result.exitCode}.${excerpt(result.stderr, result.stdout)}`,
        result.exitCode,
      );
    }
  }
}

function timedOut(directory: WindowsStepDirectory, filename: string): WindowsStepError {
  return new WindowsStepError(
    'timeout',
    directory,
    filename,
    `Step ${directory}/${filename} did not finish within ${WINDOWS_STEP_TIMEOUT_MS / 60_000} minutes and was stopped.`,
  );
}

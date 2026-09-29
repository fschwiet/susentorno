import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { sleep as abortableSleep } from '../../runHosting/abortableSleep';
import { windowsGuestBridgePath } from '../../templates';
import { redactSecrets } from './redaction';

export interface WindowsGuestCredential {
  username: string;
  password: string;
}

export interface WindowsGuestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface WindowsGuestExecutor {
  readonly vmName: string;
  invoke(
    script: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WindowsGuestResult>;
  /**
   * Wait for every bridge still running, including those whose caller already
   * cancelled, so a guest script that was mid-flight at cancellation has
   * finished before anything else is sent to the guest. Bounded: a bridge that
   * outlasts `timeoutMs` is force-killed. The executor stays usable.
   */
  drainCancelled(timeoutMs: number): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The distinct ways an invocation can fail to produce a result. A completed
 * nonzero exit is a result, never one of these.
 *
 * - `transport`: PowerShell Direct could not reach the guest (VM not ready,
 *   integration services down). Retryable.
 * - `authentication`: the guest rejected the credential. Never retryable.
 * - `protocol`: the bridge itself misbehaved or could not start. Never retryable.
 * - `deadline`: the bridge did not finish even after the guest-side deadline
 *   plus a margin and was force-killed.
 * - `cancelled`: the caller aborted.
 * - `timeout`: a readiness wait ran out of time.
 */
export type WindowsGuestErrorKind =
  'transport' | 'authentication' | 'protocol' | 'deadline' | 'cancelled' | 'timeout';

export class WindowsGuestError extends Error {
  readonly kind: WindowsGuestErrorKind;

  constructor(kind: WindowsGuestErrorKind, message: string) {
    super(message);
    this.name = 'WindowsGuestError';
    this.kind = kind;
  }
}

/** The subset of a child process the executor relies on; `spawn` satisfies it. */
export interface BridgeProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnBridge = (command: string, args: string[]) => BridgeProcess;

export interface CreateWindowsGuestExecutorOptions {
  vmName: string;
  credential: WindowsGuestCredential;
  /** Defaults to the bridge shipped in the package. */
  bridgePath?: string;
  /** Test seam. Defaults to `child_process.spawn` with piped stdio. */
  spawnBridge?: SpawnBridge;
  /**
   * Extra host-side time beyond an invocation's deadline (bridge start-up,
   * connecting to the guest) before a wedged bridge is force-killed.
   */
  bridgeMarginMs?: number;
  /** How long dispose() waits for cancelled invocations' bridges before force-killing them. */
  disposeTimeoutMs?: number;
}

const DEFAULT_BRIDGE_MARGIN_MS = 30_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 30_000;

const MAX_MESSAGE_LENGTH = 2000;

const defaultSpawnBridge: SpawnBridge = (command, args) =>
  spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

/**
 * Non-ASCII characters become \uXXXX escapes so the request survives whatever
 * console input encoding the bridge's Windows PowerShell 5.1 host starts with.
 */
function serializeRequest(request: object): string {
  return JSON.stringify(request).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function redactor(secrets: string[]): (text: string) => string {
  return (text) => {
    const redacted = redactSecrets(text, secrets);
    return redacted.length > MAX_MESSAGE_LENGTH
      ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}... [truncated]`
      : redacted;
  };
}

function collect(stream: Readable): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer | string) =>
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk),
  );
  return () => Buffer.concat(chunks).toString('utf8');
}

function isResult(value: unknown): value is { kind: 'result' } & WindowsGuestResult {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.kind === 'result' &&
    typeof v.exitCode === 'number' &&
    Number.isInteger(v.exitCode) &&
    typeof v.stdout === 'string' &&
    typeof v.stderr === 'string' &&
    typeof v.timedOut === 'boolean'
  );
}

function isBridgeError(
  value: unknown,
): value is { kind: 'error'; category: string; message: string } {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.kind === 'error' &&
    typeof v.category === 'string' &&
    typeof v.message === 'string'
  );
}

/**
 * Credential-scoped PowerShell Direct executor. Every invocation starts a
 * short-lived bridge (templates/powershell/windowsGuestBridge.ps1): only the
 * bridge path and VM name go in argv, and the credential and base64 script
 * go over stdin as one JSON request. See the spec's "PowerShell Direct
 * boundary" and ticket 02.
 */
export function createWindowsGuestExecutor(
  options: CreateWindowsGuestExecutorOptions,
): WindowsGuestExecutor {
  const { vmName } = options;
  const bridgePath = options.bridgePath ?? windowsGuestBridgePath();
  const spawnBridge = options.spawnBridge ?? defaultSpawnBridge;
  const credential: WindowsGuestCredential = { ...options.credential };
  const bridgeMarginMs = options.bridgeMarginMs ?? DEFAULT_BRIDGE_MARGIN_MS;
  const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
  let disposed = false;
  /** Bridges still running, including those whose caller already cancelled. */
  const outstanding = new Map<BridgeProcess, Promise<unknown>>();

  async function invoke(
    script: string,
    invokeOptions: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WindowsGuestResult> {
    if (disposed) throw new Error('WindowsGuestExecutor is disposed');
    const scriptBase64 = Buffer.from(script, 'utf8').toString('base64');
    const redact = redactor([credential.password, credential.username, scriptBase64, script]);
    const fail = (kind: WindowsGuestErrorKind, message: string): WindowsGuestError =>
      new WindowsGuestError(kind, redact(message));

    if (invokeOptions.signal?.aborted) throw fail('cancelled', 'The invocation was cancelled.');

    let bridge: BridgeProcess;
    try {
      bridge = spawnBridge('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        bridgePath,
        '-VMName',
        vmName,
      ]);
    } catch (error) {
      throw fail(
        'protocol',
        `Could not start the PowerShell Direct bridge: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const stdout = collect(bridge.stdout);
    const stderr = collect(bridge.stderr);
    // Wedged-bridge guard. The guest-side runner enforces the real deadline and
    // kills its child; this only fires if the bridge itself never comes back.
    let deadlineHit = false;
    const deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      bridge.kill();
    }, invokeOptions.timeoutMs + bridgeMarginMs);
    const closed = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      bridge.once('error', (error) => resolve({ code: null, error }));
      bridge.once('close', (code) => resolve({ code }));
    }).then((outcome) => {
      clearTimeout(deadlineTimer);
      outstanding.delete(bridge);
      return outcome;
    });
    outstanding.set(bridge, closed);
    // A bridge that dies before reading its request closes stdin early.
    bridge.stdin.on('error', () => {});
    bridge.stdin.end(
      serializeRequest({
        username: credential.username,
        password: credential.password,
        scriptBase64,
        timeoutMs: invokeOptions.timeoutMs,
      }),
    );

    // Cancellation returns promptly but leaves the supervised bridge running so
    // it can reap the guest child at its own deadline; dispose() waits for it.
    const { signal } = invokeOptions;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const settled = await Promise.race([closed, aborted]);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (settled === 'aborted') throw fail('cancelled', 'The invocation was cancelled.');

    const { code, error: spawnError } = settled;
    if (deadlineHit) {
      throw fail(
        'deadline',
        `The PowerShell Direct bridge did not finish within ${invokeOptions.timeoutMs + bridgeMarginMs} ms and was killed.`,
      );
    }
    if (spawnError) {
      throw fail('protocol', `The PowerShell Direct bridge failed: ${spawnError.message}`);
    }

    const output = stdout().trim();
    let envelope: unknown;
    try {
      envelope = JSON.parse(output);
    } catch {
      envelope = undefined;
    }
    if (isResult(envelope)) {
      return {
        exitCode: envelope.exitCode,
        stdout: envelope.stdout,
        stderr: envelope.stderr,
        timedOut: envelope.timedOut,
      };
    }
    if (isBridgeError(envelope)) {
      const kind: WindowsGuestErrorKind =
        envelope.category === 'authentication' || envelope.category === 'transport'
          ? envelope.category
          : 'protocol';
      throw fail(kind, envelope.message);
    }
    const detail = stderr().trim() || output;
    throw fail(
      'protocol',
      `The PowerShell Direct bridge exited with code ${code} without a valid result` +
        (detail ? `: ${detail}` : '.'),
    );
  }

  async function drainCancelled(timeoutMs: number): Promise<void> {
    const running = (): Promise<unknown> => Promise.allSettled([...outstanding.values()]);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs);
    });
    const winner = await Promise.race([running().then(() => 'drained' as const), expired]);
    clearTimeout(timer);
    if (winner === 'expired') {
      for (const bridge of outstanding.keys()) bridge.kill();
      await running();
    }
  }

  return {
    vmName,
    invoke,
    drainCancelled,
    async dispose() {
      disposed = true;
      await drainCancelled(disposeTimeoutMs);
      credential.username = '';
      credential.password = '';
    },
  };
}

export type PowerShellDirectReadiness = 'ready' | 'auth-rejected';

export interface WaitForPowerShellDirectOptions {
  /** The single overall deadline for the wait. */
  deadlineMs: number;
  /** Called about every `heartbeatIntervalMs` while the guest is still not ready. */
  onHeartbeat?: (elapsedMs: number) => void;
  signal?: AbortSignal;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const PROBE_TOKEN = 'ready';

/**
 * Readiness is the same boundary invoked with a tiny constant probe, retried
 * under one overall deadline. Not-ready transport problems are retried;
 * an authentication rejection is returned immediately so repeated bad
 * credentials never turn into a timeout; protocol failures and cancellation
 * are thrown as typed failures.
 */
export async function waitForPowerShellDirect(
  executor: Pick<WindowsGuestExecutor, 'vmName' | 'invoke'>,
  options: WaitForPowerShellDirectOptions,
): Promise<PowerShellDirectReadiness> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const probeIntervalMs = options.probeIntervalMs ?? 5000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const started = now();
  let lastHeartbeat = 0;
  let lastFailure: string;

  for (;;) {
    if (options.signal?.aborted) {
      throw new WindowsGuestError(
        'cancelled',
        'The PowerShell Direct readiness wait was cancelled.',
      );
    }
    const remaining = options.deadlineMs - (now() - started);
    try {
      const result = await executor.invoke(`'${PROBE_TOKEN}'`, {
        timeoutMs: Math.max(1000, Math.min(probeTimeoutMs, remaining)),
        signal: options.signal,
      });
      if (result.exitCode === 0 && result.stdout.includes(PROBE_TOKEN)) return 'ready';
      lastFailure = result.timedOut
        ? 'the readiness probe timed out inside the guest'
        : `the readiness probe exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`;
    } catch (error) {
      if (!(error instanceof WindowsGuestError)) throw error;
      if (error.kind === 'authentication') return 'auth-rejected';
      if (error.kind !== 'transport' && error.kind !== 'deadline') throw error;
      lastFailure = error.message;
    }

    const elapsed = now() - started;
    if (elapsed >= options.deadlineMs) {
      throw new WindowsGuestError(
        'timeout',
        `'${executor.vmName}' did not answer PowerShell Direct within ${Math.round(options.deadlineMs / 1000)} seconds. Last failure: ${lastFailure}`,
      );
    }
    if (elapsed - lastHeartbeat >= heartbeatIntervalMs) {
      lastHeartbeat = elapsed;
      options.onHeartbeat?.(elapsed);
    }
    await sleep(Math.min(probeIntervalMs, options.deadlineMs - elapsed), options.signal);
  }
}

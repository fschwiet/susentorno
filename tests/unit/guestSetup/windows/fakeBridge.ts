import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { BridgeProcess, SpawnBridge } from '../../../../src/guestSetup/windows/guestExecutor';

export interface BridgeRequest {
  username: string;
  password: string;
  scriptBase64: string;
  timeoutMs: number;
}

export interface FakeBridgeProcess extends BridgeProcess {
  killed: boolean;
  /** Emit stdout text, then exit like the real bridge would. */
  finish(stdout: string, exitCode?: number, stderr?: string): void;
}

/**
 * Stands in for `powershell.exe -File windowsGuestBridge.ps1`. The executor is
 * observed through its spawn seam: what it puts in argv, what it writes to
 * stdin, and how it reacts to whatever the bridge prints or fails to print.
 */
export function createFakeBridgeFactory(
  onRequest: (request: BridgeRequest, process: FakeBridgeProcess) => void,
): {
  spawn: SpawnBridge;
  calls: { command: string; args: string[]; stdin: string; process: FakeBridgeProcess }[];
} {
  const calls: {
    command: string;
    args: string[];
    stdin: string;
    process: FakeBridgeProcess;
  }[] = [];
  const spawn: SpawnBridge = (command, args) => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let closed = false;
    const process = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill() {
        process.killed = true;
        process.finish('', 1);
      },
      finish(out: string, exitCode = 0, err = '') {
        if (closed) return;
        closed = true;
        if (err) stderr.write(err);
        if (out) stdout.write(out);
        stdout.end();
        stderr.end();
        setImmediate(() => emitter.emit('close', exitCode));
      },
    }) as unknown as FakeBridgeProcess;
    const call = { command, args, stdin: '', process };
    calls.push(call);
    stdin.on('data', (chunk: Buffer) => (call.stdin += chunk.toString('utf8')));
    stdin.on('end', () => onRequest(JSON.parse(call.stdin) as BridgeRequest, process));
    return process;
  };
  return { spawn, calls };
}

export function resultEnvelope(
  result: Partial<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> = {},
): string {
  return `${JSON.stringify({ kind: 'result', exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result })}\n`;
}

export function errorEnvelope(
  category: 'transport' | 'authentication' | 'protocol',
  message: string,
): string {
  return `${JSON.stringify({ kind: 'error', category, message })}\n`;
}

import { execa } from 'execa';

export interface PowerShellExecResult {
  exitCode: number;
  stdout: string;
}

/**
 * Injectable seam for "run this PowerShell command locally and get its exit
 * code and stdout back" — the local-process counterpart to remoteExec.ts's
 * RemoteExec. Production wires this to createRealPowerShellExec (below);
 * unit tests wire it to an in-memory fake.
 */
export interface PowerShellExec {
  run(command: string, opts?: { timeoutMs?: number }): Promise<PowerShellExecResult>;
}

export function buildPowerShellArgv(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', command];
}

/**
 * Thin execa wrapper, no dedicated unit test (no execa-mocking precedent in
 * this codebase, same as createSshRemoteExec) — exercised by the
 * `host-network` tier's real Hyper-V/firewall calls and by manual
 * verification against a real Hyper-V host.
 */
export function createRealPowerShellExec(): PowerShellExec {
  return {
    async run(command: string, opts?: { timeoutMs?: number }): Promise<PowerShellExecResult> {
      const result = await execa('powershell.exe', buildPowerShellArgv(command), {
        reject: false,
        timeout: opts?.timeoutMs,
        all: true,
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.all ?? '' };
    },
  };
}

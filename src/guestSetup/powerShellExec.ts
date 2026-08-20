import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export function buildPowerShellFileArgv(scriptPath: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-File', scriptPath];
}

/**
 * CreateProcess's lpCommandLine caps at 32767 characters. A `-Command`
 * argument built from many embedded files (windowsGoldenImage.ts base64s
 * every host-trusted CA root into one script) can sail past that with no
 * warning: confirmed empirically that PowerShell exits 1 with zero captured
 * output once the assembled command crosses somewhere between 32603 and
 * 38248 characters, well below the values used here. Comfortably under that
 * ceiling, a temp script file removes the limit entirely.
 */
export const MAX_INLINE_COMMAND_LENGTH = 8000;

/**
 * Thin execa wrapper, no dedicated unit test (no execa-mocking precedent in
 * this codebase, same as createSshRemoteExec) — exercised by the
 * `host-network` tier's real Hyper-V/firewall calls and by manual
 * verification against a real Hyper-V host.
 */
export function createRealPowerShellExec(): PowerShellExec {
  return {
    async run(command: string, opts?: { timeoutMs?: number }): Promise<PowerShellExecResult> {
      if (command.length <= MAX_INLINE_COMMAND_LENGTH) {
        const result = await execa('powershell.exe', buildPowerShellArgv(command), {
          reject: false,
          timeout: opts?.timeoutMs,
          all: true,
        });
        return { exitCode: result.exitCode ?? 1, stdout: result.all ?? '' };
      }

      const scriptDir = mkdtempSync(join(tmpdir(), 'susentorno-ps-'));
      const scriptPath = join(scriptDir, `${randomUUID()}.ps1`);
      writeFileSync(scriptPath, command, 'utf8');
      try {
        const result = await execa('powershell.exe', buildPowerShellFileArgv(scriptPath), {
          reject: false,
          timeout: opts?.timeoutMs,
          all: true,
        });
        return { exitCode: result.exitCode ?? 1, stdout: result.all ?? '' };
      } finally {
        rmSync(scriptDir, { recursive: true, force: true });
      }
    },
  };
}

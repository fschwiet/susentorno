import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export interface SerialLogHandle {
  stop(): Promise<void>;
}

/**
 * Captures Hyper-V's COM pipe using the Windows named-pipe implementation.
 * Node's duplex pipe client loses this one-way Hyper-V endpoint during the
 * hand-off from early boot to systemd; NamedPipeClientStream remains attached.
 */
export function startSerialLog(pipeName: string, filePath: string): SerialLogHandle {
  mkdirSync(dirname(filePath), { recursive: true });
  const pipeLiteral = pipeName.replaceAll("'", "''");
  const fileLiteral = filePath.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'while ($true) {',
    `  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipeLiteral}', [System.IO.Pipes.PipeDirection]::In)`,
    '  try {',
    '    $pipe.Connect(5000)',
    '    $reader = [System.IO.StreamReader]::new($pipe)',
    `    while (($line = $reader.ReadLine()) -ne $null) { Add-Content -LiteralPath '${fileLiteral}' -Value $line -Encoding utf8 }`,
    '  } finally {',
    '    if ($reader) { $reader.Dispose(); $reader = $null }',
    '    $pipe.Dispose()',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        // Windows can leave a pipe-read worker between an interrupted read and
        // process exit. Do not let a best-effort diagnostic side channel pin a
        // failed build VM and all three of its VHDXs indefinitely.
        const fallback = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(fallback);
          resolve();
        });
        child.kill();
        // `SIGTERM` is advisory to a Windows PowerShell process blocked in a
        // NamedPipeClientStream read. Kill its process tree as a backstop so
        // this diagnostic worker cannot keep the Vitest worker alive after the
        // build VM has been removed.
        if (child.pid !== undefined) {
          const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          taskkill.unref();
        }
      }),
  };
}

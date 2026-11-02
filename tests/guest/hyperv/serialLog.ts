import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export interface SerialLogHandle {
  stop(): Promise<void>;
}

const unreadableLogsReported = new Set<string>();

/**
 * Reads a serial log for polling checks such as `findKernelFailure`. A log
 * that does not exist yet reads as empty. A log that exists but cannot be read
 * also reads as empty, but is reported once per path so a check that has gone
 * blind is visible in the test output.
 */
export async function readSerialLog(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    if (!unreadableLogsReported.has(path)) {
      unreadableLogsReported.add(path);
      console.warn(`serial log: cannot read ${path}; checks on it see nothing: ${String(error)}`);
    }
    return '';
  }
}

const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Captures Hyper-V's COM pipe using the Windows named-pipe implementation.
 * Node's duplex pipe client loses this one-way Hyper-V endpoint during the
 * hand-off from early boot to systemd; NamedPipeClientStream remains attached.
 *
 * The writer holds the log open for the life of the process, sharing read and
 * write access, so readers (the harness, a human, a scanner) can open it at any
 * time without making a write fail. Lines that cannot be written are counted,
 * and a marker naming the count and the error is written as soon as the log
 * can be written again, so a truncated log is distinguishable from a quiet VM.
 */
export function startSerialLog(pipeName: string, filePath: string): SerialLogHandle {
  mkdirSync(dirname(filePath), { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$pipeName = ${psLiteral(pipeName)}`,
    `$path = ${psLiteral(filePath)}`,
    '$writer = $null',
    '$dropped = 0',
    "$lastError = ''",
    'function Open-SerialLog {',
    '  if ($null -ne $script:writer) { return $true }',
    '  try {',
    '    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)',
    '    $script:writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))',
    '    $script:writer.AutoFlush = $true',
    '    return $true',
    '  } catch {',
    '    $script:lastError = $_.Exception.Message',
    '    return $false',
    '  }',
    '}',
    'function Write-SerialLine([string]$line) {',
    '  if (-not (Open-SerialLog)) { $script:dropped++; return }',
    '  try {',
    '    if ($script:dropped -gt 0) {',
    '      $script:writer.WriteLine("[serial-log] dropped $($script:dropped) line(s): $($script:lastError)")',
    '      $script:dropped = 0',
    '    }',
    '    $script:writer.WriteLine($line)',
    '  } catch {',
    '    $script:dropped++',
    '    $script:lastError = $_.Exception.Message',
    '    try { $script:writer.Dispose() } catch {}',
    '    $script:writer = $null',
    '  }',
    '}',
    '$null = Open-SerialLog',
    'while ($true) {',
    "  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::In)",
    '  $reader = $null',
    '  try {',
    '    $pipe.Connect(5000)',
    '    $reader = [System.IO.StreamReader]::new($pipe)',
    '    while ($null -ne ($line = $reader.ReadLine())) { Write-SerialLine $line }',
    '  } catch {',
    '    # Connect timed out or the pipe broke; reconnect below.',
    '  } finally {',
    '    if ($null -ne $reader) { $reader.Dispose() }',
    '    $pipe.Dispose()',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
  ].join('\n');
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { stdio: 'ignore', windowsHide: true },
  );
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

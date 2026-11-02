import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSerialLog, startSerialLog, type SerialLogHandle } from '../../guest/hyperv/serialLog';

// A stand-in for Hyper-V's COM pipe: a local named-pipe server that hands each
// connecting writer to the test.
interface FakeComPipe {
  name: string;
  nextConnection(): Promise<Socket>;
  close(): Promise<void>;
}

async function startFakeComPipe(): Promise<FakeComPipe> {
  const name = `susentorno-serial-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const pending: Socket[] = [];
  const waiters: ((socket: Socket) => void)[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else pending.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(`\\\\.\\pipe\\${name}`, resolve));
  return {
    name,
    nextConnection: () =>
      new Promise((resolve) => {
        const socket = pending.shift();
        if (socket) resolve(socket);
        else waiters.push(resolve);
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function writeLines(socket: Socket, lines: string[]): Promise<void> {
  return new Promise((resolve) =>
    socket.write(lines.map((line) => `${line}\r\n`).join(''), () => resolve()),
  );
}

function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function waitForLog(path: string, predicate: (log: string) => boolean): Promise<string> {
  const deadline = Date.now() + 30_000;
  let log = readLog(path);
  while (!predicate(log) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    log = readLog(path);
  }
  return log;
}

function logLines(log: string): string[] {
  return log.split(/\r?\n/).filter((line) => line !== '');
}

/**
 * Runs a PowerShell script in its own process and resolves once it prints
 * `ready`, so the test knows the other process is holding or polling the file.
 */
function startPowerShell(script: string): Promise<ChildProcess> {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ready')) resolve(child);
    });
    child.once('exit', (code) => reject(new Error(`PowerShell helper exited early (${code})`)));
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(process.platform !== 'win32')('startSerialLog', () => {
  let dir: string;
  let pipe: FakeComPipe | undefined;
  let serial: SerialLogHandle | undefined;
  const helpers: ChildProcess[] = [];

  afterEach(async () => {
    await serial?.stop();
    serial = undefined;
    for (const helper of helpers.splice(0)) await stopProcess(helper);
    await pipe?.close();
    pipe = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function newLogPath(): string {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'));
    return join(dir, 'nested', 'serial.log');
  }

  it('keeps every serial line while another process repeatedly reads the log', async () => {
    const logPath = newLogPath();
    pipe = await startFakeComPipe();
    serial = startSerialLog(pipe.name, logPath);
    const connection = await pipe.nextConnection();

    // A reader that, like many tools, opens the file without sharing write
    // access, holding it briefly over and over.
    helpers.push(
      await startPowerShell(
        [
          "$ErrorActionPreference = 'SilentlyContinue'",
          `$path = ${psLiteral(logPath)}`,
          "Write-Output 'ready'",
          'while ($true) {',
          '  try {',
          "    $stream = [System.IO.File]::Open($path, 'Open', 'Read', 'Read')",
          '    Start-Sleep -Milliseconds 5',
          '    $stream.Dispose()',
          '  } catch {}',
          '}',
        ].join('\n'),
      ),
    );

    const expected: string[] = [];
    for (let batch = 0; batch < 40; batch++) {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${batch * 10 + i}`);
      expected.push(...lines);
      await writeLines(connection, lines);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const log = await waitForLog(logPath, (text) => text.includes('line 399'));
    expect(logLines(log)).toEqual(expected);
  }, 60_000);

  it('marks the log when lines could not be written, then keeps logging', async () => {
    const logPath = newLogPath();
    // Another process holds the log exclusively until told to let go.
    const holder = await startPowerShell(
      [
        `$path = ${psLiteral(logPath)}`,
        '$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path)',
        "$stream = [System.IO.File]::Open($path, 'OpenOrCreate', 'ReadWrite', 'None')",
        "Write-Output 'ready'",
        '$null = [Console]::In.ReadLine()',
        '$stream.Dispose()',
        "Write-Output 'released'",
        'Start-Sleep -Seconds 30',
      ].join('\n'),
    );
    helpers.push(holder);
    pipe = await startFakeComPipe();
    serial = startSerialLog(pipe.name, logPath);
    const connection = await pipe.nextConnection();

    await writeLines(connection, ['lost 1', 'lost 2', 'lost 3']);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const released = new Promise<void>((resolve) =>
      holder.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('released')) resolve();
      }),
    );
    holder.stdin!.write('\n');
    await released;
    await writeLines(connection, ['after 1', 'after 2']);

    const log = await waitForLog(logPath, (text) => text.includes('after 2'));
    const lines = logLines(log);
    expect(lines.slice(-2)).toEqual(['after 1', 'after 2']);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/dropped 3 line/);
  }, 60_000);

  it('reconnects after the pipe disconnects and appends to the same log', async () => {
    const logPath = newLogPath();
    pipe = await startFakeComPipe();
    serial = startSerialLog(pipe.name, logPath);

    const first = await pipe.nextConnection();
    await writeLines(first, ['before 1', 'before 2']);
    await waitForLog(logPath, (text) => text.includes('before 2'));
    first.destroy();

    const second = await pipe.nextConnection();
    await writeLines(second, ['after 1', 'after 2']);

    const log = await waitForLog(logPath, (text) => text.includes('after 2'));
    expect(logLines(log)).toEqual(['before 1', 'before 2', 'after 1', 'after 2']);
  }, 60_000);
});

describe.skipIf(process.platform !== 'win32')('readSerialLog', () => {
  let dir: string | undefined;
  let holder: ChildProcess | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (holder) await stopProcess(holder);
    holder = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns the log, or empty text without a warning when no log exists yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logPath = join(dir, 'serial.log');
    expect(await readSerialLog(logPath)).toBe('');
    writeFileSync(logPath, 'line 1\n');
    expect(await readSerialLog(logPath)).toBe('line 1\n');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, naming the log, when the log cannot be read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'));
    const logPath = join(dir, 'serial.log');
    writeFileSync(logPath, 'line 1\n');
    holder = await startPowerShell(
      [
        `$stream = [System.IO.File]::Open(${psLiteral(logPath)}, 'Open', 'ReadWrite', 'None')`,
        "Write-Output 'ready'",
        'Start-Sleep -Seconds 60',
      ].join('\n'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await readSerialLog(logPath)).toBe('');
    expect(await readSerialLog(logPath)).toBe('');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(logPath);
  });
});

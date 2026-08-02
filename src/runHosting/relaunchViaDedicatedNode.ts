import { createHash } from 'node:crypto';
import { createReadStream, statSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';

export interface EnsureCopyDeps {
  execPath: string;
  homedir: string;
  fileSize: (path: string) => number | null;
  hashFile: (path: string) => Promise<string>;
  copyFile: (src: string, dest: string) => void;
  mkdir: (dirPath: string) => void;
  writeReadme: (dedicatedPath: string) => void;
}

export interface SpawnResult {
  exitCode?: number;
  signal?: string;
}

export interface RelaunchDeps extends EnsureCopyDeps {
  platform: NodeJS.Platform;
  forward: boolean;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: (
    execPath: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<SpawnResult>;
  onSigint: (handler: () => void) => void;
  error: (message: string) => void;
}

export type RelaunchResult =
  | { relaunched: true; childMayHaveAlerted: true; exitCode: number }
  | { relaunched: true; childMayHaveAlerted: false; exitCode: number }
  | { relaunched: false };

/**
 * True only when a relaunch was attempted but the child never got far enough to have run
 * its own JS-level exit handling — either it was killed by a signal before it could, or it
 * never spawned at all. In both cases nothing else could have spoken the alert, so the
 * caller (the relaunch parent) must.
 */
export function relaunchFailedWithNoChild(result: RelaunchResult): boolean {
  return result.relaunched && !result.childMayHaveAlerted;
}

const FALLBACK_EXIT_CODE = 1;

const README_CONTENT = [
  'run-proxy-node.exe is a plain copy of the node.exe that ran susentorno',
  'run-proxy, kept here so a Windows Firewall rule can be scoped to a binary',
  'that only ever runs run-proxy — not the shared system node.exe, which any',
  'other script or tool might also run through.',
  '',
  'It is not a customized build. Deleting this file is safe: the next',
  '`susentorno run-proxy` (with forwarding enabled, the default) recreates',
  'it from whatever node.exe is currently running the CLI.',
  '',
].join('\n');

/** Fixed, host-wide path — a known constant needs no discovery logic and cannot guess wrong. */
export function getDedicatedNodePath(homedir: string): string {
  return join(homedir, '.susentorno-host', 'run-proxy-node.exe');
}

/**
 * Copies `deps.execPath` to the dedicated path unless a file already there matches it
 * (size, then — only if sizes already match — content hash). Always refreshes
 * readme.txt alongside it, whether or not a copy happened.
 */
export async function ensureDedicatedNodeCopy(deps: EnsureCopyDeps): Promise<string> {
  const dedicatedPath = getDedicatedNodePath(deps.homedir);
  const sourceSize = deps.fileSize(deps.execPath);
  const existingSize = deps.fileSize(dedicatedPath);

  let matches = existingSize !== null && existingSize === sourceSize;
  if (matches) {
    const [sourceHash, existingHash] = await Promise.all([
      deps.hashFile(deps.execPath),
      deps.hashFile(dedicatedPath),
    ]);
    matches = sourceHash === existingHash;
  }

  if (!matches) {
    deps.mkdir(dirname(dedicatedPath));
    deps.copyFile(deps.execPath, dedicatedPath);
  }
  deps.writeReadme(dedicatedPath);

  return dedicatedPath;
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Relaunches through a dedicated copy of node.exe on Windows when forwarding is
 * enabled — the only case where run-proxy binds the Internal-switch adapter and can
 * trigger Windows' listen-time firewall prompt. Resolves once the relaunched child
 * has exited, with its exit code (or a fixed fallback if it died by signal, or
 * couldn't be launched at all).
 */
export async function relaunchIfNeeded(deps: RelaunchDeps): Promise<RelaunchResult> {
  if (deps.platform !== 'win32' || !deps.forward) {
    return { relaunched: false };
  }

  const dedicatedPath = getDedicatedNodePath(deps.homedir);
  if (samePath(deps.execPath, dedicatedPath)) {
    return { relaunched: false };
  }

  await ensureDedicatedNodeCopy(deps);

  // Ctrl-C on Windows delivers CTRL_C_EVENT to every process sharing the console,
  // parent and child alike. Node's default reaction to an unhandled SIGINT is
  // immediate termination — without this listener the parent would very likely die
  // on the same keystroke that's supposed to trigger the child's graceful shutdown,
  // before it can wait for the child's exit and propagate its code.
  deps.onSigint(() => {});

  const result = await deps.spawn(dedicatedPath, deps.argv.slice(1), {
    cwd: deps.cwd,
    env: deps.env,
  });

  if (result.exitCode !== undefined) {
    return { relaunched: true, childMayHaveAlerted: true, exitCode: result.exitCode };
  }
  if (result.signal !== undefined) {
    deps.error(`run-hosting: dedicated node.exe copy was terminated by signal ${result.signal}`);
  } else {
    deps.error('run-hosting: failed to launch the dedicated node.exe copy');
  }
  return { relaunched: true, childMayHaveAlerted: false, exitCode: FALLBACK_EXIT_CODE };
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function writeReadme(dedicatedPath: string): void {
  writeFileSync(join(dirname(dedicatedPath), 'readme.txt'), README_CONTENT);
}

/** Wires real fs/crypto/execa/process access; the only non-test caller. */
export function createRelaunchDeps(forward: boolean): RelaunchDeps {
  return {
    platform: process.platform,
    forward,
    execPath: process.execPath,
    argv: process.argv,
    cwd: process.cwd(),
    env: process.env,
    homedir: homedir(),
    fileSize,
    hashFile,
    copyFile: copyFileSync,
    mkdir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
    writeReadme,
    spawn: async (execPath, args, options) => {
      const result = await execa(execPath, args, { ...options, stdio: 'inherit', reject: false });
      return { exitCode: result.exitCode, signal: result.signal };
    },
    onSigint: (handler) => process.on('SIGINT', handler),
    error: (message) => console.error(message),
  };
}

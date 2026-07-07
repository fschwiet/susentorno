import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

const harnessWinDir = fileURLToPath(new URL('./harness', import.meta.url));
let harnessDir: string | undefined;

const wslArgs = ['-u', 'root', '-e'];

// The harness manages bridges, taps, and QEMU, and WSL's default user cannot
// sudo non-interactively — so everything WSL-side runs as root.
export function wslExec(script: string, opts: { reject?: boolean } = {}) {
  return execa('wsl.exe', [...wslArgs, 'bash', '-c', script], {
    reject: opts.reject ?? true,
    all: true,
  });
}

export async function wslPath(winPath: string): Promise<string> {
  const { stdout } = await execa('wsl.exe', [
    ...wslArgs,
    'wslpath',
    '-a',
    winPath.replace(/\\/g, '/'),
  ]);
  return stdout.trim();
}

// Passes args as real argv entries (execa → wsl.exe → bash), so no layer
// re-parses quotes. A guest command like `curl -w '%{http_code}' ...` arrives
// at guest.sh as a single $3 and is only ever parsed by the guest's shell.
export async function harness(script: string, ...args: string[]) {
  harnessDir ??= await wslPath(harnessWinDir);
  return execa('wsl.exe', [...wslArgs, 'bash', `${harnessDir}/${script}`, ...args], { all: true });
}

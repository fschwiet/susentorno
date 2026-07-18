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

// Guard: every call in this file invokes `wsl.exe` without `-d`, so it always
// runs whatever distro is currently the WSL default. On a machine with no
// real Linux distro registered, Docker Desktop's own minimal `docker-desktop`
// distro (BusyBox-based — no bash, no apt) can end up default simply by being
// the only one registered, and every harness call then fails with
// `execvpe(bash) failed: No such file or directory`. Probe with `sh`, not
// `bash`, since bash's absence is exactly what we're checking for.
export async function checkWslDistro(): Promise<void> {
  const probe = await execa(
    'wsl.exe',
    [
      '-u',
      'root',
      '-e',
      'sh',
      '-c',
      'command -v bash >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && echo ok',
    ],
    { reject: false, all: true },
  );
  if (probe.stdout.trim() !== 'ok') {
    throw new Error(
      'WSL default distro is missing bash and/or apt-get, so the VM test harness cannot run ' +
        `(wsl.exe said: ${(probe.all || probe.stdout || '<no output>').trim()}).\n` +
        "This usually means no real Linux distro is registered, so Docker Desktop's own minimal " +
        "'docker-desktop' distro (BusyBox-based) is the WSL default. Check with: wsl -l -v\n" +
        'Fix:\n' +
        '  wsl --install -d Ubuntu\n' +
        '  wsl --set-default Ubuntu   (if it did not become the default automatically)\n' +
        '  wsl.exe -u root bash <repo>/tests/vm/harness/setup-wsl.sh   (one-time harness deps)',
    );
  }
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

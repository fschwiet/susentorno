// THROWAWAY PROTOTYPE: not a production module.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bridgePath = fileURLToPath(new URL('./prototype-bridge.ps1', import.meta.url));

export function invokePrototype({
  vmName,
  username,
  password,
  script,
  timeoutMs = 30_000,
  local = false,
  observeSpawn,
}) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-File', bridgePath];
    if (local) args.push('-Local');
    else args.push('-VMName', vmName);
    observeSpawn?.('powershell.exe', [...args]);

    const child = spawn('powershell.exe', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`prototype bridge exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`prototype bridge returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });

    // The only process input carrying either secret or script is stdin.
    child.stdin.end(
      JSON.stringify({
        username,
        password,
        scriptBase64: Buffer.from(script, 'utf8').toString('base64'),
        timeoutMs,
      }),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await invokePrototype({
    local: true,
    username: 'unused-local-user',
    password: 'unused-local-secret',
    script: `[Console]::Out.WriteLine('prototype stdout')\n[Console]::Error.WriteLine('prototype stderr')\nexit 7`,
  });
  console.log(JSON.stringify(result, null, 2));
}

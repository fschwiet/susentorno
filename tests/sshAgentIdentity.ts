import { execa } from 'execa';
const FINGERPRINT_RE = /\bSHA256:[A-Za-z0-9+/=]+/;
export function parseFingerprint(stdout: string): string | null {
  return FINGERPRINT_RE.exec(stdout)?.[0] ?? null;
}
export function parseAgentFingerprints(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(parseFingerprint)
    .filter((value): value is string => value !== null);
}
/**
 * Adds the harness key to ssh-agent, then proves the agent that production's
 * `ssh` talks to can see it. `remoteExec.ts` resolves `ssh`/`scp` as bare names
 * through PATH, and a Windows box commonly has two OpenSSH installations —
 * Windows' (which uses the ssh-agent service) and Git for Windows' (which
 * expects SSH_AUTH_SOCK). A running service proves nothing about the agent the
 * `ssh` production invokes can reach, so resolve `ssh-add` the same way and
 * assert the fingerprint comes back. Failures name their own fix: this is the
 * first thing a fresh machine trips over.
 */
export async function ensureSshAgentIdentity(privateKeyPath: string): Promise<void> {
  const key = await execa('ssh-keygen', ['-lf', `${privateKeyPath}.pub`], { reject: false });
  const fingerprint = parseFingerprint(key.stdout ?? '');
  if (!fingerprint)
    throw new Error(
      `ssh-agent: could not read a fingerprint from ${privateKeyPath}.pub — ` +
        `is ssh-keygen on PATH? (\`${key.stdout ?? ''}\`)`,
    );
  const added = await execa('ssh-add', [privateKeyPath], { reject: false, all: true });
  if (added.exitCode !== 0)
    throw new Error(
      `ssh-agent: \`ssh-add ${privateKeyPath}\` failed: ${added.all ?? ''}\n` +
        'The guest tier needs a running ssh-agent, because its e2e test runs the real ' +
        'setup-guest-unix and that bare `ssh` has to find the harness key without editing your ' +
        '~/.ssh/config. Windows ships the agent service Disabled; enable and start it with ' +
        '(elevated PowerShell):\n' +
        '  Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent\n' +
        "If you are running from Git Bash, that `ssh-add` is Git for Windows' — it wants " +
        'SSH_AUTH_SOCK, not the Windows service, and the service above will not satisfy it. ' +
        'Run pnpm test from PowerShell instead.',
    );
  const agent = await execa('ssh-add', ['-l'], { reject: false, all: true });
  if (!parseAgentFingerprints(agent.stdout ?? '').includes(fingerprint))
    throw new Error(
      `ssh-agent: added ${privateKeyPath} but \`ssh-add -l\` does not list ${fingerprint}.\n` +
        "This usually means two OpenSSH installations are on PATH — Windows' (which uses the " +
        "ssh-agent service) and Git for Windows' (which expects SSH_AUTH_SOCK) — and the one " +
        '`ssh-add` resolved to is not the one `ssh` will resolve to. Put ' +
        'C:\\Windows\\System32\\OpenSSH ahead of Git\\usr\\bin on PATH and re-run.\n' +
        `\`ssh-add -l\` said: ${agent.all ?? ''}`,
    );
}
export async function removeSshAgentIdentity(privateKeyPath: string): Promise<void> {
  await execa('ssh-add', ['-d', privateKeyPath], { reject: false });
}

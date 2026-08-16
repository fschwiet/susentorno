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
export async function ensureSshAgentIdentity(privateKeyPath: string): Promise<void> {
  const key = await execa('ssh-keygen', ['-lf', `${privateKeyPath}.pub`], { reject: false });
  const fingerprint = parseFingerprint(key.stdout ?? '');
  if (!fingerprint)
    throw new Error(`ssh-agent: could not read a fingerprint from ${privateKeyPath}.pub`);
  const added = await execa('ssh-add', [privateKeyPath], { reject: false, all: true });
  if (added.exitCode !== 0) throw new Error(`ssh-agent: ssh-add failed: ${added.all ?? ''}`);
  const agent = await execa('ssh-add', ['-l'], { reject: false, all: true });
  if (!parseAgentFingerprints(agent.stdout ?? '').includes(fingerprint))
    throw new Error(`ssh-agent: added ${privateKeyPath} but it is not listed by ssh-add -l`);
}
export async function removeSshAgentIdentity(privateKeyPath: string): Promise<void> {
  await execa('ssh-add', ['-d', privateKeyPath], { reject: false });
}

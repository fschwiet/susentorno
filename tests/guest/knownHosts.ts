import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export function knownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts');
}
export function buildKnownHostsLine(ip: string, hostPublicKey: string): string {
  const [keyType, blob] = hostPublicKey.trim().split(/\s+/);
  if (!keyType || !blob) throw new Error(`knownHosts: '${hostPublicKey}' is not an ssh public key`);
  return `${ip} ${keyType} ${blob}`;
}
export function appendKnownHostsLine(contents: string, line: string): string {
  if (contents.split('\n').some((existing) => existing.trim() === line)) return contents;
  return `${contents}${contents === '' || contents.endsWith('\n') ? '' : '\n'}${line}\n`;
}
export async function untrustGuestHostKey(ip: string): Promise<void> {
  await execa('ssh-keygen', ['-R', ip], { reject: false });
}
export async function trustGuestHostKey(ip: string, hostPublicKey: string): Promise<void> {
  await untrustGuestHostKey(ip);
  const path = knownHostsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    appendKnownHostsLine(
      existsSync(path) ? readFileSync(path, 'utf8') : '',
      buildKnownHostsLine(ip, hostPublicKey),
    ),
  );
}

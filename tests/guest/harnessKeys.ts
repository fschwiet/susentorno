import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { guestHostKeyPath, harnessKeyPath, imageCacheDir } from './hyperv/imageCache';

export interface HarnessKeys {
  harnessPrivateKeyPath: string;
  harnessPublicKey: string;
  guestHostPrivateKey: string;
  guestHostPublicKey: string;
}
async function ensureKeyPair(path: string, comment: string): Promise<void> {
  if (!existsSync(path) || !existsSync(`${path}.pub`))
    await execa('ssh-keygen', ['-t', 'ed25519', '-f', path, '-N', '', '-C', comment, '-q']);
}
export async function ensureHarnessKeys(): Promise<HarnessKeys> {
  mkdirSync(imageCacheDir, { recursive: true });
  await ensureKeyPair(harnessKeyPath, 'susentorno-guest-tier-harness');
  await ensureKeyPair(guestHostKeyPath, 'susentorno-test-guest-host-key');
  return {
    harnessPrivateKeyPath: harnessKeyPath,
    harnessPublicKey: readFileSync(`${harnessKeyPath}.pub`, 'utf8').trim(),
    guestHostPrivateKey: readFileSync(guestHostKeyPath, 'utf8'),
    guestHostPublicKey: readFileSync(`${guestHostKeyPath}.pub`, 'utf8').trim(),
  };
}

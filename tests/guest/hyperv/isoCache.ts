import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { imageCacheDir, isoPath, isoUrl, sha256SumsUrl } from './imageCache';

/** Parse a SHA256SUMS entry by exact filename, supporting binary and text modes. */
export function parseSha256Sums(text: string, filename: string): string {
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]+)\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  throw new Error(`isoCache: ${sha256SumsUrl} does not list '${filename}'`);
}
async function fileHash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`isoCache: GET ${url} failed with ${response.status} ${response.statusText}`);
  const temporary = `${destination}.partial`;
  rmSync(temporary, { force: true });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
  renameSync(temporary, destination);
}
export async function ensureIso(): Promise<string> {
  mkdirSync(imageCacheDir, { recursive: true });
  const sums = await fetch(sha256SumsUrl);
  if (!sums.ok) throw new Error(`isoCache: GET ${sha256SumsUrl} failed with ${sums.status}`);
  const expected = parseSha256Sums(await sums.text(), basename(isoPath));
  if (existsSync(isoPath) && (await fileHash(isoPath)) === expected) return isoPath;
  rmSync(isoPath, { force: true });
  await download(isoUrl, isoPath);
  const actual = await fileHash(isoPath);
  if (actual !== expected) {
    rmSync(isoPath, { force: true });
    throw new Error(`isoCache: ${isoUrl} downloaded with digest ${actual}, expected ${expected}`);
  }
  return isoPath;
}

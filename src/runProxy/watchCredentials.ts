import Watcher from 'watcher';
import { basename, dirname } from 'node:path';

/**
 * Watch the credentials file for changes. Watches the parent directory
 * non-recursively and filters to the target basename, because Claude Code
 * rewrites credentials.json via atomic rename (new inode) — the case where raw
 * fs.watch silently goes dead on Windows. The `watcher` package handles
 * rename/replace and debouncing cross-platform.
 */
export function watchCredentials(
  credentialsPath: string,
  onEvent: () => void,
): { close: () => void } {
  const dir = dirname(credentialsPath);
  const target = basename(credentialsPath);

  const watcher = new Watcher(dir, {
    recursive: false,
    ignoreInitial: true,
    debounce: 200,
    renameDetection: true,
  });

  watcher.on('all', (_event: string, targetPath: string) => {
    if (basename(targetPath) === target) {
      onEvent();
    }
  });

  return { close: () => watcher.close() };
}

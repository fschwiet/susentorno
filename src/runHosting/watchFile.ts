import Watcher from 'watcher';
import { basename, dirname } from 'node:path';

/**
 * Watch a single file for changes. Watches the parent directory
 * non-recursively and filters to the target basename, because editors and
 * Claude Code rewrite files via atomic rename (new inode) — the case where raw
 * fs.watch silently goes dead on Windows. The `watcher` package handles
 * rename/replace and debouncing cross-platform. Used for both credentials.json
 * and the allow/auth/block policy files.
 */
export function watchFile(filePath: string, onEvent: () => void): { close: () => void } {
  const dir = dirname(filePath);
  const target = basename(filePath);

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

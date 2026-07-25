import { dirname, join } from 'node:path';

export interface EnsureCopyDeps {
  execPath: string;
  homedir: string;
  fileSize: (path: string) => number | null;
  hashFile: (path: string) => Promise<string>;
  copyFile: (src: string, dest: string) => void;
  mkdir: (dirPath: string) => void;
  writeReadme: (dedicatedPath: string) => void;
}

/** Fixed, host-wide path — a known constant needs no discovery logic and cannot guess wrong. */
export function getDedicatedNodePath(homedir: string): string {
  return join(homedir, '.configamatron-host', 'run-proxy-node.exe');
}

/**
 * Copies `deps.execPath` to the dedicated path unless a file already there matches it
 * (size, then — only if sizes already match — content hash). Always refreshes
 * readme.txt alongside it, whether or not a copy happened.
 */
export async function ensureDedicatedNodeCopy(deps: EnsureCopyDeps): Promise<string> {
  const dedicatedPath = getDedicatedNodePath(deps.homedir);
  const sourceSize = deps.fileSize(deps.execPath);
  const existingSize = deps.fileSize(dedicatedPath);

  let matches = existingSize !== null && existingSize === sourceSize;
  if (matches) {
    const [sourceHash, existingHash] = await Promise.all([
      deps.hashFile(deps.execPath),
      deps.hashFile(dedicatedPath),
    ]);
    matches = sourceHash === existingHash;
  }

  if (!matches) {
    deps.mkdir(dirname(dedicatedPath));
    deps.copyFile(deps.execPath, dedicatedPath);
  }
  deps.writeReadme(dedicatedPath);

  return dedicatedPath;
}

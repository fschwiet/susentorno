import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envPaths } from './envPaths';
import { sanitizeCredentials } from './sanitizeCredentials';
import { sanitizeCodexCredentials } from './sanitizeCodexCredentials';

export interface InitOptions {
  cwd: string;
  credentialsPath: string;
  codexCredentialsPath: string;
  templatesDir: string;
  allowlistSource: string;
}

/**
 * Reject dns-responder build artifacts (bin/obj) so a developer's local build output
 * never gets copied onto the read-only VM share. cpSync copies straight off disk and
 * ignores gitignore, so the filter is the only guard.
 */
export function isDnsResponderBuildArtifact(source: string): boolean {
  const segments = source.split(/[\\/]/);
  const dnsIdx = segments.indexOf('dns-responder');
  if (dnsIdx === -1) return false;
  return segments.slice(dnsIdx + 1).some((s) => s === 'bin' || s === 'obj');
}

/**
 * Scaffold <cwd>/.configamatron. Validates all inputs before writing anything so a
 * failed init leaves no partial environment behind. Throws on any failure.
 */
export function initEnvironment(options: InitOptions): void {
  const paths = envPaths(options.cwd);
  if (existsSync(paths.root)) {
    throw new Error(
      `${paths.root} already exists — delete it to rebuild the environment from scratch`,
    );
  }

  let rawCredentials: string;
  try {
    rawCredentials = readFileSync(options.credentialsPath, 'utf8');
  } catch {
    throw new Error(
      `could not read credentials at ${options.credentialsPath} — log in with the claude CLI first, or pass --credentials`,
    );
  }

  let sanitized: string;
  try {
    sanitized = sanitizeCredentials(rawCredentials);
  } catch (error) {
    throw new Error(
      `invalid credentials file at ${options.credentialsPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let rawCodex: string;
  try {
    rawCodex = readFileSync(options.codexCredentialsPath, 'utf8');
  } catch {
    throw new Error(
      `could not read codex credentials at ${options.codexCredentialsPath} — log in with the codex CLI first, or pass --codex-credentials`,
    );
  }

  let sanitizedCodex: string;
  try {
    sanitizedCodex = sanitizeCodexCredentials(rawCodex);
  } catch (error) {
    throw new Error(
      `invalid codex auth file at ${options.codexCredentialsPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  cpSync(join(options.templatesDir, 'vm-shared'), paths.vmShared, { recursive: true });
  cpSync(join(options.templatesDir, 'vm-shared-windows'), paths.vmSharedWindows, {
    recursive: true,
    filter: (source) => !isDnsResponderBuildArtifact(source),
  });
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowlistSource, paths.allowlist);
  for (const target of paths.vmSharedTargets) {
    writeFileSync(target.credentials, sanitized);
    writeFileSync(target.authJson, sanitizedCodex);
  }
}

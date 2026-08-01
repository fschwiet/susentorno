import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envPaths } from './envPaths';
import { sanitizeCredentials } from './sanitizeCredentials';
import { sanitizeCodexCredentials } from './sanitizeCodexCredentials';
import { planAllPhases, executePlans } from './weaveShares';

const PRE_SCRIPTS_README = `# pre-scripts

Your own VM setup scripts go here. Name runnable steps \`NN-name.sh\` or
\`NN-name.ps1\`. They run before network isolation. Reference sibling resources
relative to the script, then run \`susentorno update-shares\` after editing.
`;

const POST_SCRIPTS_README = `# post-scripts

Your own VM setup scripts go here. Name runnable steps \`NN-name.sh\` or
\`NN-name.ps1\`. They run after network isolation and reboot. Reference sibling
resources relative to the script, then run \`susentorno update-shares\` after editing.
`;

export interface InitOptions {
  cwd: string;
  credentialsPath: string;
  codexCredentialsPath: string;
  templatesDir: string;
  allowlistSource: string;
}

/**
 * Scaffold <cwd>/.susentorno. Validates all inputs before writing anything so a
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

  mkdirSync(paths.preScripts, { recursive: true });
  writeFileSync(join(paths.preScripts, 'README.md'), PRE_SCRIPTS_README);
  mkdirSync(paths.postScripts, { recursive: true });
  writeFileSync(join(paths.postScripts, 'README.md'), POST_SCRIPTS_README);
  const plans = planAllPhases({ templatesDir: options.templatesDir, paths });

  cpSync(join(options.templatesDir, 'vm-shared-linux'), paths.vmShared, { recursive: true });
  cpSync(join(options.templatesDir, 'vm-shared-windows'), paths.vmSharedWindows, {
    recursive: true,
    filter: () => true,
  });
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowlistSource, paths.allowlist);
  for (const target of paths.vmSharedTargets) {
    writeFileSync(target.credentials, sanitized);
    writeFileSync(target.authJson, sanitizedCodex);
  }

  const templateTransforms = join(options.templatesDir, 'home-jq-transforms');
  cpSync(templateTransforms, paths.homeJqTransforms, { recursive: true });
  for (const target of paths.vmSharedTargets) {
    cpSync(templateTransforms, target.homeJqTransforms, { recursive: true });
  }
  copyFileSync(join(options.templatesDir, 'susentorno.gitignore'), paths.gitignore);
  executePlans(plans);
}

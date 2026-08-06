import type { RemoteExec } from './remoteExec';
import type { PreScript } from './listPreScripts';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RunPreScriptsOptions {
  scripts: PreScript[];
  shareName: string;
  internalSwitchHostIp: string;
}

export class RunPreScriptsError extends Error {
  readonly script: string;
  constructor(script: string, exitCode: number) {
    super(`runPreScripts: '${script}' exited with code ${exitCode}`);
    this.script = script;
  }
}

const CONFIGURE_NETWORK_SLUG = 'configure-network';

export async function runPreScripts(
  remoteExec: RemoteExec,
  opts: RunPreScriptsOptions,
): Promise<void> {
  const matches = opts.scripts.filter((s) => s.slug === CONFIGURE_NETWORK_SLUG);
  if (matches.length > 1) {
    throw new Error(
      `runPreScripts: more than one pre-script resolves to '${CONFIGURE_NETWORK_SLUG}': ` +
        matches.map((s) => s.filename).join(', '),
    );
  }

  const remoteDir = `/mnt/${opts.shareName}/pre-scripts`;
  for (const s of opts.scripts) {
    const args =
      s.slug === CONFIGURE_NETWORK_SLUG ? ` ${quoteForRemoteShell(opts.internalSwitchHostIp)}` : '';
    const scriptPath = quoteForRemoteShell(`./${s.filename}`);
    const command = `cd ${quoteForRemoteShell(remoteDir)} && ${scriptPath}${args}`;
    const { exitCode } = await remoteExec.run(command);
    if (exitCode !== 0) throw new RunPreScriptsError(s.filename, exitCode);
  }
}

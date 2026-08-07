import type { RemoteExec } from './remoteExec';
import type { GuestScript } from './listScripts';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RunPostScriptsOptions {
  scripts: GuestScript[];
  shareName: string;
  onStep?: (message: string) => void;
}

export class RunPostScriptsError extends Error {
  readonly script: string;
  constructor(script: string, exitCode: number) {
    super(`runPostScripts: '${script}' exited with code ${exitCode}`);
    this.script = script;
  }
}

export async function runPostScripts(
  remoteExec: RemoteExec,
  opts: RunPostScriptsOptions,
): Promise<void> {
  const onStep = opts.onStep ?? (() => {});
  const remoteDir = `/mnt/${opts.shareName}/post-scripts`;
  for (const script of opts.scripts) {
    const scriptPath = quoteForRemoteShell(`./${script.filename}`);
    const command = `cd ${quoteForRemoteShell(remoteDir)} && ${scriptPath}`;
    onStep(`running ${script.filename}`);
    const { exitCode } = await remoteExec.run(command);
    if (exitCode !== 0) throw new RunPostScriptsError(script.filename, exitCode);
  }
}

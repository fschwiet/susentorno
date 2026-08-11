import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

export function queuedExec(responses: Array<{ exitCode: number; stdout: string }>): {
  exec: PowerShellExec;
  calls: string[];
} {
  const calls: string[] = [];
  const queue = [...responses];
  return {
    exec: {
      async run(command: string) {
        calls.push(command);
        return queue.shift() ?? { exitCode: 0, stdout: '' };
      },
    },
    calls,
  };
}

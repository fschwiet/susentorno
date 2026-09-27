import { checkDockerRunning } from '../checkDockerRunning';
import { checkElevated } from '../checkElevated';
import { checkGatewayPortsFree } from '../checkGatewayPortsFree';
import type { Prerequisite } from '../prerequisites';
import { ensureSshAgentIdentity, removeSshAgentIdentity } from '../sshAgentIdentity';
import { ensureHarnessKeys } from './harnessKeys';
import { harnessKeyPath } from './hyperv/imageCache';

// Proves the agent that production's bare `ssh` talks to can hold the harness
// key, then removes it again so the check leaves the agent as it found it. The
// guest globalSetup adds the key for the run separately, after this list passes.
async function checkSshAgent(): Promise<void> {
  await ensureHarnessKeys();
  await ensureSshAgentIdentity(harnessKeyPath);
  await removeSshAgentIdentity(harnessKeyPath);
}

export const guestPrerequisites: readonly Prerequisite[] = [
  { name: 'elevated shell', check: checkElevated },
  { name: 'Docker running', check: checkDockerRunning },
  { name: 'gateway ports free', check: checkGatewayPortsFree },
  { name: 'ssh-agent', check: checkSshAgent },
];

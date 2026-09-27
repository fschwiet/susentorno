import { checkDockerComposeAvailable } from '../checkDockerComposeAvailable';
import { checkDockerRunning } from '../checkDockerRunning';
import { checkElevated } from '../checkElevated';
import { checkHypervAvailable } from '../checkHypervAvailable';
import { checkGatewayPortsFree } from '../checkGatewayPortsFree';
import { checkWindowsIso } from './checkWindowsIso';
import type { Prerequisite } from '../prerequisites';
import {
  ensureSshAgentIdentity,
  hasSshAgentIdentity,
  removeSshAgentIdentity,
} from '../sshAgentIdentity';
import { ensureHarnessKeys } from './harnessKeys';
import { harnessKeyPath } from './hyperv/imageCache';

// Proves the agent that production's bare `ssh` talks to can hold the harness
// key, leaving the agent as it found it: a key already loaded stays loaded, and
// a key this check adds is removed again even when verifying it fails. The
// guest globalSetup adds the key for the run separately, after this list passes.
async function checkSshAgent(): Promise<void> {
  await ensureHarnessKeys();
  if (await hasSshAgentIdentity(harnessKeyPath)) return;
  try {
    await ensureSshAgentIdentity(harnessKeyPath);
  } finally {
    await removeSshAgentIdentity(harnessKeyPath);
  }
}

export const guestPrerequisites: readonly Prerequisite[] = [
  { name: 'elevated shell', check: checkElevated },
  { name: 'Hyper-V available', check: checkHypervAvailable },
  { name: 'Docker running', check: checkDockerRunning },
  { name: 'Docker Compose available', check: checkDockerComposeAvailable },
  { name: 'gateway ports free', check: checkGatewayPortsFree },
  { name: 'ssh-agent', check: checkSshAgent },
  { name: 'Windows ISO valid', check: checkWindowsIso },
];

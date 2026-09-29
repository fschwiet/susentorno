import { readFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { promptText, promptMasked, type SetupAnswerPrompts } from '../cliPrompt';
import { sleep as abortableSleep } from '../runHosting/abortableSleep';
import { DEFAULT_NAT_ADAPTER } from '../runHosting/forwarder';
import { createRealPowerShellExec, type PowerShellExec } from '../guestSetup/powerShellExec';
import {
  discoverWindowsStepPlans,
  type WindowsStepPlanResult,
} from '../guestSetup/windows/stepPlan';
import { createWindowsGuestExecutor } from '../guestSetup/windows/guestExecutor';
import { resolveHostPrerequisites } from '../guestSetup/windows/hostPrerequisites';
import {
  CANCELLED_EXIT_CODE,
  watchForInterrupt,
  type InterruptSource,
} from '../guestSetup/windows/interruptHandler';
import {
  formatResidualStateFooter,
  queryResidualVmState,
} from '../guestSetup/windows/residualStateFooter';
import { describeTarget } from '../guestSetup/windows/shareCredential';
import {
  describePhase,
  runWindowsSetup,
  type WindowsSetupClock,
  type WindowsSetupDeps,
  type WindowsSetupOutcome,
} from '../guestSetup/windows/setupFlow';

interface SetupGuestWindowsOptions {
  isolationName?: string;
  natAdapterAlias: string;
  vmName?: string;
  guestUsername?: string;
  shareName?: string;
  shareAccount?: string;
}

const COMMAND = 'setup-guest-windows';
const FAILURE_EXIT_CODE = 1;

/** Failure is 1, cancellation is 130, success is 0. */
export function exitCodeForOutcome(outcome: WindowsSetupOutcome): number {
  switch (outcome.kind) {
    case 'success':
      return 0;
    case 'failure':
      return FAILURE_EXIT_CODE;
    case 'cancelled':
      return CANCELLED_EXIT_CODE;
  }
}

/** What the command needs from the machine it runs on; tests supply fakes. */
export interface SetupGuestWindowsEnvironment {
  exec: PowerShellExec;
  cwd: string;
  prompts: SetupAnswerPrompts;
  createExecutor: WindowsSetupDeps['createExecutor'];
  clock: WindowsSetupClock;
  /** Standard output and standard error. */
  out: (line: string) => void;
  err: (line: string) => void;
  interrupts: InterruptSource;
  exit: (code: number) => void;
  exists?: (path: string) => boolean;
  /** Reads the environment's `cert.pem` (utf8) at G5. */
  readFile?: (path: string) => string;
  /** Discovers the generated share's step plans. Defaults to reading the real directories. */
  discoverStepPlans?: (vmSharedWindowsPath: string) => WindowsStepPlanResult;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

function describeOutcome(outcome: Exclude<WindowsSetupOutcome, { kind: 'success' }>): string {
  if (outcome.kind === 'failure') {
    const step = outcome.stepFilename ? ` at step ${outcome.stepFilename}` : '';
    return `${COMMAND}: failed in phase ${describePhase(outcome.phase)}${step} [${outcome.error.kind}]: ${outcome.error.message}`;
  }
  if (outcome.reason === 'interrupt' && outcome.stepFilename) {
    return `${COMMAND}: cancelled during phase ${describePhase(outcome.phase)} at step ${outcome.stepFilename}.`;
  }
  if (outcome.reason === 'input-ended') {
    return `${COMMAND}: input ended at ${outcome.question ? `the '${outcome.question}' prompt` : 'a prompt'} (phase ${describePhase(outcome.phase)}); cancelled.`;
  }
  return `${COMMAND}: cancelled.`;
}

/**
 * Everything the command does, less registration: the checks that need no
 * answers, the phase machine, and turning its outcome into output and an exit
 * code. Returns the exit code; a cancellation ended by a signal is reported as
 * 130 even when it happens before the phase machine starts.
 */
export async function executeSetupGuestWindows(
  options: SetupGuestWindowsOptions,
  env: SetupGuestWindowsEnvironment,
): Promise<number> {
  const host = await resolveHostPrerequisites(
    { exec: env.exec, cwd: env.cwd, exists: env.exists, interfaces: env.interfaces },
    { isolationName: options.isolationName, natAdapterAlias: options.natAdapterAlias },
  );
  if (!host.ok) {
    env.err(`${COMMAND}: ${host.message}`);
    return FAILURE_EXIT_CODE;
  }

  const controller = new AbortController();
  const stopWatching = watchForInterrupt({
    source: env.interrupts,
    controller,
    print: env.err,
    exit: env.exit,
  });
  let outcome: WindowsSetupOutcome;
  try {
    outcome = await runWindowsSetup(
      {
        exec: env.exec,
        createExecutor: env.createExecutor,
        prompts: env.prompts,
        out: env.out,
        clock: env.clock,
        context: host.context,
        discoverStepPlans: () =>
          (env.discoverStepPlans ?? discoverWindowsStepPlans)(host.context.vmSharedWindowsPath),
        readProxyCaPem: () =>
          (env.readFile ?? ((path) => readFileSync(path, 'utf8')))(
            join(host.context.vmSharedWindowsPath, 'cert.pem'),
          ),
      },
      {
        vmName: options.vmName,
        guestUsername: options.guestUsername,
        shareName: options.shareName,
        shareAccount: options.shareAccount,
      },
      controller.signal,
    );
  } finally {
    stopWatching();
  }

  if (outcome.kind === 'success') {
    env.out(
      `${COMMAND}: VM '${outcome.vmName}' is set up and isolated on '${host.context.internalSwitchName}'.`,
    );
    for (const entry of outcome.credentials) {
      env.out(
        `  VM share credential for ${describeTarget(entry)}: ${entry.status === 'verified' ? 'verified, kept' : entry.status}`,
      );
    }
    return exitCodeForOutcome(outcome);
  }

  env.err(describeOutcome(outcome));
  const footer = formatResidualStateFooter({
    outcome: outcome.kind,
    phase: describePhase(outcome.phase),
    stepFilename: outcome.stepFilename,
    vmName: outcome.vmName,
    credentials: outcome.credentials,
    vm:
      outcome.vmName === undefined
        ? undefined
        : await queryResidualVmState(env.exec, outcome.vmName),
  });
  for (const line of footer) env.err(line);
  return exitCodeForOutcome(outcome);
}

export function registerSetupGuestWindows(program: Command): void {
  program
    .command(COMMAND)
    .description(
      'Run the entire Windows guest setup path over PowerShell Direct: put the VM on the Default Switch, ' +
        "share this environment's Windows VM share with it, run every pre-isolation step, move the VM's " +
        'single adapter from the Default Switch to the selected Internal switch, and run every post-isolation ' +
        'step. Requires an elevated (Administrator) host terminal, a prepared environment and host network, ' +
        "and a running matching 'susentorno run-hosting'. A failed run is safe to rerun: it starts over from the " +
        'Default Switch and replays every step, so custom steps must be idempotent.',
    )
    .option(
      '--isolation-name <name>',
      'Host network to attach the guest to, as passed to create-host-network ' +
        '(letters, digits, and hyphens only); omit for the default one',
    )
    .option('--nat-adapter-alias <name>', 'Default-Switch adapter', DEFAULT_NAT_ADAPTER)
    .option('--vm-name <name>', 'Hyper-V VM name, skipping its prompt')
    .option(
      '--guest-username <user>',
      'Guest user account (a local administrator), skipping its prompt',
    )
    .option(
      '--share-name <name>',
      'SMB share name, skipping its prompt (prompt default: vm-shared-windows)',
    )
    .option(
      '--share-account <name>',
      'VM share account name, skipping its prompt (prompt default: susentorno)',
    )
    .action(async (options: SetupGuestWindowsOptions) => {
      const clock: WindowsSetupClock = { now: () => Date.now(), sleep: abortableSleep };
      const code = await executeSetupGuestWindows(options, {
        exec: createRealPowerShellExec(),
        cwd: process.cwd(),
        prompts: {
          text: (question, defaultValue) => promptText(question, defaultValue),
          masked: (question) => promptMasked(question),
        },
        createExecutor: createWindowsGuestExecutor,
        clock,
        out: (line) => console.log(line),
        err: (line) => console.error(line),
        interrupts: process,
        exit: (exitCode) => process.exit(exitCode),
      });
      process.exitCode = code;
      // A prompt abandoned by Ctrl+C leaves stdin open, which would keep the
      // process alive; a cancelled run ends here once its output is flushed.
      if (code === CANCELLED_EXIT_CODE) {
        process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
      }
    });
}

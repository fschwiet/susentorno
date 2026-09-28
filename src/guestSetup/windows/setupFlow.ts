import { PromptEndedError, type SetupAnswerPrompts } from '../../cliPrompt';
import type { PowerShellExec } from '../powerShellExec';
import { reconcileVmToSwitch, VmReconcileError } from '../vmReconcile';
import {
  waitForPowerShellDirect,
  WindowsGuestError,
  type WindowsGuestCredential,
  type WindowsGuestExecutor,
} from './guestExecutor';
import { GuestCheckError, runGuestStructuralChecks } from './guestChecks';
import { runWindowsHostPreflight } from './hostPreflight';
import type { WindowsHostContext } from './hostPrerequisites';
import {
  checkHostShareAccount,
  createVmShareCredentials,
  ShareCredentialError,
  type ShareCredentialLedgerEntry,
  type ShareCredentialTarget,
  type VmShareCredentials,
} from './shareCredential';
import {
  DEFAULT_WINDOWS_SHARE_ACCOUNT,
  pairedCredentialPrompt,
  resolveHostAnswers,
  type WindowsSetupAnswerFlags,
} from './setupAnswers';

/** PowerShell Direct readiness after a start: 5 minutes, probing about every 5 seconds. */
export const POWERSHELL_DIRECT_READY_DEADLINE_MS = 5 * 60_000;
export const POWERSHELL_DIRECT_PROBE_INTERVAL_MS = 5_000;
/** A heartbeat while a long wait is still going. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Windows shutdown is given about 3 minutes to stop gracefully and 60 seconds more to confirm Off. */
export const WINDOWS_STOP_TIMEOUT_MS = 3 * 60_000;
export const WINDOWS_OFF_CONFIRM_TIMEOUT_MS = 60_000;

/** The 14 phases of ticket 06's phase machine. */
export type WindowsSetupPhase =
  | 'H1'
  | 'H2'
  | 'H3'
  | 'G1'
  | 'G2'
  | 'G3'
  | 'G4'
  | 'G5'
  | 'G6'
  | 'G7'
  | 'G8'
  | 'G9'
  | 'G10'
  | 'G11'
  | 'G12'
  | 'G13'
  | 'G14';

const PHASE_DESCRIPTIONS: Record<WindowsSetupPhase, string> = {
  H1: 'host prerequisites and answers',
  H2: 'host checks',
  H3: 'guest credentials',
  G1: 'reconcile the VM to the Default Switch',
  G2: 'PowerShell Direct readiness',
  G3: 'guest structural checks',
  G4: 'VM share credentials',
  G5: 'guest trust reconciliation',
  G6: 'pre-isolation steps',
  G7: 'isolation gate',
  G8: 'Internal-switch share credential',
  G9: 'isolation',
  G10: 'PowerShell Direct readiness after isolation',
  G11: 'isolated-network readiness',
  G12: 'Internal-switch share access',
  G13: 'post-isolation steps',
  G14: 'completion',
};

/** 'G3 guest structural checks', the form the failure and the footer print. */
export function describePhase(phase: WindowsSetupPhase): string {
  return `${phase} ${PHASE_DESCRIPTIONS[phase]}`;
}

export type WindowsSetupFailureKind =
  | 'host-preflight'
  | 'vm-reconcile'
  | 'guest-timeout'
  | 'guest-transport'
  | 'guest-authentication'
  | 'guest-protocol'
  | 'guest-check'
  | 'share-account'
  | 'share-credential'
  | 'not-implemented'
  | 'unexpected';

export interface ClassifiedError {
  kind: WindowsSetupFailureKind;
  message: string;
}

export type WindowsSetupOutcome =
  | { kind: 'success' }
  | {
      kind: 'failure';
      phase: WindowsSetupPhase;
      /** Set once the step runner exists and a step is what failed. */
      stepFilename?: string;
      error: ClassifiedError;
      vmName?: string;
      /** What this run did to the guest's VM share credentials, after cleanup. */
      credentials?: ShareCredentialLedgerEntry[];
    }
  | {
      kind: 'cancelled';
      phase: WindowsSetupPhase;
      /** `interrupt` is Ctrl+C; `input-ended` is EOF or a cancelled prompt. */
      reason: 'interrupt' | 'input-ended';
      /** The prompt whose input ended. */
      question?: string;
      vmName?: string;
      /** What this run did to the guest's VM share credentials, after cleanup. */
      credentials?: ShareCredentialLedgerEntry[];
    };

export interface WindowsSetupClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface WindowsSetupDeps {
  /** Host PowerShell, for Hyper-V and networking cmdlets. */
  exec: PowerShellExec;
  createExecutor(options: {
    vmName: string;
    credential: WindowsGuestCredential;
  }): WindowsGuestExecutor;
  prompts: SetupAnswerPrompts;
  out: (line: string) => void;
  clock: WindowsSetupClock;
  /** What phase H1's checks resolved before any prompt. */
  context: WindowsHostContext;
}

export type WindowsSetupFlags = WindowsSetupAnswerFlags;

const NOT_IMPLEMENTED_PHASES = 'G5 through G14';

class Interrupted extends Error {}

/**
 * The Windows guest setup phase machine. Every dependency is injected, so the
 * whole flow runs against fakes; the command wires the real ones. It never
 * detects or resumes a prior run: each run starts by putting the VM on the
 * Default Switch, and each failure stops in place without rollback.
 *
 * So far it implements H1 through G4 (host checks, all guest prompts, VM
 * reconciliation, PowerShell Direct readiness, the guest structural checks, and
 * the Default-Switch VM share credential), then stops with a plain "not
 * implemented" failure at G5.
 *
 * On any failure or cancellation, cleanup closes the selected-share connection
 * and removes only the share credentials this run wrote but did not verify,
 * and the outcome carries the credential ledger for the residual-state footer.
 */
export async function runWindowsSetup(
  deps: WindowsSetupDeps,
  flags: WindowsSetupFlags,
  signal: AbortSignal,
): Promise<WindowsSetupOutcome> {
  const { out, clock, context, prompts, exec } = deps;
  let phase: WindowsSetupPhase = 'H1';
  let vmName: string | undefined;
  let executor: WindowsGuestExecutor | undefined;
  let shareCredentials: VmShareCredentials | undefined;

  const announce = (next: WindowsSetupPhase, detail?: string): void => {
    phase = next;
    out(`setup-guest-windows: ${next} ${detail ?? PHASE_DESCRIPTIONS[next]}...`);
  };

  // Ctrl+C reaches the flow as an aborted signal. Racing every wait against it
  // lets a prompt or a host command return promptly; whatever it abandons is
  // left to finish or fail on its own, and its failure is deliberately unobserved.
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Interrupted());
    else signal.addEventListener('abort', () => reject(new Interrupted()), { once: true });
  });
  interrupted.catch(() => {});
  const guard = <T>(work: Promise<T>): Promise<T> => {
    work.catch(() => {});
    return Promise.race([work, interrupted]);
  };

  const fail = (
    error: ClassifiedError,
    extra: { stepFilename?: string } = {},
  ): WindowsSetupOutcome => ({ kind: 'failure', phase, error, vmName, ...extra });
  const cancelled = (
    reason: 'interrupt' | 'input-ended',
    question?: string,
  ): WindowsSetupOutcome => ({
    kind: 'cancelled',
    phase,
    reason,
    ...(question === undefined ? {} : { question }),
    ...(vmName === undefined ? {} : { vmName }),
  });

  const main = async (): Promise<WindowsSetupOutcome> => {
    if (signal.aborted) return cancelled('interrupt');

    // H1: the environment, network, and switches were resolved before any prompt.
    announce('H1');
    const answers = await guard(resolveHostAnswers(flags, prompts));
    vmName = answers.vmName;

    announce('H2');
    const preflight = await guard(
      runWindowsHostPreflight({
        exec,
        vmName,
        shareName: answers.shareName,
        vmSharedWindowsPath: context.vmSharedWindowsPath,
        internalAdapterAlias: context.internalAdapterAlias,
        internalSwitchName: context.internalSwitchName,
        natAdapterAlias: context.natAdapterAlias,
        internalSwitchHostIp: context.internalSwitchHostIp,
      }),
    );
    if (!preflight.ok) return fail({ kind: 'host-preflight', message: preflight.message });

    // H3, G1, G2: the guest credential is asked for as a pair, and asked for
    // again as a pair whenever the guest rejects it. The VM is reconciled once.
    const credentialPrompt = pairedCredentialPrompt(prompts, {
      nameQuestion: 'Guest username',
      secretQuestion: 'Guest password',
      initialName: flags.guestUsername,
    });
    let guestUsername: string;
    let reconciled = false;
    for (;;) {
      announce('H3');
      const pair = await guard(credentialPrompt.next());
      if (pair.status === 'ended') {
        // Ctrl+C at a prompt is an interrupt; a dead stdin is not.
        return cancelled(pair.reason === 'cancelled' ? 'interrupt' : 'input-ended');
      }
      guestUsername = pair.name;

      if (!reconciled) {
        announce('G1', `reconciling '${vmName}' to '${context.defaultSwitchName}'`);
        const reconcile = await guard(
          reconcileVmToSwitch(
            {
              exec,
              vmName,
              now: () => clock.now(),
              sleep: (ms) => clock.sleep(ms),
              stopTimeoutMs: WINDOWS_STOP_TIMEOUT_MS,
              offConfirmTimeoutMs: WINDOWS_OFF_CONFIRM_TIMEOUT_MS,
            },
            context.defaultSwitchName,
          ),
        );
        if (!reconcile.started) {
          out(
            `setup-guest-windows: '${vmName}' is already running on '${context.defaultSwitchName}'; reusing it.`,
          );
        }
        reconciled = true;
      }

      announce('G2', `waiting for PowerShell Direct on '${vmName}'`);
      const attempt = deps.createExecutor({
        vmName,
        credential: { username: pair.name, password: pair.secret },
      });
      executor = attempt;
      const readiness = await waitForPowerShellDirect(attempt, {
        deadlineMs: POWERSHELL_DIRECT_READY_DEADLINE_MS,
        probeIntervalMs: POWERSHELL_DIRECT_PROBE_INTERVAL_MS,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        onHeartbeat: (elapsedMs) =>
          out(
            `setup-guest-windows: G2 still waiting for PowerShell Direct on '${vmName}'... (${Math.round(elapsedMs / 1000)}s elapsed)`,
          ),
        signal,
        now: () => clock.now(),
        sleep: (ms, sleepSignal) => clock.sleep(ms, sleepSignal),
      });
      if (readiness === 'ready') break;

      out(
        `setup-guest-windows: the guest rejected the credential for '${pair.name}' on '${vmName}'; ` +
          `asking for the username and password again.`,
      );
      executor = undefined;
      await attempt.dispose();
    }

    announce('G3');
    await runGuestStructuralChecks({
      executor: executor!,
      guestUsername,
      signal,
    });

    // G4: the VM share account and its masked password are asked for as a pair,
    // and asked for again as a pair whenever the guest cannot authenticate to the
    // share with them. Everything else that can go wrong here is structural.
    announce('G4');
    const sharing = createVmShareCredentials({
      executor: executor!,
      shareName: answers.shareName,
      signal,
    });
    shareCredentials = sharing;
    const defaultTarget: ShareCredentialTarget = {
      role: 'default',
      hostIp: context.defaultSwitchHostIp,
    };
    const sharePrompt = pairedCredentialPrompt(prompts, {
      nameQuestion: 'VM share account',
      secretQuestion: 'VM share password',
      initialName: flags.shareAccount,
      defaultName: DEFAULT_WINDOWS_SHARE_ACCOUNT,
    });
    for (;;) {
      const pair = await guard(sharePrompt.next());
      if (pair.status === 'ended') {
        return cancelled(pair.reason === 'cancelled' ? 'interrupt' : 'input-ended');
      }
      const hostCheck = await guard(
        checkHostShareAccount(exec, { account: pair.name, shareName: answers.shareName }),
      );
      if (!hostCheck.ok) return fail({ kind: 'share-account', message: hostCheck.message });

      try {
        await guard(
          sharing.replaceAndVerify(defaultTarget, { account: pair.name, password: pair.secret }),
        );
        break;
      } catch (error) {
        if (!(error instanceof ShareCredentialError && error.repromptable)) throw error;
        out(
          `setup-guest-windows: the guest could not authenticate to the VM share at ${defaultTarget.hostIp} as '${pair.name}'; ` +
            `asking for the VM share account and password again.`,
        );
      }
    }

    phase = 'G5';
    return fail({
      kind: 'not-implemented',
      message:
        `Guest '${vmName}' passed every prerequisite check and its VM share credential for ${defaultTarget.hostIp} is verified ` +
        `(H1 through G4), but the remaining phases (${NOT_IMPLEMENTED_PHASES}: trust, provisioning, and isolation) ` +
        `are not implemented yet, so setup stops here. Nothing has been provisioned on the guest.`,
    });
  };

  const toOutcome = (error: unknown): WindowsSetupOutcome => {
    if (error instanceof Interrupted) return cancelled('interrupt');
    if (error instanceof PromptEndedError) {
      return cancelled(error.reason === 'cancelled' ? 'interrupt' : 'input-ended', error.question);
    }
    if (error instanceof WindowsGuestError && error.kind === 'cancelled') {
      return cancelled('interrupt');
    }
    return fail(classify(error, phase, vmName));
  };

  let outcome: WindowsSetupOutcome;
  try {
    outcome = await main();
  } catch (error) {
    outcome = toOutcome(error);
  }

  try {
    // Cleanup runs for every ending: it does nothing when there is nothing to
    // do, and otherwise closes the open selected-share connection and removes
    // only the credentials this run wrote but never verified.
    await shareCredentials?.cleanup();
  } finally {
    // Always: the executor holds the guest password and any in-flight bridge.
    await executor?.dispose().catch(() => {});
  }

  const credentials = shareCredentials?.ledger.entries() ?? [];
  return outcome.kind !== 'success' && credentials.length > 0
    ? { ...outcome, credentials }
    : outcome;
}

function classify(
  error: unknown,
  phase: WindowsSetupPhase,
  vmName: string | undefined,
): ClassifiedError {
  if (error instanceof VmReconcileError) return { kind: 'vm-reconcile', message: error.message };
  if (error instanceof GuestCheckError) return { kind: 'guest-check', message: error.message };
  if (error instanceof ShareCredentialError) {
    return { kind: 'share-credential', message: error.message };
  }
  if (error instanceof WindowsGuestError) {
    switch (error.kind) {
      case 'timeout':
        return {
          kind: 'guest-timeout',
          message:
            `${error.message} Check in Hyper-V Manager that '${vmName}' booted to Windows and can be reached ` +
            `with PowerShell Direct (integration services enabled), then rerun.`,
        };
      case 'authentication':
        return {
          kind: 'guest-authentication',
          message: `${error.message} The guest rejected the credential during ${describePhase(phase)}; rerun to enter it again.`,
        };
      case 'protocol':
        return { kind: 'guest-protocol', message: error.message };
      default:
        return {
          kind: 'guest-transport',
          message: `${error.message} Check that '${vmName}' is still running, then rerun.`,
        };
    }
  }
  return {
    kind: 'unexpected',
    message: error instanceof Error ? error.message : String(error),
  };
}

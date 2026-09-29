import { PromptEndedError, type SetupAnswerPrompts } from '../../cliPrompt';
import type { PowerShellExec } from '../powerShellExec';
import { checkRunHostingReady } from '../runHostingReadiness';
import { isolateVmToSwitch, reconcileVmToSwitch, VmReconcileError } from '../vmReconcile';
import {
  waitForPowerShellDirect,
  WindowsGuestError,
  type WindowsGuestCredential,
  type WindowsGuestExecutor,
} from './guestExecutor';
import { checkNoPendingReboot, GuestCheckError, runGuestStructuralChecks } from './guestChecks';
import { IsolatedReadinessError, waitForIsolatedNetwork } from './isolatedReadiness';
import { runWindowsHostPreflight } from './hostPreflight';
import type { WindowsHostContext } from './hostPrerequisites';
import {
  checkHostShareAccount,
  createVmShareCredentials,
  ShareCredentialError,
  type ShareCredentialLedgerEntry,
  type ShareCredentialSecret,
  type ShareCredentialTarget,
  type VmShareCredentials,
} from './shareCredential';
import {
  DEFAULT_WINDOWS_SHARE_ACCOUNT,
  pairedCredentialPrompt,
  resolveHostAnswers,
  type WindowsSetupAnswerFlags,
} from './setupAnswers';
import { reconcileWindowsGuestTrust, WindowsTrustReconciliationError } from './trustReconciler';
import type { WindowsStepPlanResult } from './stepPlan';
import { runWindowsSteps, WindowsStepError } from './stepRunner';

/** PowerShell Direct readiness after a start: 5 minutes, probing about every 5 seconds. */
export const POWERSHELL_DIRECT_READY_DEADLINE_MS = 5 * 60_000;
export const POWERSHELL_DIRECT_PROBE_INTERVAL_MS = 5_000;
/** A heartbeat while a long wait is still going. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Windows shutdown is given about 3 minutes to stop gracefully and 60 seconds more to confirm Off. */
export const WINDOWS_STOP_TIMEOUT_MS = 3 * 60_000;
export const WINDOWS_OFF_CONFIRM_TIMEOUT_MS = 60_000;

/** The 14 phases of the spec's phase machine: three host phases, then G1 to G14. */
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
  | 'guest-trust'
  | 'step-plan'
  | 'step-exit'
  | 'step-timeout'
  | 'step-transport'
  | 'run-hosting'
  | 'isolated-network'
  | 'unexpected';

export interface ClassifiedError {
  kind: WindowsSetupFailureKind;
  message: string;
}

export type WindowsSetupOutcome =
  | {
      kind: 'success';
      vmName: string;
      /** What this run did to the guest's VM share credentials: both verified and kept. */
      credentials: ShareCredentialLedgerEntry[];
    }
  | {
      kind: 'failure';
      phase: WindowsSetupPhase;
      /** Set when a step is what failed. */
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
      /** The step that was running when the run was cancelled. */
      stepFilename?: string;
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
  /** The environment's `cert.pem` (the proxy CA), read on demand at G5. */
  readProxyCaPem: () => string;
  /**
   * Discovers and validates both phase directories of the generated Windows VM
   * share. Called in H2, so a malformed plan fails before either password prompt.
   */
  discoverStepPlans: () => WindowsStepPlanResult;
}

class Interrupted extends Error {}

/**
 * The Windows guest setup phase machine. Every dependency is injected, so the
 * whole flow runs against fakes; the command wires the real ones. It never
 * detects or resumes a prior run: each run starts by putting the VM on the
 * Default Switch, and each failure stops in place without rollback.
 *
 * It runs every phase of the spec's phase machine. H1 through G6: host checks and
 * step plans, all guest prompts, VM reconciliation, PowerShell Direct
 * readiness, the guest structural checks, the Default-Switch VM share
 * credential, guest trust reconciliation, and the pre-isolation steps. G7
 * through G13: the isolation gate, the Internal-switch credential, isolation,
 * readiness of PowerShell Direct and of the isolated network, Internal-switch
 * share access, and the post-isolation steps. G14 returns success.
 *
 * On any failure or cancellation, cleanup closes the selected-share connection
 * and removes only the share credentials this run wrote but did not verify,
 * and the outcome carries the credential ledger for the residual-state footer.
 */
export async function runWindowsSetup(
  deps: WindowsSetupDeps,
  flags: WindowsSetupAnswerFlags,
  signal: AbortSignal,
): Promise<WindowsSetupOutcome> {
  const { out, clock, context, prompts, exec } = deps;
  let phase: WindowsSetupPhase = 'H1';
  let vmName: string | undefined;
  let executor: WindowsGuestExecutor | undefined;
  let shareCredentials: VmShareCredentials | undefined;
  /** The step being run, so an interrupt can still name it. */
  let currentStep: string | undefined;

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
    stepFilename?: string,
  ): WindowsSetupOutcome => ({
    kind: 'cancelled',
    phase,
    reason,
    ...(question === undefined ? {} : { question }),
    ...(stepFilename === undefined ? {} : { stepFilename }),
    ...(vmName === undefined ? {} : { vmName }),
  });

  /** PowerShell Direct readiness for either boot: 5 minutes, with a heartbeat. */
  const waitForGuest = (target: WindowsGuestExecutor, label: 'G2' | 'G10') =>
    waitForPowerShellDirect(target, {
      deadlineMs: POWERSHELL_DIRECT_READY_DEADLINE_MS,
      probeIntervalMs: POWERSHELL_DIRECT_PROBE_INTERVAL_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      onHeartbeat: (elapsedMs) =>
        out(
          `setup-guest-windows: ${label} still waiting for PowerShell Direct on '${vmName}'... (${Math.round(elapsedMs / 1000)}s elapsed)`,
        ),
      signal,
      now: () => clock.now(),
      sleep: (ms, sleepSignal) => clock.sleep(ms, sleepSignal),
    });

  /** The graceful stop (G1 or G9) can take minutes: a heartbeat says the command is alive. */
  const stopHeartbeat = (label: 'G1' | 'G9') => ({
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    onHeartbeat: (elapsedMs: number) =>
      out(
        `setup-guest-windows: ${label} still waiting for '${vmName}' to stop... (${Math.round(elapsedMs / 1000)}s elapsed)`,
      ),
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

    // The generated step plans are structural: a malformed share fails here,
    // before either password is asked for.
    const plans = deps.discoverStepPlans();
    if (!plans.ok) return fail({ kind: 'step-plan', message: plans.message });

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
              ...stopHeartbeat('G1'),
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
      const readiness = await waitForGuest(attempt, 'G2');
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
    let shareSecret: ShareCredentialSecret;
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
        const secret = { account: pair.name, password: pair.secret };
        await guard(sharing.replaceAndVerify(defaultTarget, secret));
        shareSecret = secret;
        break;
      } catch (error) {
        if (!(error instanceof ShareCredentialError && error.repromptable)) throw error;
        out(
          `setup-guest-windows: the guest could not authenticate to the VM share at ${defaultTarget.hostIp} as '${pair.name}'; ` +
            `asking for the VM share account and password again.`,
        );
      }
    }

    // G5: the only owner of guest trust. It runs before any step can reach the
    // network, and a failure here means no step runs.
    announce('G5');
    let proxyCaPem: string;
    try {
      proxyCaPem = deps.readProxyCaPem();
    } catch (error) {
      throw new WindowsTrustReconciliationError(
        'host enumeration',
        'proxy',
        `could not read the environment's cert.pem: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await guard(
      reconcileWindowsGuestTrust({
        hostExec: exec,
        executor: executor!,
        proxyCaPem,
        signal,
        onProgress: (line) => out(`setup-guest-windows: G5 ${line}`),
      }),
    );

    // G6: every pre-isolation step, from the Default Switch address. The
    // selected-share connection is closed afterwards and the credential kept.
    announce('G6');
    await guard(
      runWindowsSteps({
        executor: executor!,
        scripts: plans.plans.pre,
        directory: 'pre-scripts',
        shareHostIp: context.defaultSwitchHostIp,
        shareName: answers.shareName,
        internalSwitchHostIp: context.internalSwitchHostIp,
        phaseLabel: 'G6',
        out,
        signal,
        onStep: (filename) => {
          currentStep = filename;
        },
      }),
    );
    currentStep = undefined;
    await guard(sharing.close(defaultTarget));

    // G7: never isolate a guest that still owes a reboot, or one whose network
    // services are gone: it would be stranded on the Internal switch.
    announce('G7');
    await guard(checkNoPendingReboot({ executor: executor!, guestUsername, signal }));
    const listeners = await guard(checkRunHostingReady(exec, context.internalSwitchHostIp));
    if (!listeners.dhcpBound || !listeners.dnsBound) {
      const missing = [!listeners.dhcpBound && 'DHCP (67)', !listeners.dnsBound && 'DNS (53)']
        .filter(Boolean)
        .join(', ');
      return fail({
        kind: 'run-hosting',
        message:
          `'susentorno run-hosting' is no longer listening on ${context.internalSwitchHostIp} (${missing} not bound), ` +
          `so isolating '${vmName}' now would leave it without a network. ` +
          `Start 'susentorno run-hosting' again, then rerun.`,
      });
    }

    // G8: after the gate on purpose, so a pre-isolation failure never discards
    // an earlier verified Internal-switch entry. Unverified until G12.
    announce('G8');
    const internalTarget: ShareCredentialTarget = {
      role: 'internal',
      hostIp: context.internalSwitchHostIp,
    };
    await guard(sharing.replace(internalTarget, shareSecret));

    // G9: graceful stop, confirm Off, move the adapter, start. Never forced.
    announce('G9', `isolating '${vmName}' onto '${context.internalSwitchName}'`);
    await guard(
      isolateVmToSwitch(
        {
          exec,
          vmName,
          now: () => clock.now(),
          sleep: (ms) => clock.sleep(ms),
          stopTimeoutMs: WINDOWS_STOP_TIMEOUT_MS,
          offConfirmTimeoutMs: WINDOWS_OFF_CONFIRM_TIMEOUT_MS,
          ...stopHeartbeat('G9'),
        },
        context.internalSwitchName,
      ),
    );

    // G10: the same executor. A rejection now is structural: the credential
    // just worked, so asking for another would not be a fix.
    announce('G10');
    if ((await waitForGuest(executor!, 'G10')) === 'auth-rejected') {
      return fail({
        kind: 'guest-authentication',
        message:
          `VM '${vmName}' rejected the credential for guest user account '${guestUsername}' after isolation, ` +
          `although it accepted it on the Default Switch. Check that the account and its password were not ` +
          `changed during setup, then rerun the whole command.`,
      });
    }

    // G11: the isolated network must work before anything else uses it.
    announce('G11');
    await guard(
      waitForIsolatedNetwork(executor!, {
        hostIp: context.internalSwitchHostIp,
        signal,
        now: () => clock.now(),
        sleep: (ms, sleepSignal) => clock.sleep(ms, sleepSignal),
        onHeartbeat: (elapsedMs, unmet) =>
          out(
            `setup-guest-windows: G11 still waiting for the isolated network on '${vmName}'... ` +
              `(${Math.round(elapsedMs / 1000)}s elapsed; unmet: ${unmet.map((entry) => entry.condition).join(', ')})`,
          ),
      }),
    );

    // G12: a bad password cannot be the cause (the same account authenticated
    // at the Default Switch address), so any failure here is structural.
    announce('G12');
    await guard(sharing.verify(internalTarget, shareSecret.account));

    // G13: every post-isolation step, from the Internal-switch address.
    announce('G13');
    await guard(
      runWindowsSteps({
        executor: executor!,
        scripts: plans.plans.post,
        directory: 'post-scripts',
        shareHostIp: context.internalSwitchHostIp,
        shareName: answers.shareName,
        internalSwitchHostIp: context.internalSwitchHostIp,
        phaseLabel: 'G13',
        out,
        signal,
        onStep: (filename) => {
          currentStep = filename;
        },
      }),
    );
    currentStep = undefined;
    await guard(sharing.close(internalTarget));

    // G14: the executor is disposed below, with every ending's cleanup.
    announce('G14');
    return { kind: 'success', vmName, credentials: sharing.ledger.entries() };
  };

  const toOutcome = (error: unknown): WindowsSetupOutcome => {
    if (error instanceof Interrupted) return cancelled('interrupt', undefined, currentStep);
    if (error instanceof WindowsStepError) {
      if (error.kind === 'cancelled') return cancelled('interrupt', undefined, error.filename);
      return fail(classifyStep(error), { stepFilename: error.filename });
    }
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

function classifyStep(error: WindowsStepError): ClassifiedError {
  switch (error.kind) {
    case 'exit':
      return { kind: 'step-exit', message: error.message };
    case 'timeout':
      return { kind: 'step-timeout', message: error.message };
    default:
      return { kind: 'step-transport', message: error.message };
  }
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
  if (error instanceof IsolatedReadinessError) {
    return { kind: 'isolated-network', message: error.message };
  }
  if (error instanceof WindowsTrustReconciliationError) {
    return {
      kind: 'guest-trust',
      message: `${error.message} Trust is left in a safe state; rerun to converge.`,
    };
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

import { PromptEndedError, type SetupAnswerPrompts } from '../../cliPrompt';

export const DEFAULT_WINDOWS_SHARE_NAME = 'vm-shared-windows';
export const DEFAULT_WINDOWS_SHARE_ACCOUNT = 'susentorno';

/** The non-secret answers with a flag. Passwords never have one. */
export interface WindowsSetupAnswerFlags {
  vmName?: string;
  guestUsername?: string;
  shareName?: string;
  shareAccount?: string;
}

export interface HostAnswers {
  vmName: string;
  shareName: string;
}

/**
 * Phase H1's prompts. Each flag suppresses only its own prompt. An ended prompt
 * (EOF or cancel) propagates as a PromptEndedError for the caller to end on.
 */
export async function resolveHostAnswers(
  flags: WindowsSetupAnswerFlags,
  prompts: SetupAnswerPrompts,
): Promise<HostAnswers> {
  const vmName = flags.vmName ?? (await prompts.text('Hyper-V VM name'));
  const shareName =
    flags.shareName ?? (await prompts.text('SMB share name', DEFAULT_WINDOWS_SHARE_NAME));
  return { vmName, shareName };
}

export interface PairedCredentialQuestions {
  nameQuestion: string;
  secretQuestion: string;
  /** A name that came from a flag: used for the first pair only, without prompting for it. */
  initialName?: string;
}

export type PairedCredentialResult =
  | { status: 'pair'; name: string; secret: string }
  | { status: 'ended'; reason: 'eof' | 'cancelled' };

export interface PairedCredentialPrompt {
  /**
   * The next (name, masked secret) pair. Calling it again means the caller
   * rejected the previous pair, so both halves are asked again (the name is
   * offered as its own default); a flagged name is never asked again to be kept.
   */
  next(): Promise<PairedCredentialResult>;
}

/**
 * The guest account and the VM share account both ask for a name and a masked
 * secret together, and a rejection may be about either half. This module knows
 * nothing about which account it is asking for.
 */
export function pairedCredentialPrompt(
  prompts: SetupAnswerPrompts,
  questions: PairedCredentialQuestions,
): PairedCredentialPrompt {
  let pendingInitialName = questions.initialName;
  let previousName: string | undefined;

  return {
    async next() {
      try {
        let name: string;
        if (pendingInitialName !== undefined) {
          name = pendingInitialName;
          pendingInitialName = undefined;
        } else {
          name = await prompts.text(questions.nameQuestion, previousName);
        }
        previousName = name;
        const secret = await prompts.masked(questions.secretQuestion);
        return { status: 'pair', name, secret };
      } catch (error) {
        if (error instanceof PromptEndedError) return { status: 'ended', reason: error.reason };
        throw error;
      }
    },
  };
}

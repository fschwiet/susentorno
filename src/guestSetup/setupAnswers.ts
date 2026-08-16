export interface SetupAnswerPrompts {
  text: (question: string, defaultValue?: string) => Promise<string>;
  masked: (question: string) => Promise<string>;
}

/** The five answers that have a flag. The SMB share password never does. */
export interface SetupAnswerFlags {
  vmName?: string;
  guestAddress?: string;
  guestUsername?: string;
  shareName?: string;
  shareAccount?: string;
}

export interface ConnectionAnswers {
  address: string;
  username: string;
  shareName: string;
  accountName: string;
  password: string;
}

export const DEFAULT_SHARE_NAME = 'vm-shared-linux';
export const DEFAULT_SHARE_ACCOUNT = 'susentorno';

/**
 * Stage one, before runPreflightChecks. Split from the rest deliberately: a bad
 * VM name or a missing switch must fail before the user types five more answers.
 */
export async function resolveVmNameAnswer(
  flags: SetupAnswerFlags,
  prompts: SetupAnswerPrompts,
): Promise<string> {
  return flags.vmName ?? prompts.text('Hyper-V VM name');
}

/**
 * Stage two, only after preflight succeeds. Each flag suppresses ONLY its own
 * prompt; anything absent still prompts, in today's order. There is no
 * all-or-nothing mode. The password is always prompted — never a flag, never a
 * file, never an environment variable; automation pipes one line into stdin
 * (see ADR-0022).
 */
export async function resolveConnectionAnswers(
  flags: SetupAnswerFlags,
  prompts: SetupAnswerPrompts,
): Promise<ConnectionAnswers> {
  const address = flags.guestAddress ?? (await prompts.text('Guest address (hostname or IP)'));
  const username = flags.guestUsername ?? (await prompts.text('Guest username'));
  const shareName = flags.shareName ?? (await prompts.text('SMB share name', DEFAULT_SHARE_NAME));
  const accountName =
    flags.shareAccount ?? (await prompts.text('Share account name', DEFAULT_SHARE_ACCOUNT));
  const password = await prompts.masked('SMB share password');
  return { address, username, shareName, accountName, password };
}

import { describe, it, expect } from 'vitest';
import { PromptEndedError, type SetupAnswerPrompts } from '../../../../src/cliPrompt';
import {
  resolveHostAnswers,
  pairedCredentialPrompt,
  DEFAULT_WINDOWS_SHARE_NAME,
  DEFAULT_WINDOWS_SHARE_ACCOUNT,
} from '../../../../src/guestSetup/windows/setupAnswers';

interface ScriptedPrompts {
  prompts: SetupAnswerPrompts;
  asked: { kind: 'text' | 'masked'; question: string; defaultValue?: string }[];
}

/**
 * Answers come from a per-question queue so a paired re-prompt can be given
 * different answers each round. An exhausted queue behaves like EOF.
 */
function scriptedPrompts(answers: Record<string, string[]>): ScriptedPrompts {
  const asked: ScriptedPrompts['asked'] = [];
  const next = (question: string): string => {
    const value = answers[question]?.shift();
    if (value === undefined) throw new PromptEndedError('eof', question);
    return value;
  };
  return {
    asked,
    prompts: {
      async text(question, defaultValue) {
        asked.push({ kind: 'text', question, defaultValue });
        const answer = next(question);
        return answer === '' && defaultValue !== undefined ? defaultValue : answer;
      },
      async masked(question) {
        asked.push({ kind: 'masked', question });
        return next(question);
      },
    },
  };
}

describe('resolveHostAnswers', () => {
  it('prompts for the VM name, then the share name with its default', async () => {
    const { prompts, asked } = scriptedPrompts({
      'Hyper-V VM name': ['win-dev'],
      'SMB share name': [''],
    });
    expect(await resolveHostAnswers({}, prompts)).toEqual({
      vmName: 'win-dev',
      shareName: 'vm-shared-windows',
    });
    expect(asked).toEqual([
      { kind: 'text', question: 'Hyper-V VM name', defaultValue: undefined },
      { kind: 'text', question: 'SMB share name', defaultValue: DEFAULT_WINDOWS_SHARE_NAME },
    ]);
  });

  it('uses each flag without prompting for that answer only', async () => {
    const onlyShare = scriptedPrompts({ 'SMB share name': ['custom-share'] });
    expect(await resolveHostAnswers({ vmName: 'win-dev' }, onlyShare.prompts)).toEqual({
      vmName: 'win-dev',
      shareName: 'custom-share',
    });
    expect(onlyShare.asked.map((a) => a.question)).toEqual(['SMB share name']);

    const onlyVm = scriptedPrompts({ 'Hyper-V VM name': ['win-dev'] });
    expect(await resolveHostAnswers({ shareName: 'custom-share' }, onlyVm.prompts)).toEqual({
      vmName: 'win-dev',
      shareName: 'custom-share',
    });
    expect(onlyVm.asked.map((a) => a.question)).toEqual(['Hyper-V VM name']);
  });

  it('prompts for nothing when both flags are given', async () => {
    const { prompts, asked } = scriptedPrompts({});
    await resolveHostAnswers({ vmName: 'a', shareName: 'b' }, prompts);
    expect(asked).toEqual([]);
  });

  it('lets an ended prompt propagate', async () => {
    const { prompts } = scriptedPrompts({});
    await expect(resolveHostAnswers({}, prompts)).rejects.toBeInstanceOf(PromptEndedError);
  });

  it('documents the default share account for the later share-credential prompt', () => {
    expect(DEFAULT_WINDOWS_SHARE_ACCOUNT).toBe('susentorno');
  });
});

describe('pairedCredentialPrompt', () => {
  const questions = { nameQuestion: 'Guest username', secretQuestion: 'Guest password' };

  it('asks the name and then the masked secret, in that order', async () => {
    const { prompts, asked } = scriptedPrompts({
      'Guest username': ['Administrator'],
      'Guest password': ['pw1'],
    });
    const pair = pairedCredentialPrompt(prompts, questions);
    expect(await pair.next()).toEqual({ status: 'pair', name: 'Administrator', secret: 'pw1' });
    expect(asked.map((a) => `${a.kind}:${a.question}`)).toEqual([
      'text:Guest username',
      'masked:Guest password',
    ]);
  });

  it('uses a flagged name for the first pair only, never prompting for it', async () => {
    const { prompts, asked } = scriptedPrompts({
      'Guest username': ['Admin2'],
      'Guest password': ['bad', 'good'],
    });
    const pair = pairedCredentialPrompt(prompts, { ...questions, initialName: 'Administrator' });
    expect(await pair.next()).toEqual({ status: 'pair', name: 'Administrator', secret: 'bad' });
    expect(asked.map((a) => a.question)).toEqual(['Guest password']);

    // The caller rejected the first pair: both halves are asked again, including
    // the name that came from the flag.
    expect(await pair.next()).toEqual({ status: 'pair', name: 'Admin2', secret: 'good' });
    expect(asked.map((a) => `${a.kind}:${a.question}`)).toEqual([
      'masked:Guest password',
      'text:Guest username',
      'masked:Guest password',
    ]);
  });

  it('offers the previous name as the default of a re-asked name', async () => {
    const { prompts, asked } = scriptedPrompts({
      'Guest username': ['Administrator', ''],
      'Guest password': ['bad', 'good'],
    });
    const pair = pairedCredentialPrompt(prompts, questions);
    await pair.next();
    expect(await pair.next()).toEqual({ status: 'pair', name: 'Administrator', secret: 'good' });
    const nameQuestions = asked.filter((a) => a.question === 'Guest username');
    expect(nameQuestions.map((a) => a.defaultValue)).toEqual([undefined, 'Administrator']);
  });

  it('offers a configured default for the first name question, then the previous name', async () => {
    const { prompts, asked } = scriptedPrompts({
      'Guest username': ['', 'Other'],
      'Guest password': ['bad', 'good'],
    });
    const pair = pairedCredentialPrompt(prompts, { ...questions, defaultName: 'susentorno' });
    expect(await pair.next()).toEqual({ status: 'pair', name: 'susentorno', secret: 'bad' });
    expect(await pair.next()).toEqual({ status: 'pair', name: 'Other', secret: 'good' });
    const nameQuestions = asked.filter((a) => a.question === 'Guest username');
    expect(nameQuestions.map((a) => a.defaultValue)).toEqual(['susentorno', 'susentorno']);
  });

  it('ends with a distinct result on EOF at the name prompt', async () => {
    const { prompts } = scriptedPrompts({});
    const pair = pairedCredentialPrompt(prompts, questions);
    expect(await pair.next()).toEqual({ status: 'ended', reason: 'eof' });
  });

  it('ends with a distinct result when the secret prompt is cancelled', async () => {
    const prompts: SetupAnswerPrompts = {
      async text() {
        return 'Administrator';
      },
      async masked(question) {
        throw new PromptEndedError('cancelled', question, 'promptMasked: cancelled');
      },
    };
    const pair = pairedCredentialPrompt(prompts, questions);
    expect(await pair.next()).toEqual({ status: 'ended', reason: 'cancelled' });
  });

  it('does not swallow errors that are not ended prompts', async () => {
    const prompts: SetupAnswerPrompts = {
      async text() {
        throw new Error('boom');
      },
      async masked() {
        return '';
      },
    };
    await expect(pairedCredentialPrompt(prompts, questions).next()).rejects.toThrow('boom');
  });
});

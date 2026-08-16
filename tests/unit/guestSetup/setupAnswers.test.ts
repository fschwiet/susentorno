import { describe, it, expect } from 'vitest';
import {
  resolveVmNameAnswer,
  resolveConnectionAnswers,
  type SetupAnswerPrompts,
} from '../../../src/guestSetup/setupAnswers';

/**
 * Records every prompt actually shown, so a test can assert that a flag
 * suppresses ONLY its own prompt. `answers` maps a question to what the user
 * would type; anything unmapped answers with the empty string, which the
 * prompt's own default handling (not this fake) would then replace.
 */
function recordingPrompts(answers: Record<string, string> = {}): {
  prompts: SetupAnswerPrompts;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    prompts: {
      async text(question, defaultValue) {
        asked.push(question);
        return answers[question] ?? defaultValue ?? '';
      },
      async masked(question) {
        asked.push(question);
        return answers[question] ?? '';
      },
    },
  };
}

describe('resolveVmNameAnswer', () => {
  it('prompts for the VM name when --vm-name is absent', async () => {
    const { prompts, asked } = recordingPrompts({ 'Hyper-V VM name': 'ubuntu-dev' });
    expect(await resolveVmNameAnswer({}, prompts)).toBe('ubuntu-dev');
    expect(asked).toEqual(['Hyper-V VM name']);
  });

  it('uses --vm-name without prompting', async () => {
    const { prompts, asked } = recordingPrompts();
    expect(await resolveVmNameAnswer({ vmName: 'ubuntu-dev' }, prompts)).toBe('ubuntu-dev');
    expect(asked).toEqual([]);
  });
});

describe('resolveConnectionAnswers', () => {
  it('prompts for all five answers plus the password, in order, with the documented defaults', async () => {
    const { prompts, asked } = recordingPrompts({
      'Guest address (hostname or IP)': '192.168.67.42',
      'Guest username': 'dev',
      'SMB share password': 'hunter2',
    });
    expect(await resolveConnectionAnswers({}, prompts)).toEqual({
      address: '192.168.67.42',
      username: 'dev',
      shareName: 'vm-shared-linux',
      accountName: 'susentorno',
      password: 'hunter2',
    });
    expect(asked).toEqual([
      'Guest address (hostname or IP)',
      'Guest username',
      'SMB share name',
      'Share account name',
      'SMB share password',
    ]);
  });

  it('uses every flag when every flag is given, and still prompts for the password', async () => {
    const { prompts, asked } = recordingPrompts({ 'SMB share password': 'hunter2' });
    expect(
      await resolveConnectionAnswers(
        {
          guestAddress: '192.168.67.42',
          guestUsername: 'dev',
          shareName: 'vm-shared-custom',
          shareAccount: 'custom-share',
        },
        prompts,
      ),
    ).toEqual({
      address: '192.168.67.42',
      username: 'dev',
      shareName: 'vm-shared-custom',
      accountName: 'custom-share',
      password: 'hunter2',
    });
    expect(asked).toEqual(['SMB share password']);
  });

  it('suppresses only the prompts whose flags were given', async () => {
    const { prompts, asked } = recordingPrompts({
      'Guest username': 'dev',
      'SMB share password': 'hunter2',
    });
    const result = await resolveConnectionAnswers(
      { guestAddress: '192.168.67.42', shareAccount: 'custom-share' },
      prompts,
    );
    expect(result).toEqual({
      address: '192.168.67.42',
      username: 'dev',
      shareName: 'vm-shared-linux',
      accountName: 'custom-share',
      password: 'hunter2',
    });
    expect(asked).toEqual(['Guest username', 'SMB share name', 'SMB share password']);
  });
});

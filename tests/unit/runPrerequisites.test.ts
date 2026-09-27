import { describe, expect, it } from 'vitest';
import { runPrerequisites, skipPrerequisite, type Prerequisite } from '../prerequisites';

describe('runPrerequisites', () => {
  it('treats a skipped entry as met and carries on to the next', async () => {
    const ran: string[] = [];
    const prerequisites: Prerequisite[] = [
      {
        name: 'optional',
        check: async () => {
          ran.push('optional');
          return skipPrerequisite('not installed');
        },
      },
      {
        name: 'required',
        check: async () => {
          ran.push('required');
        },
      },
    ];
    await expect(runPrerequisites(prerequisites)).resolves.toBeUndefined();
    expect(ran).toEqual(['optional', 'required']);
  });

  it('stops at the first failure', async () => {
    const ran: string[] = [];
    const prerequisites: Prerequisite[] = [
      {
        name: 'broken',
        check: async () => {
          ran.push('broken');
          throw new Error('fix it');
        },
      },
      {
        name: 'never',
        check: async () => {
          ran.push('never');
        },
      },
    ];
    await expect(runPrerequisites(prerequisites)).rejects.toThrow('fix it');
    expect(ran).toEqual(['broken']);
  });
});

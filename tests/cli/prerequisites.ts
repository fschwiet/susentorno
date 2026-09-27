import { execa } from 'execa';
import { skipPrerequisite, type Prerequisite, type PrerequisiteSkip } from '../prerequisites';

// Optional: the cli tests that run the real `jq` self-skip without it (see
// vmApplier.test.ts and updateShares.test.ts), so its absence is a skip here
// too, not a failure.
async function checkJq(): Promise<void | PrerequisiteSkip> {
  const result = await execa('jq', ['--version'], { reject: false });
  if (result.exitCode !== 0) {
    return skipPrerequisite(
      '`jq` is not on PATH, so the cli tests that run the real `jq` will skip. Install `jq` to run them.',
    );
  }
}

/**
 * The `cli` tier's host prerequisites. The production build it runs against is
 * deliberately not checked here: `pnpm test` builds before this tier, and a
 * stale build would pass such a check anyway.
 */
export const cliPrerequisites: readonly Prerequisite[] = [{ name: 'jq on PATH', check: checkJq }];

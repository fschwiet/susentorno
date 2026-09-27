/**
 * The outcome of an optional prerequisite that is not met: the tier can still
 * run, with the tests that need it skipping themselves. `reason` says what is
 * missing and what is skipped because of it.
 */
export interface PrerequisiteSkip {
  skipped: string;
}

/** Signal from a `check` that an optional prerequisite is absent. */
export function skipPrerequisite(reason: string): PrerequisiteSkip {
  return { skipped: reason };
}

/**
 * One named prerequisite of a test tier. `check` resolves when the host meets
 * the prerequisite and throws an error whose message names the fix when it
 * does not. An optional prerequisite that is absent resolves with
 * `skipPrerequisite(reason)` instead of throwing.
 *
 * Each tier exports an ordered list of these from its own `prerequisites.ts`.
 * The tier's `globalSetup` runs the list fail-fast via `runPrerequisites`, and
 * the preflight suite (tests/preflight/) generates one test per entry, so the
 * two can never drift. See testing.md.
 */
export interface Prerequisite {
  name: string;
  check: () => Promise<void | PrerequisiteSkip>;
}

/**
 * Run a tier's prerequisites in order, stopping at the first failure. A
 * skipped entry is not a failure.
 */
export async function runPrerequisites(prerequisites: readonly Prerequisite[]): Promise<void> {
  for (const prerequisite of prerequisites) {
    await prerequisite.check();
  }
}

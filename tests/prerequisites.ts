/**
 * One named prerequisite of a test tier. `check` resolves when the host meets
 * the prerequisite and throws an error whose message names the fix when it
 * does not.
 *
 * Each tier exports an ordered list of these from its own `prerequisites.ts`.
 * The tier's `globalSetup` runs the list fail-fast via `runPrerequisites`, and
 * the preflight suite (tests/preflight/) generates one test per entry, so the
 * two can never drift. See testing.md.
 */
export interface Prerequisite {
  name: string;
  check: () => Promise<void>;
}

/** Run a tier's prerequisites in order, stopping at the first failure. */
export async function runPrerequisites(prerequisites: readonly Prerequisite[]): Promise<void> {
  for (const prerequisite of prerequisites) {
    await prerequisite.check();
  }
}

import type { Prerequisite } from '../prerequisites';

/**
 * The `cli` tier's host prerequisites. The production build it runs against is
 * deliberately not checked here: `pnpm test` builds before this tier, and a
 * stale build would pass such a check anyway.
 */
export const cliPrerequisites: readonly Prerequisite[] = [];

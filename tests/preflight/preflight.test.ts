import { describe, it } from 'vitest';
import { cliPrerequisites } from '../cli/prerequisites';
import { guestPrerequisites } from '../guest/prerequisites';
import { hostNetworkPrerequisites } from '../host-network/prerequisites';
import type { Prerequisite } from '../prerequisites';
import { proxyStackPrerequisites } from '../proxy-stack/prerequisites';
import { unitPrerequisites } from '../unit/prerequisites';

// The one hand-maintained map from tier to its prerequisite list. It changes
// only when a tier is added; adding or removing a prerequisite is an edit to
// that tier's list alone. Unlike a tier's globalSetup, which stops at the first
// failure, every entry here runs, so one run reports everything to fix.
const tiers: Record<string, readonly Prerequisite[]> = {
  unit: unitPrerequisites,
  cli: cliPrerequisites,
  'host-network': hostNetworkPrerequisites,
  'proxy-stack': proxyStackPrerequisites,
  guest: guestPrerequisites,
};

for (const [tier, prerequisites] of Object.entries(tiers)) {
  // Vitest fails a describe with no tests, so a tier with nothing to check is
  // still listed, as a skipped group.
  const group = prerequisites.length === 0 ? describe.skip : describe;
  group(tier, () => {
    for (const { name, check } of prerequisites) {
      it(name, async (context) => {
        const outcome = await check();
        if (outcome) context.skip(outcome.skipped);
      });
    }
  });
}

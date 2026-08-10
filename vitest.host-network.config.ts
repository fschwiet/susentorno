import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/host-network/**/*.test.ts'],
    globalSetup: ['tests/host-network/globalSetup.ts'],
    testTimeout: 30000,
    // Matches vitest.config.ts's own setting: this task scaffolds the tier
    // before Task 12 adds its first test file, so a "0 tests found" result
    // must still be a passing run, not a failure.
    passWithNoTests: true,
    // Every test in this tier creates/deletes the same fixed
    // susentorno-test-internal switch and its firewall rules — shared,
    // non-namespaced host state, so files must not run concurrently.
    // Matches vitest.proxy-stack.config.ts/vitest.guest.config.ts's existing
    // precedent for tiers with the same constraint.
    fileParallelism: false,
  },
});

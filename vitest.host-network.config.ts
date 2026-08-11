import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/host-network/**/*.test.ts'],
    globalSetup: ['tests/host-network/globalSetup.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
    // Every test in this tier creates/deletes the same fixed
    // susentorno-test-internal switch and its firewall rules — shared,
    // non-namespaced host state, so files must not run concurrently.
    // Matches vitest.proxy-stack.config.ts/vitest.guest.config.ts's existing
    // precedent for tiers with the same constraint.
    fileParallelism: false,
  },
});

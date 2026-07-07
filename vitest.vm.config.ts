import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/vm/**/*.test.ts'],
    globalSetup: ['tests/vm/globalSetup.ts'],
    // Guest boots and reboots are slow; the beforeAll brings up the entire
    // stack (proxy, bridge, guest) and can take several minutes.
    testTimeout: 300_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
  },
});

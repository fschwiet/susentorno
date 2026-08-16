import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/guest/**/*.test.ts'],
    globalSetup: ['tests/guest/globalSetup.ts'],
    testTimeout: 900_000,
    hookTimeout: 1_800_000,
    fileParallelism: false,
  },
});

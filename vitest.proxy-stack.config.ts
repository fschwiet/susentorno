import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/proxy-stack/**/*.test.ts'],
    globalSetup: ['tests/proxy-stack/globalSetup.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Proxy-stack tests share a single docker compose project (the `envoy`
    // service and envoy/envoy.yaml), so they must not run concurrently or they
    // fight over the same container and ports. Run files serially; each does its
    // own compose up/down in before/afterAll.
    fileParallelism: false,
  },
});

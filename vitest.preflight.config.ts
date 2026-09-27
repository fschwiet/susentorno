import { defineConfig } from 'vitest/config';

// The preflight suite: not a tier (it exercises no product surface), but one
// test per tier prerequisite, grouped by tier. See testing.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/preflight/**/*.test.ts'],
    testTimeout: 30000,
    // The tree reporter lists every tier group, including tiers with no
    // prerequisites, so the report reads as a per-tier checklist.
    reporters: ['tree'],
    // Several checks touch shared host state (ssh-agent, ISO mounts), so files
    // run serially; tests within a file already run in order.
    fileParallelism: false,
  },
});

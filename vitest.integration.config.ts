import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    sequence: { concurrent: false, shuffle: false },
    // Both files create a project named TEST:Sample Project; run in parallel,
    // one file's task can land in the other's project and vanish with it.
    fileParallelism: false,
  },
});

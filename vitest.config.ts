import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several tests render and analyze whole synthetic videos. They take 2 to 6 s
    // on a shared CI runner, so the 5 s default fails them at random.
    testTimeout: 20_000,
  },
});

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const clientSrc = fileURLToPath(new URL('../../client/src', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': clientSrc } },
  test: {
    include: ['harness/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

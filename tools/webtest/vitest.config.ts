import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../../client');
const fromClient = createRequire(path.join(client, 'package.json'));

// Tests import client code through `@/` and must share its single React copy,
// so React resolves from client/node_modules, never from this package.
const clientPackage = (id: string) => ({
  find: new RegExp(`^${id.replaceAll('/', '\\/')}$`),
  replacement: fromClient.resolve(id),
});

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.join(client, 'src')}/` },
      clientPackage('react'),
      clientPackage('react/jsx-runtime'),
      clientPackage('react/jsx-dev-runtime'),
      clientPackage('react-dom'),
      clientPackage('react-dom/client'),
    ],
  },
  server: { fs: { allow: [here, client] } },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});

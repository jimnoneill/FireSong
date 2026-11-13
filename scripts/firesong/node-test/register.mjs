// Lets `node --test` run the client's TypeScript sources directly: Node strips
// the types, and this hook resolves the `@/` alias and extensionless imports
// the way Vite and tsc do.
import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLIENT_SRC = fileURLToPath(new URL('../../../client/src/', import.meta.url));
const SUFFIXES = ['', '.ts', '/index.ts'];

const findFile = (base) =>
  SUFFIXES.map((suffix) => base + suffix).find(
    (file) => existsSync(file) && statSync(file).isFile(),
  );

const fromTypeScript = (parentURL) =>
  typeof parentURL === 'string' && parentURL.startsWith('file:') && parentURL.endsWith('.ts');

registerHooks({
  resolve(specifier, context, nextResolve) {
    let file;
    if (specifier.startsWith('@/')) {
      file = findFile(path.join(CLIENT_SRC, specifier.slice(2)));
    } else if (/^\.\.?\//.test(specifier) && fromTypeScript(context.parentURL)) {
      file = findFile(fileURLToPath(new URL(specifier, context.parentURL)));
    }
    return file === undefined
      ? nextResolve(specifier, context)
      : { url: pathToFileURL(file).href, shortCircuit: true };
  },
});

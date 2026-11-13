import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@pms\//],
  // Everything that comes from node_modules stays out of the bundle and is loaded at run time,
  // so each package this app needs when running must be listed in its own package.json.
  external: [/^[^./@]/, /^@(?!pms\/)/],
});

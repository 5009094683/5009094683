import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript sources, so they are compiled into the
  // bundle; this app's own dependencies stay external and load from node_modules.
  noExternal: [/^@pms\//],
  async onSuccess() {
    // The server applies migrations at boot and looks for them next to the bundle.
    await cp('../../packages/db/migrations', 'dist/migrations', { recursive: true });
  },
});

/**
 * Bundle the Electron main process to dist/main.cjs. CJS output keeps
 * electron-updater's dynamic requires working regardless of Electron's ESM
 * support level; the `electron` module itself stays external (provided by the
 * Electron runtime).
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/main.cjs',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
})

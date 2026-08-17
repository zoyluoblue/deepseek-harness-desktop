/**
 * One-click packaging: build the repo artifacts, materialize the runtime and
 * vendor Node (scripts/prepare-runtime.ts), then run electron-builder for the
 * current (or overridden) target.
 *
 * Flags: --skip-build (reuse existing repo lib/dist artifacts),
 * --skip-runtime (reuse existing runtime-staging/ and vendor-node/).
 * Publishing: --publish <mode> is forwarded to electron-builder (default
 * "never"; CI passes "always" on release tags).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '..')
const argv = process.argv.slice(2)

function run(step: string, command: string, args: string[], cwd: string): void {
  console.log(`package: ${step}: ${command} ${args.join(' ')}`)
  // shell on Windows: pnpm resolves to a .cmd shim, which Node refuses to
  // spawn directly (CVE-2024-27980 hardening).
  const outcome = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (outcome.status !== 0) throw new Error(`package: ${step} failed with status ${String(outcome.status)}`)
}

const requiredArtifacts = [
  join(repoRoot, 'apps', 'cli', 'lib', 'bin.js'),
  join(repoRoot, 'apps', 'web', 'dist', 'index.html'),
]

if (argv.includes('--skip-build')) {
  const missing = requiredArtifacts.filter(path => !existsSync(path))
  if (missing.length > 0) throw new Error(`package: --skip-build but artifacts missing: ${missing.join(', ')}`)
  console.log('package: skipping repo build (--skip-build)')
} else {
  run('repo build', 'pnpm', ['run', 'build'], repoRoot)
}

if (argv.includes('--skip-runtime')) {
  console.log('package: skipping runtime preparation (--skip-runtime)')
} else {
  run('prepare runtime', 'pnpm', ['run', 'prepare:runtime'], desktopDir)
}

// CI passes signing variables unconditionally, so an unconfigured secret
// arrives as an EMPTY string — which electron-builder then treats as a real
// value (an empty CSC_LINK resolves to the project directory: "not a file").
// Drop empty ones, and drop a certificate whose password half is missing so
// the build degrades to unsigned instead of failing the import.
const SIGNING_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
for (const name of SIGNING_ENV) {
  if (process.env[name] === '') delete process.env[name]
}
for (const [link, password] of [['CSC_LINK', 'CSC_KEY_PASSWORD'], ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']] as const) {
  if (process.env[link] !== undefined && process.env[password] === undefined) {
    console.log(`package: ${link} is set but ${password} is not — building unsigned`)
    delete process.env[link]
  }
}

const publishIndex = argv.indexOf('--publish')
const publishMode = publishIndex >= 0 ? argv[publishIndex + 1] : 'never'
const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch
const platformFlag = targetPlatform === 'darwin' ? '--mac' : targetPlatform === 'win32' ? '--win' : '--linux'
const archFlag = targetArch === 'arm64' ? '--arm64' : '--x64'

run('electron-builder', 'pnpm', [
  'exec', 'electron-builder',
  platformFlag, archFlag,
  '--config', 'electron-builder.config.mjs',
  '--publish', publishMode,
], desktopDir)

console.log(`package: done — artifacts in ${join(desktopDir, 'out')}`)

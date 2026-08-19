/**
 * Materialize everything the packaged app bundles beside the Electron shell:
 *
 * 1. runtime-staging/ — the harness runtime closure, `pnpm deploy`ed from the
 *    root-workspace member desktop/runtime (a pure dependency manifest on
 *    @deepseek-ai/dsh). The tree is made symlink-free so electron-builder can
 *    copy it and codesign can walk it, mirroring scripts/build-exe-for-python-sdk.ts.
 * 2. vendor-node/<platform>-<arch>/ — an official Node runtime for the target
 *    (the harness needs node:sqlite + node:zlib zstd, engines ^22.19||>=24, so
 *    a real Node 24 is bundled instead of relying on Electron's embedded one).
 *
 * Target selection: host platform/arch by default; override with
 * DSH_DESKTOP_TARGET_PLATFORM / DSH_DESKTOP_TARGET_ARCH (CI matrix runners use
 * their own host, so overrides only matter for experiments).
 * Node version: latest v24 from nodejs.org/dist/index.json, override with
 * DSH_DESKTOP_NODE_VERSION (e.g. "24.11.0").
 */
import { spawnSync } from 'node:child_process'
import { cp, chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '..')
const staging = join(desktopDir, 'runtime-staging')
const vendorNodeDir = join(desktopDir, 'vendor-node')
const deploySourceNodeModules = join(desktopDir, 'runtime', 'node_modules')

const DEPLOY_ROOT_PACKAGE = 'dsh-desktop-runtime'

/** The build target, host by default. */
export interface Target {
  platform: NodeJS.Platform
  arch: string
}

function target(): Target {
  return {
    platform: (process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform) as NodeJS.Platform,
    arch: process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch,
  }
}

function run(step: string, command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  console.log(`prepare-runtime: ${step}: ${command} ${args.join(' ')}`)
  // shell on Windows: pnpm/tar resolve to .cmd shims, which Node refuses to
  // spawn directly (CVE-2024-27980 hardening).
  const outcome = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env })
  if (outcome.status !== 0) {
    throw new Error(`prepare-runtime: ${step} failed with status ${String(outcome.status)}`)
  }
}

/** Clear and deploy the runtime closure, matching the python single-exe pipeline flags. */
async function deployStaging(buildTarget: Target): Promise<void> {
  if (staging === repoRoot || repoRoot.startsWith(staging + sep)) {
    throw new Error(`prepare-runtime: refusing to clear ${staging}: it contains the repo root.`)
  }
  await rm(staging, { recursive: true, force: true })
  run('deploy', 'pnpm', [
    '--filter',
    DEPLOY_ROOT_PACKAGE,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    staging,
  ], repoRoot)
  await restoreLegacyHoists()
  await materializeStagedLinks()
  await restoreExecutableBits(buildTarget)
  // The deploy above rewrites the ROOT node_modules into a hoisted production
  // layout as a side effect (same flags as the python single-exe pipeline).
  // Restore the normal dev install so later pnpm runs in the repo don't abort
  // on a modules-dir purge confirmation; CI=true auto-confirms that purge.
  run('restore root install', 'pnpm', ['install'], repoRoot, { ...process.env, CI: 'true' })
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target (same failure mode the python pipeline handles).
 */
async function restoreLegacyHoists(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(deploySourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`prepare-runtime: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const nested = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
    restored.push(dependency)
  }
  if (restored.length > 0) console.log(`prepare-runtime: restored legacy deploy hoists: ${restored.join(', ')}`)
}

/** Replace deploy-time package links with real files so the shipped tree is symlink-free. */
async function materializeStagedLinks(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nested = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * npm strips executable bits from packed files; the root install restores them
 * via postinstall, but a copied tree must not depend on the source's state.
 * ripgrep ships its binary in a per-target platform package, not in the entry
 * package, so the path is built from the target.
 */
async function restoreExecutableBits({ platform, arch }: Target): Promise<void> {
  const candidates = [
    join(staging, 'node_modules', 'node-pty', 'prebuilds'),
    join(staging, 'node_modules', '@vscode', `ripgrep-${platform}-${arch}`, 'bin'),
  ]
  for (const root of candidates) {
    if (!existsSync(root)) continue
    for (const file of await walkFiles(root)) {
      if (/\.(js|json|md|d\.ts|node)$/.test(file)) continue
      await chmod(file, 0o755)
    }
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walkFiles(path))
    else out.push(path)
  }
  return out
}

/** Resolve the Node version to bundle: env pin, else latest v24 from nodejs.org. */
async function resolveNodeVersion(): Promise<string> {
  const pinned = process.env.DSH_DESKTOP_NODE_VERSION
  if (pinned !== undefined && pinned !== '') return pinned
  const response = await fetch('https://nodejs.org/dist/index.json')
  if (!response.ok) throw new Error(`prepare-runtime: nodejs.org index fetch failed: ${String(response.status)}`)
  const releases = await response.json() as { version: string }[]
  const latest = releases.find(release => release.version.startsWith('v24.'))
  if (latest === undefined) throw new Error('prepare-runtime: no v24 release found in nodejs.org index')
  return latest.version.slice(1)
}

/** Download and stage the official Node runtime for the target into vendor-node/. */
async function stageNode({ platform, arch }: Target): Promise<void> {
  const version = await resolveNodeVersion()
  const targetDir = join(vendorNodeDir, `${platform}-${arch}`)
  const stamp = join(targetDir, '.node-version')
  if (existsSync(stamp) && (await readFile(stamp, 'utf8')).trim() === version) {
    console.log(`prepare-runtime: vendor node ${version} for ${platform}-${arch} already staged`)
    return
  }
  const distName = platform === 'win32'
    ? `node-v${version}-win-${arch}`
    : `node-v${version}-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`
  const archiveName = platform === 'win32' ? `${distName}.zip` : `${distName}.tar.gz`
  const url = `https://nodejs.org/dist/v${version}/${archiveName}`
  const cacheDir = join(vendorNodeDir, 'cache')
  await mkdir(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, archiveName)
  if (!existsSync(archivePath)) {
    console.log(`prepare-runtime: downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`prepare-runtime: node download failed: ${String(response.status)} for ${url}`)
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
  }
  const extractDir = join(cacheDir, distName)
  await rm(extractDir, { recursive: true, force: true })
  // bsdtar (macOS, Linux, and Windows 10+) extracts both .tar.gz and .zip.
  run('extract node', 'tar', ['-xf', archivePath, '-C', cacheDir], cacheDir)
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  if (platform === 'win32') {
    await cp(join(extractDir, 'node.exe'), join(targetDir, 'node.exe'))
  } else {
    await mkdir(join(targetDir, 'bin'), { recursive: true })
    await cp(join(extractDir, 'bin', 'node'), join(targetDir, 'bin', 'node'))
    await chmod(join(targetDir, 'bin', 'node'), 0o755)
  }
  await writeFile(stamp, `${version}\n`)
  await rm(extractDir, { recursive: true, force: true })
  const binary = platform === 'win32' ? join(targetDir, 'node.exe') : join(targetDir, 'bin', 'node')
  console.log(`prepare-runtime: staged node ${version} at ${binary} (${String((await stat(binary)).size)} bytes)`)
}

/**
 * Every required peerDependency declared anywhere in the staged tree must
 * resolve inside it: the deploy runs with auto-install-peers=false, so peers
 * only exist when the runtime manifest lists them, and a gap surfaces as a
 * Loader-time import failure inside the packaged app. Fail here instead.
 */
async function verifyPeerClosure(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  const packageDirs: string[] = []
  for (const entry of await readdir(nodeModules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of await readdir(join(nodeModules, entry))) packageDirs.push(join(nodeModules, entry, scoped))
    } else {
      packageDirs.push(join(nodeModules, entry))
    }
  }
  const missing = new Set<string>()
  for (const dir of packageDirs) {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
      if (!existsSync(join(nodeModules, peer))) missing.add(peer)
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `prepare-runtime: staged tree is missing required peers: ${[...missing].sort().join(', ')}\n`
      + 'Add them to desktop/runtime/package.json dependencies and rerun pnpm install at the repo root.',
    )
  }
  console.log('prepare-runtime: peer closure verified')
}

/**
 * The closure carries architecture-locked platform packages (sharp, sharp's
 * libvips, koffi, ripgrep, node-addon-require-builtin) that the installer picks
 * from the host, so a staging tree left over from a different target would
 * package binaries the app cannot load. The runtime resolves them by
 * `process.platform`/`process.arch`, which fails at use, not at startup —
 * refuse them here instead.
 */
async function verifyStagedArch({ platform, arch }: Target): Promise<void> {
  const PLATFORM_PACKAGE = /-(?:darwin|linux|win32)-(?:x64|arm64|ia32)(?:-(?:musl|gnu))?$/
  const nodeModules = join(staging, 'node_modules')
  const names: string[] = []
  for (const entry of await readdir(nodeModules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of await readdir(join(nodeModules, entry))) names.push(`${entry}/${scoped}`)
    } else {
      names.push(entry)
    }
  }
  const expected = `-${platform}-${arch}`
  const foreign = names.filter(name => PLATFORM_PACKAGE.test(name) && !name.includes(expected))
  if (foreign.length > 0) {
    throw new Error(
      `prepare-runtime: staged tree carries platform packages for another target: ${foreign.sort().join(', ')}.\n`
      + `Expected ${platform}-${arch}. Delete desktop/runtime-staging and rerun without --skip-deploy.`,
    )
  }
  console.log(`prepare-runtime: staged platform packages match ${platform}-${arch}`)
}

/**
 * Fail fast on broken module resolution in the staged tree: run the staged CLI
 * with the staged Node. Host-target builds only — a cross-target Node cannot
 * execute here.
 */
function verifyStaging({ platform, arch }: Target): void {
  if (platform !== process.platform || arch !== process.arch) {
    console.log('prepare-runtime: skipping staging verification (cross-target)')
    return
  }
  const node = platform === 'win32'
    ? join(vendorNodeDir, `${platform}-${arch}`, 'node.exe')
    : join(vendorNodeDir, `${platform}-${arch}`, 'bin', 'node')
  run('verify staging', node, [join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'], staging)
}

const buildTarget = target()
const skipDeploy = process.argv.includes('--skip-deploy')
if (skipDeploy) console.log('prepare-runtime: skipping runtime deploy (--skip-deploy)')
else await deployStaging(buildTarget)
await verifyPeerClosure()
await verifyStagedArch(buildTarget)
await stageNode(buildTarget)
verifyStaging(buildTarget)
console.log('prepare-runtime: done')

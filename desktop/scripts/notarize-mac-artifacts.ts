/**
 * Notarize macOS artifacts that were built and signed elsewhere.
 *
 * The CI legs sign with the Developer ID certificate but hold no notarization
 * credentials, so their macOS output is `Unnotarized Developer ID` — Gatekeeper
 * refuses it. Notarization needs only a signed artifact, never the toolchain
 * that produced it, so it can be completed afterwards on a machine that holds
 * the credentials, whatever architecture that machine is.
 *
 * For each architecture this submits two artifacts:
 *
 * - the `.app` extracted from the update zip, which is stapled and rezipped.
 *   The updater replaces the app bundle directly, so its ticket must travel
 *   inside the zip.
 * - the `.dmg`, which macOS assesses on its own ticket when downloaded. CI
 *   leaves it unsigned (electron-builder only signs the wrapper when it can
 *   also notarize it), so it is signed here first.
 *
 * The app inside the dmg keeps no stapled ticket, but it is the same bundle as
 * the zip's app and therefore the same code directory hash, which the submission
 * above registers with Apple: Gatekeeper resolves it online on first launch.
 *
 * Rewrites each feed's zip hash, since rezipping changes the bytes.
 *
 * Usage: tsx scripts/notarize-mac-artifacts.ts <dir> [--identity <name>]
 * Credentials come from the same environment variables the packaging build
 * uses; the usual local setup is APPLE_KEYCHAIN_PROFILE from
 * `xcrun notarytool store-credentials`.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { notarize } from '@electron/notarize'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

/** One artifact in an electron-updater feed. */
interface FeedFile {
  url: string
  sha512: string
  size: number
}

/** The `latest-mac.yml` document electron-builder emits. */
interface Feed {
  version: string
  files: FeedFile[]
  path: string
  sha512: string
  releaseDate: string
}

function run(step: string, command: string, args: string[]): void {
  console.log(`notarize-mac-artifacts: ${step}`)
  const outcome = spawnSync(command, args, { stdio: 'inherit' })
  if (outcome.status !== 0) {
    throw new Error(`notarize-mac-artifacts: ${step} failed with status ${String(outcome.status)}`)
  }
}

/** Credentials in electron-builder's precedence order; see electron-builder.config.mjs. */
function notaryCredentials(): Record<string, string> {
  const env = process.env
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID }
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return env.APPLE_KEYCHAIN
      ? { keychainProfile: env.APPLE_KEYCHAIN_PROFILE, keychain: env.APPLE_KEYCHAIN }
      : { keychainProfile: env.APPLE_KEYCHAIN_PROFILE }
  }
  throw new Error(
    'notarize-mac-artifacts: no notarization credentials. Set APPLE_KEYCHAIN_PROFILE '
    + '(from `xcrun notarytool store-credentials`), the APPLE_ID trio, or the APPLE_API_KEY trio.',
  )
}

/** The lone Developer ID Application identity, unless one is named explicitly. */
function resolveIdentity(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit
  const listed = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  const names = [...listed.stdout.matchAll(/"(Developer ID Application: [^"]+)"/g)].map(match => match[1]!)
  const unique = [...new Set(names)]
  if (unique.length !== 1) {
    throw new Error(
      `notarize-mac-artifacts: expected exactly one Developer ID Application identity, found ${String(unique.length)}`
      + `${unique.length > 0 ? `: ${unique.join(', ')}` : ''}. Pass --identity <name>.`,
    )
  }
  return unique[0]!
}

async function sha512(path: string): Promise<string> {
  return createHash('sha512').update(await readFile(path)).digest('base64')
}

const [directory, ...rest] = process.argv.slice(2)
if (directory === undefined) {
  throw new Error('notarize-mac-artifacts: usage: notarize-mac-artifacts.ts <dir> [--identity <name>]')
}
const identityIndex = rest.indexOf('--identity')
const identity = resolveIdentity(identityIndex >= 0 ? rest[identityIndex + 1] : undefined)
const credentials = notaryCredentials()

const entries = await readdir(directory)
const zips = entries.filter(entry => entry.endsWith('-mac.zip'))
const dmgs = entries.filter(entry => entry.endsWith('.dmg'))
if (zips.length === 0 && dmgs.length === 0) {
  throw new Error(`notarize-mac-artifacts: no .dmg or -mac.zip artifacts in ${directory}`)
}
console.log(`notarize-mac-artifacts: signing identity ${identity}`)

const rezippedHashes = new Map<string, FeedFile>()
for (const zipName of zips) {
  const zipPath = join(directory, zipName)
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-notarize-'))
  try {
    run(`extract ${zipName}`, 'ditto', ['-x', '-k', zipPath, workspace])
    const [appName] = (await readdir(workspace)).filter(entry => entry.endsWith('.app'))
    if (appName === undefined) throw new Error(`notarize-mac-artifacts: no .app inside ${zipName}`)
    const appPath = join(workspace, appName)
    console.log(`notarize-mac-artifacts: submitting ${appName} from ${zipName}`)
    await notarize({ tool: 'notarytool', appPath, ...credentials } as Parameters<typeof notarize>[0])
    await rm(zipPath)
    // Same flags @electron/notarize and electron-builder use, so the rebuilt
    // archive preserves resource forks and the enclosing bundle directory.
    run(`rezip ${zipName}`, 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])
    rezippedHashes.set(zipName, {
      url: zipName.replaceAll(' ', '-'),
      sha512: await sha512(zipPath),
      size: (await stat(zipPath)).size,
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

for (const dmgName of dmgs) {
  const dmgPath = join(directory, dmgName)
  run(`sign ${dmgName}`, 'codesign', ['--sign', identity, '--timestamp', '--force', dmgPath])
  console.log(`notarize-mac-artifacts: submitting ${dmgName}`)
  await notarize({ tool: 'notarytool', appPath: dmgPath, ...credentials } as Parameters<typeof notarize>[0])
}

// Rezipping changed the archives, so any feed naming them now records stale
// bytes; electron-updater rejects a download whose hash disagrees.
for (const feedName of entries.filter(entry => entry.endsWith('.yml'))) {
  const feedPath = join(directory, feedName)
  const feed = load(await readFile(feedPath, 'utf8')) as Feed
  let changed = false
  for (const file of feed.files) {
    const replacement = [...rezippedHashes.values()].find(candidate => candidate.url === file.url)
    if (replacement === undefined) continue
    file.sha512 = replacement.sha512
    file.size = replacement.size
    if (feed.path === file.url) feed.sha512 = replacement.sha512
    changed = true
  }
  if (!changed) continue
  await writeFile(feedPath, dump(feed, { lineWidth: -1 }))
  console.log(`notarize-mac-artifacts: rewrote hashes in ${feedName}`)
}

console.log('notarize-mac-artifacts: done')

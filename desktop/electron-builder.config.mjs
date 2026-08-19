/**
 * electron-builder configuration. The harness runtime closure and the bundled
 * Node runtime ship as extraResources (a real, symlink-free file tree): the
 * Cordis Loader resolves bare plugin names through an actual node_modules
 * layout and app-boot maintains a symlink farm into it, so neither may live
 * inside an asar archive. Only the tiny Electron main bundle is asar'd.
 */
import { notarize } from '@electron/notarize'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch
/**
 * Notarization credentials, in electron-builder's own precedence order (see
 * MacTargetHelper.getNotarizeOptions): Apple ID + app-specific password, App
 * Store Connect API key, or a `notarytool store-credentials` keychain profile.
 * A partially configured strategy makes electron-builder throw, so each is
 * only claimed once complete.
 */
function notaryCredentials() {
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
  return null
}

const hasNotaryEnv = notaryCredentials() !== null

/**
 * electron-builder notarizes the .app alone, but macOS assesses the downloaded
 * .dmg on its own ticket, so an un-notarized wrapper is refused even when the
 * app inside carries one. Runs per artifact, before the update feed hashes it.
 * @param artifact - the completed artifact, whose `file` is an absolute path.
 */
async function notarizeDmg(artifact) {
  if (!artifact.file.endsWith('.dmg')) return
  const credentials = notaryCredentials()
  if (credentials === null) return
  await notarize({ tool: 'notarytool', appPath: artifact.file, ...credentials })
}

/**
 * Copy the runtime closure into the packed app's resources. This cannot ride
 * extraResources: electron-builder's file matcher silently drops node_modules
 * directories, and the closure IS a node_modules tree. afterPack runs before
 * signing, so the copied native binaries still get signed on macOS.
 */
async function copyRuntime(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const target = path.join(resources, 'runtime')
  await rm(target, { recursive: true, force: true })
  await cp(path.join(here, 'runtime-staging'), target, { recursive: true })
}

export default {
  appId: 'com.deepseek.harness.desktop',
  productName: 'DeepSeek Harness',
  directories: { output: 'out', buildResources: 'build' },
  files: ['dist/**'],
  asar: true,
  extraResources: [
    { from: `vendor-node/${targetPlatform}-${targetArch}`, to: 'nodejs' },
  ],
  afterPack: copyRuntime,
  artifactBuildCompleted: notarizeDmg,
  // Auto-update feed; electron-updater reads the generated app-update.yml.
  publish: { provider: 'github', owner: 'zoyluoblue', repo: 'deepseek-harness-desktop' },
  mac: {
    category: 'public.app-category.developer-tools',
    // zip is required by electron-updater's macOS update path; dmg is the human installer.
    target: [
      { target: 'dmg', arch: [targetArch] },
      { target: 'zip', arch: [targetArch] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Signing activates via CSC_LINK/CSC_KEY_PASSWORD (or a keychain identity);
    // notarization additionally needs one of the credential strategies above.
    notarize: hasNotaryEnv,
  },
  dmg: {
    // notarytool refuses an unsigned submission, so the wrapper is signed too.
    sign: hasNotaryEnv,
    // The dmg is the human installer; electron-updater takes macOS updates from
    // the zip. Keeping the dmg out of the feed also keeps notarizeDmg honest:
    // dmg-builder hashes the artifact before emitting the completion event, so
    // a feed entry would record the pre-staple bytes.
    writeUpdateInfo: false,
  },
  win: {
    target: [{ target: 'nsis', arch: [targetArch] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    category: 'Development',
    // AppImage rejects the scoped package name (@ is unsafe in file paths).
    executableName: 'deepseek-harness',
    target: [
      { target: 'AppImage', arch: [targetArch] },
      { target: 'deb', arch: [targetArch] },
    ],
  },
}

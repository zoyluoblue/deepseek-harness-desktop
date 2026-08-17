/**
 * electron-builder configuration. The harness runtime closure and the bundled
 * Node runtime ship as extraResources (a real, symlink-free file tree): the
 * Cordis Loader resolves bare plugin names through an actual node_modules
 * layout and app-boot maintains a symlink farm into it, so neither may live
 * inside an asar archive. Only the tiny Electron main bundle is asar'd.
 */
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch
const hasNotaryEnv = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  .every(name => (process.env[name] ?? '') !== '')

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
    // notarization additionally needs the three APPLE_* variables.
    notarize: hasNotaryEnv,
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

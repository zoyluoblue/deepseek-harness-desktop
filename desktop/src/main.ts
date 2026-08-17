/**
 * Electron main process: launches the harness web surface as a child process
 * (bundled Node + deployed runtime closure when packaged; the repo's source
 * launch in development), then shows the served URL in a BrowserWindow.
 *
 * `--smoke` runs a self-check instead of an interactive session: load the UI,
 * capture a screenshot next to dist/main.cjs, print `SMOKE OK`, exit 0.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startHarness, type HarnessSpec, type RunningHarness } from './harness.ts'
import { setupAutoUpdate } from './updater.ts'

const SMOKE = process.argv.includes('--smoke')

/** Child environment: the inherited one minus Electron's Node-mode switch. */
function harnessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Resolve how to launch the harness for this install layout. */
function harnessSpec(): HarnessSpec {
  if (app.isPackaged) {
    const resources = process.resourcesPath
    const node = process.platform === 'win32'
      ? path.join(resources, 'nodejs', 'node.exe')
      : path.join(resources, 'nodejs', 'bin', 'node')
    const bin = path.join(resources, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    return { command: node, args: [bin, 'web', '--port', '0'], cwd: app.getPath('home'), env: harnessEnv() }
  }
  // dist/main.cjs → desktop/ → repo root; the source launch needs the repo's
  // tsx and a built apps/web dist (`pnpm run build:web` at minimum).
  const repoRoot = path.resolve(__dirname, '..', '..')
  return {
    command: process.platform === 'win32' ? 'node.exe' : 'node',
    args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0'],
    cwd: repoRoot,
    env: harnessEnv(),
  }
}

/** Append-only line logger: harness.log under Electron's per-app logs dir when packaged, console in dev. */
function lineLogger(): (line: string) => void {
  if (!app.isPackaged) return line => console.log(`[harness] ${line}`)
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'harness.log')
  writeFileSync(file, `--- launch ${new Date().toISOString()} ---\n`, { flag: 'a' })
  return line => appendFileSync(file, `${line}\n`)
}

let harness: RunningHarness | undefined
let mainWindow: BrowserWindow | undefined
let quitting = false

function createWindow(url: string): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#101014',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { mainWindow = undefined })

  const origin = new URL(url).origin
  // The window is dedicated to the local GUI: external links go to the OS
  // browser, and nothing else may navigate the shell.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault()
      if (/^https?:/.test(target)) void shell.openExternal(target)
    }
  })

  void win.loadURL(url)
}

async function runSmoke(url: string): Promise<never> {
  createWindow(url)
  const win = mainWindow
  if (win === undefined) throw new Error('smoke: window failed to open')
  const timeout = setTimeout(() => {
    console.error('SMOKE TIMEOUT: page did not finish loading')
    app.exit(1)
  }, 120_000)
  await new Promise<void>((resolve, reject) => {
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`did-fail-load ${String(code)}: ${description}`)))
  })
  // Give the React app a beat to hydrate before capturing.
  await delay(3000)
  const image = await win.webContents.capturePage()
  // dist/ is inside the asar when packaged, so the shot goes to the temp dir there.
  const shot = app.isPackaged ? path.join(app.getPath('temp'), 'dsh-desktop-smoke.png') : path.join(__dirname, 'smoke.png')
  writeFileSync(shot, image.toPNG())
  clearTimeout(timeout)
  console.log(`smoke: screenshot written to ${shot}`)
  console.log(`smoke: harness URL ${url}`)
  console.log('SMOKE OK')
  app.exit(0)
  return new Promise<never>(() => {})
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  await app.whenReady()
  const log = lineLogger()
  try {
    harness = await startHarness(harnessSpec(), log)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (SMOKE) {
      console.error(`SMOKE FAIL: ${message}`)
      app.exit(1)
      return
    }
    dialog.showErrorBox('DeepSeek Harness failed to start', message)
    app.exit(1)
    return
  }

  // A harness that dies while the app is open is unrecoverable for the GUI.
  void harness.exited.then((code) => {
    if (quitting) return
    dialog.showErrorBox(
      'DeepSeek Harness stopped unexpectedly',
      `The harness process exited with code ${String(code)}.\n\n--- output tail ---\n${(harness?.outputTail() ?? []).join('\n')}`,
    )
    app.quit()
  })

  if (SMOKE) {
    await runSmoke(harness.url)
    return
  }

  createWindow(harness.url)
  setupAutoUpdate(log)
  app.on('activate', () => {
    if (mainWindow === undefined && harness !== undefined) createWindow(harness.url)
  })
}

app.on('window-all-closed', () => {
  // The harness keeps sessions alive while the app runs; macOS convention keeps
  // the app in the dock, other platforms quit with the last window.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || harness === undefined) return
  event.preventDefault()
  quitting = true
  void harness.stop().finally(() => app.quit())
})

void main()

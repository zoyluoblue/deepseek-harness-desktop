/**
 * Auto-update via electron-updater against the GitHub Releases feed declared
 * in electron-builder.config.mjs. Failures never disturb the session: an
 * unsigned macOS build or an offline machine just logs and moves on.
 */
import { app } from 'electron'

/**
 * Check for updates once at startup; downloads happen in the background and
 * install on quit (checkForUpdatesAndNotify semantics).
 * @param onLine - receives updater log lines.
 */
export function setupAutoUpdate(onLine: (line: string) => void): void {
  if (!app.isPackaged) return
  void (async () => {
    try {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.logger = {
        info: (message: unknown) => onLine(`updater: ${String(message)}`),
        warn: (message: unknown) => onLine(`updater: warn: ${String(message)}`),
        error: (message: unknown) => onLine(`updater: error: ${String(message)}`),
        debug: (message: unknown) => onLine(`updater: debug: ${String(message)}`),
      }
      await autoUpdater.checkForUpdatesAndNotify()
    } catch (error) {
      onLine(`updater: check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
}

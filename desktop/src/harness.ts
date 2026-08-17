/**
 * Harness child-process management: spawn the dsh web surface, wait for its
 * `dsh web: <url>` readiness line, and stop it with a SIGTERM→SIGKILL ladder.
 * The URL line is the documented readiness signal — web-app prints it only
 * after the Loader tree settles, so the /api routes are mounted by the time
 * the shell navigates.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import readline from 'node:readline'

/** How the harness is launched: interpreter, entry arguments, cwd, environment. */
export interface HarnessSpec {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** A running harness: its base URL, output tail for diagnostics, and stop(). */
export interface RunningHarness {
  url: string
  /** Last output lines (stdout+stderr interleaved), newest last. */
  outputTail: () => string[]
  /** Resolves when the child has exited (never rejects). */
  exited: Promise<number | null>
  stop: () => Promise<void>
}

const URL_LINE = /^dsh web: (http:\/\/\S+)/
const READY_TIMEOUT_MS = 90_000
const TERM_GRACE_MS = 8_000
const TAIL_LINES = 60

/**
 * Spawn the harness and resolve once the web surface prints its URL line.
 * @param spec - launch parameters.
 * @param onLine - receives every output line (for logging).
 * @returns the running harness handle.
 */
export function startHarness(spec: HarnessSpec, onLine: (line: string) => void): Promise<RunningHarness> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const tail: string[] = []
  const record = (line: string): void => {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
    onLine(line)
  }

  const exited: Promise<number | null> = new Promise((resolve) => {
    child.once('exit', code => resolve(code))
    child.once('error', () => resolve(null))
  })

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, TERM_GRACE_MS)
    await exited
    clearTimeout(killTimer)
  }

  return new Promise<RunningHarness>((resolve, reject) => {
    let settled = false
    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      void stop()
      reject(new Error(`${reason}\n--- harness output tail ---\n${tail.join('\n')}`))
    }

    const timer = setTimeout(() => fail(`harness did not print its URL within ${String(READY_TIMEOUT_MS / 1000)}s`), READY_TIMEOUT_MS)

    readline.createInterface({ input: child.stderr }).on('line', record)
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      record(line)
      const match = URL_LINE.exec(line)
      if (match !== null && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ url: match[1], outputTail: () => [...tail], exited, stop })
      }
    })

    child.once('error', error => fail(`failed to spawn harness: ${error.message}`))
    void exited.then((code) => {
      clearTimeout(timer)
      fail(`harness exited with code ${String(code)} before becoming ready`)
    })
  })
}

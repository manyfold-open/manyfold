import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'

const PROBE_TIMEOUT_MS = 3_000
const MAX_OUTPUT_BYTES = 64 * 1024

export type ShellProbeResult =
    | { status: 'ok'; output: string }
    | { status: 'timeout' | 'failed' | 'aborted' | 'output_limit'; output: '' }

export const runShellProbe = (
    shell: string,
    script: string,
    signal?: AbortSignal
): Promise<ShellProbeResult> =>
    new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({ status: 'aborted', output: '' })
            return
        }
        const grouped = process.platform !== 'win32'
        const child = spawn(shell, ['-ilc', script], {
            detached: grouped,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        })
        const chunks: Buffer[] = []
        let bytes = 0
        let failure: Exclude<ShellProbeResult['status'], 'ok'> | undefined
        let killed = false
        const killOwned = (): void => {
            if (killed || !child.pid) return
            killed = true
            if (grouped) {
                // detached gives only this probe a new process group. Killing
                // the group also closes pipes held by shell descendants.
                try {
                    process.kill(-child.pid, 'SIGKILL')
                } catch {}
            } else {
                execFile(
                    join(
                        process.env.SystemRoot || 'C:\\Windows',
                        'System32',
                        'taskkill.exe'
                    ),
                    ['/pid', String(child.pid), '/T', '/F'],
                    {
                        timeout: 1_000,
                        killSignal: 'SIGKILL',
                        windowsHide: true
                    },
                    () => {
                        try {
                            child.kill('SIGKILL')
                        } catch {}
                    }
                )
            }
        }
        const stop = (reason: typeof failure): void => {
            failure ??= reason
            killOwned()
        }
        const abort = (): void => stop('aborted')
        const timer = setTimeout(() => stop('timeout'), PROBE_TIMEOUT_MS)
        signal?.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > MAX_OUTPUT_BYTES) stop('output_limit')
            else chunks.push(chunk)
        })
        child.on('error', () => {
            failure ??= 'failed'
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            if (grouped) killOwned()
            // Wait for close, rather than resolving from the timeout callback:
            // the owned child must be reaped and its pipes closed first.
            resolve(
                failure || code !== 0
                    ? { status: failure ?? 'failed', output: '' }
                    : {
                          status: 'ok',
                          output: Buffer.concat(chunks).toString('utf8')
                      }
            )
        })
    })

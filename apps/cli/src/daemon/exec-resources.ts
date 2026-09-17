import type { ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WINDOWS_EXEC_JOB_SCRIPT } from './windows-exec-job'

export const EXEC_TEMP_DIRECTORY_ENV = 'MF_EXEC_TEMP_DIR'

// Created by the long-lived exec owner, never supplied as a request path. That
// owner survives a Windows taskkill and releases resources before final ACK.
export async function createExecResources(cmd: string[], cwd: string) {
    const directory = await mkdtemp(join(tmpdir(), 'manyfold-exec-'))
    const cancel = join(directory, 'cancel'), receipt = join(directory, 'drained')
    let command = cmd
    try {
        await chmod(directory, 0o700)
        if (process.platform === 'win32') {
            const script = join(directory, 'owner.ps1'), spec = join(directory, 'command.json')
            await writeFile(script, WINDOWS_EXEC_JOB_SCRIPT, { mode: 0o600 })
            await writeFile(spec, JSON.stringify({ cmd, cwd, cancel, receipt }), { mode: 0o600 })
            command = [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, spec]
        }
    } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
    }
    let stopping: Promise<void> | null = null
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const killOwned = async (child: ChildProcess): Promise<void> => {
        if (!child.pid || child.pid === process.pid) return
        if (process.platform !== 'win32') {
            try {
                process.kill(-child.pid, 'SIGKILL')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                    throw error
            }
            const deadline = performance.now() + 2000
            while (true) {
                try { process.kill(-child.pid, 0) }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
                    // Darwin can briefly return EPERM while a killed group's
                    // remaining processes are being reaped. Only ESRCH proves
                    // drainage; permission denial consumes the same deadline.
                    if ((error as NodeJS.ErrnoException).code !== 'EPERM')
                        throw error
                }
                if (performance.now() >= deadline)
                    throw new Error('owned exec process group did not drain')
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            return
        }
        await writeFile(cancel, '', { mode: 0o600 })
        watchdog = setTimeout(() => { child.kill('SIGKILL') }, 5000)
        watchdog.unref()
    }
    return {
        directory,
        command,
        stop(child: ChildProcess): void {
            stopping ??= killOwned(child)
            void stopping.catch(() => {})
        },
        async release(child?: ChildProcess): Promise<{ setupFailed: boolean }> {
            if (stopping) await stopping
            if (watchdog) clearTimeout(watchdog)
            let setupFailed = false
            if (child?.pid && process.platform === 'win32') {
                const raw = await readFile(receipt, 'utf8').catch(() => null)
                const outcome = raw ? JSON.parse(raw) as { drained?: unknown; setupFailed?: unknown } : null
                if (outcome?.drained !== true || typeof outcome.setupFailed !== 'boolean')
                    throw new Error('Windows exec did not prove its owned job drained')
                setupFailed = outcome.setupFailed
            }
            // A detached exec owns its group even after the group leader exits.
            if (child && process.platform !== 'win32') await killOwned(child)
            await rm(directory, { recursive: true, force: true })
            return { setupFailed }
        }
    }
}

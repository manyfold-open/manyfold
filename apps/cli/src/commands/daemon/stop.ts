import type { Command } from 'commander'
import kleur from 'kleur'
import {
    clearDaemonPid,
    isProcessRunning,
    runningDaemonPid
} from '@/daemon/pid'
import {
    getInitUnitStatus,
    resolveScope,
    uninstallInitUnit,
    type Scope
} from '@/daemon/init-unit'

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) return true
        await sleep(200)
    }
    return false
}

export const registerDaemonStop = (program: Command): void => {
    program
        .command('stop')
        .description('Stop the Manyfold daemon and remove its autostart unit')
        .option(
            '--system',
            'target system scope (boot-time unit; needs root/sudo; default as root)'
        )
        .option(
            '--user',
            'target user scope (per-login unit; default as non-root)'
        )
        .action(async (options: { system?: boolean; user?: boolean }) => {
            const scope: Scope = resolveScope(options)
            const before = await getInitUnitStatus(scope)

            if (before.installed) {
                try {
                    await uninstallInitUnit({ scope })
                    console.log(
                        `${kleur.green('✓')} init unit removed (${scope} scope)`
                    )
                } catch (err) {
                    const msg = (err as Error).message
                    console.error(kleur.red(`uninstall failed: ${msg}`))
                    if (
                        scope === 'system' &&
                        /EACCES|permission|denied/i.test(msg)
                    ) {
                        console.error(
                            kleur.gray(
                                'hint: system scope requires sudo (`sudo mf daemon stop --system`)'
                            )
                        )
                    }
                }
            } else {
                console.log(
                    kleur.gray(`no ${scope}-scope init unit installed`)
                )
            }

            const pid = await runningDaemonPid()
            if (pid === null) {
                console.log(kleur.gray('daemon not running'))
                return
            }

            try {
                process.kill(pid, 'SIGTERM')
            } catch {}
            const exited = await waitForExit(pid, 5_000)
            if (!exited) {
                try {
                    process.kill(pid, 'SIGKILL')
                } catch {}
                console.log(
                    kleur.yellow(`force-killed daemon pid=${pid} after 5s`)
                )
            } else {
                console.log(
                    `${kleur.green('✓')} daemon stopped (was pid=${pid})`
                )
            }
            await clearDaemonPid(pid)
        })
}

import { stat } from 'node:fs/promises'
import type { Command } from 'commander'
import kleur from 'kleur'
import { daemonPaths } from '@/daemon/config'
import { followFile, readLastLines } from '@/daemon/log-file'

export const parseLineCount = (value: string): number => {
    if (!/^\d+$/.test(value))
        throw new Error('lines must be an integer greater than or equal to 0')
    const count = Number(value)
    if (!Number.isSafeInteger(count))
        throw new Error('lines must be an integer greater than or equal to 0')
    return count
}

export const registerDaemonLogs = (program: Command): void => {
    program
        .command('logs')
        .description('Tail the daemon log')
        .option('-f, --follow', 'follow log output')
        .option(
            '-n, --lines <count>',
            'number of lines to show',
            parseLineCount,
            50
        )
        .action(async (options: { follow?: boolean; lines: number }) => {
            let position = 0
            try {
                position = (await stat(daemonPaths.logPath)).size
                const tail = await readLastLines(
                    daemonPaths.logPath,
                    options.lines
                )
                process.stdout.write(tail)
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
                console.log(kleur.yellow('no log file yet'))
                if (!options.follow) return
            }
            if (!options.follow) return
            await followFile(daemonPaths.logPath, position, (data) => {
                process.stdout.write(data)
            })
        })
}

import type { Command } from 'commander'
import { registerDaemonRegister } from './register'
import { registerDaemonStart } from './start'
import { registerDaemonStatus } from './status'
import { registerDaemonStop } from './stop'
import { registerDaemonLogs } from './logs'
import { registerDaemonDoctor } from './doctor'

export const registerDaemon = (program: Command): void => {
    const daemon = program
        .command('daemon')
        .description(
            'Local daemon for Manyfold agents (claude-code / codex / gemini-cli)'
        )
    registerDaemonRegister(daemon)
    registerDaemonStart(daemon)
    registerDaemonStatus(daemon)
    registerDaemonStop(daemon)
    registerDaemonLogs(daemon)
    registerDaemonDoctor(daemon)
}

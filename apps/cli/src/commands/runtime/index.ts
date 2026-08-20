import type { Command } from 'commander'
import { registerRuntimeAgents } from '@/commands/runtime/agents'
import { registerRuntimeControlUi } from '@/commands/runtime/control-ui'
import { registerRuntimeDashboard } from '@/commands/runtime/dashboard'
import { registerRuntimeDelete } from '@/commands/runtime/delete'
import { registerRuntimeGet } from '@/commands/runtime/get'
import { registerRuntimeList } from '@/commands/runtime/list'

export const registerRuntime = (program: Command): void => {
    const cmd = program
        .command('runtime')
        .alias('agent-runtimes')
        .description('Manage agent runtimes (the sprite/pod shell)')
    registerRuntimeList(cmd, program)
    registerRuntimeGet(cmd, program)
    registerRuntimeDelete(cmd, program)
    registerRuntimeControlUi(cmd, program)
    registerRuntimeDashboard(cmd, program)
    registerRuntimeAgents(cmd, program)
}

import type { Command } from 'commander'
import { registerAgentCreate } from '@/commands/agent/create'
import { registerAgentCredentials } from '@/commands/agent/credentials'
import { registerAgentDelete } from '@/commands/agent/delete'
import { registerAgentDiag } from '@/commands/agent/diag'
import { registerAgentGet } from '@/commands/agent/get'
import { registerAgentList } from '@/commands/agent/list'
import { registerAgentModelConfig } from '@/commands/agent/model-config'
import { registerAgentUpdate } from '@/commands/agent/update'

export const registerAgent = (program: Command): void => {
    const cmd = program
        .command('agent')
        .alias('agents')
        .description('Manage agents')
    registerAgentList(cmd, program)
    registerAgentGet(cmd, program)
    registerAgentCreate(cmd, program)
    registerAgentUpdate(cmd, program)
    registerAgentDelete(cmd, program)
    registerAgentDiag(cmd, program)
    registerAgentModelConfig(cmd, program)
    registerAgentCredentials(cmd, program)
}

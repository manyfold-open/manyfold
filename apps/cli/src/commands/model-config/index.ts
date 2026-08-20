import type { Command } from 'commander'
import { addModelConfigCommands } from '@/commands/agent/model-config'

// Top-level `mf model-config` convenience subtree. Same as
// `mf agent model-config` but without the `agent` prefix.
export const registerModelConfig = (program: Command): void => {
    const cmd = program
        .command('model-config')
        .description('Read/update agent model configuration')
    addModelConfigCommands(cmd, program)
}

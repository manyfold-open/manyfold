import type { Command } from 'commander'
import { registerChannelsCreate } from './create'
import { registerChannelsDelete } from './delete'
import { registerChannelsGet } from './get'
import { registerChannelsList } from './list'
import { registerChannelsRegister } from './register'
import { registerChannelsSend } from './send'
import { registerChannelsSessions } from './sessions'
import { registerChannelsTest } from './test'
import { registerChannelsUpdate } from './update'

export const registerChannels = (program: Command): void => {
    const cmd = program
        .command('channels')
        .description('Manage agent channels (Telegram, Lark, Slack, etc.)')
    registerChannelsList(cmd, program)
    registerChannelsCreate(cmd, program)
    registerChannelsGet(cmd, program)
    registerChannelsUpdate(cmd, program)
    registerChannelsDelete(cmd, program)
    registerChannelsTest(cmd, program)
    registerChannelsRegister(cmd, program)
    registerChannelsSend(cmd, program)
    registerChannelsSessions(cmd, program)
}

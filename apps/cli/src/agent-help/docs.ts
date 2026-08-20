import type { AgentHelpTopic } from '@/agent-help/helpers'
import index from './index.md'
import auth from './auth.md'
import safety from './safety.md'
import channels from './channels.md'
import channelsCreate from './channels-create.md'
import channelsSend from './channels-send.md'
import automations from './automations.md'
import files from './files.md'
import modelConfig from './model-config.md'
import skills from './skills.md'
import connections from './connections.md'
import runtime from './runtime.md'
import agent from './agent.md'
import backups from './backups.md'
import usage from './usage.md'
import a2a from './a2a.md'

export const agentHelpDocs: Record<AgentHelpTopic, string> = {
    index,
    auth,
    safety,
    channels,
    'channels-create': channelsCreate,
    'channels-send': channelsSend,
    automations,
    files,
    'model-config': modelConfig,
    skills,
    connections,
    runtime,
    agent,
    backups,
    usage,
    a2a
}

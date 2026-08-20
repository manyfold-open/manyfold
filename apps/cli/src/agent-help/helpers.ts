import { grantableScopes } from '@manyfold/shared'
import { MF_CLI_VERSION } from '@/version'

export const AGENT_HELP_TOPICS = [
    'index',
    'auth',
    'safety',
    'channels',
    'channels-create',
    'channels-send',
    'automations',
    'files',
    'model-config',
    'skills',
    'connections',
    'runtime',
    'agent',
    'backups',
    'usage',
    'a2a'
] as const

export type AgentHelpTopic = (typeof AGENT_HELP_TOPICS)[number]

export const TOPIC_SUMMARIES: Record<AgentHelpTopic, string> = {
    index: 'entry guide: auth, topics, failure recovery',
    auth: 'login, scopes, consent URL, token safety',
    safety: 'hard rules: secrets, consent URL, scope grants',
    channels: 'Telegram, Slack, Discord, Lark channel management',
    'channels-create': 'creating a channel step by step',
    'channels-send': 'agent-initiated sends: DM, chat post, native reply',
    automations: 'scheduled jobs: create, run, update, delete',
    files: 'agent workspace files: list, read, write, mv, rm',
    'model-config': 'read or update the agent model configuration',
    skills: 'install, discover and manage agent skills',
    connections: 'external accounts (GitHub, Cloudflare, Composio) linked to the agent',
    runtime: 'runtime lifecycle, control UI, dashboard',
    agent: 'agent CRUD, storage, credentials, logs',
    backups: 'agent snapshots: list, create, restore',
    usage: 'token and cost statistics',
    a2a: 'call A2A servers or manage this agent’s A2A exposure and callers'
}

const TOPIC_ALIASES: Record<string, AgentHelpTopic> = {
    ensure: 'auth',
    'auth-ensure': 'auth',
    login: 'auth',
    whoami: 'auth',
    scopes: 'auth',
    channel: 'channels',
    automation: 'automations',
    agents: 'agent',
    'agent-runtimes': 'runtime',
    backup: 'backups'
}

const isAgentHelpTopic = (value: string): value is AgentHelpTopic =>
    (AGENT_HELP_TOPICS as readonly string[]).includes(value)

export const resolveAgentHelpTopic = (
    words: string[]
): AgentHelpTopic | null => {
    if (words.length === 0) return 'index'
    const slug = words.map((word) => word.toLowerCase()).join('-')
    if (isAgentHelpTopic(slug)) return slug
    return TOPIC_ALIASES[slug] ?? null
}

export const suggestAgentHelpTopics = (words: string[]): string[] => {
    const first = words[0]?.toLowerCase() ?? ''
    const matches = AGENT_HELP_TOPICS.filter((topic) => topic.startsWith(first))
    return matches.length > 0 ? [...matches] : [...AGENT_HELP_TOPICS]
}

const topicCommandLine = (topic: AgentHelpTopic): string => {
    if (topic === 'index') return 'mf help --agent'
    if (topic === 'channels-create') return 'mf help channels create --agent'
    if (topic === 'channels-send') return 'mf help channels send --agent'
    return `mf help ${topic} --agent`
}

const buildTopicList = (): string =>
    AGENT_HELP_TOPICS.map(
        (topic) =>
            `- \`${topicCommandLine(topic)}\` — ${TOPIC_SUMMARIES[topic]}`
    ).join('\n')

export const renderAgentHelp = (content: string): string => {
    const rendered = content
        .replaceAll('{{GRANTABLE_SCOPES}}', grantableScopes.join(', '))
        .replaceAll('{{TOPIC_LIST}}', buildTopicList())
    const unresolved = rendered.match(/\{\{[A-Z_]+\}\}/)
    if (unresolved)
        throw new Error(
            `agent help doc has unresolved placeholder ${unresolved[0]}`
        )
    return rendered
}

export interface AgentHelpEnvelope {
    topic: AgentHelpTopic
    cliVersion: string
    topics: string[]
    content: string
}

export const buildAgentHelpEnvelope = (
    topic: AgentHelpTopic,
    content: string
): AgentHelpEnvelope => ({
    topic,
    cliVersion: MF_CLI_VERSION,
    topics: [...AGENT_HELP_TOPICS],
    content
})

export interface SlashCommandArgSpec {
    name: string
    description: string
    required: boolean
}

export interface SlashCommandSpec {
    name: string
    usage: string
    description: string
    // 'agent' commands mutate agent-wide state (all sessions) and require
    // operator rights where a provider enforces an actor policy; 'session'
    // commands only affect the current chat scope's sessions.
    scope: 'agent' | 'session'
    helpLine?: string
    arg?: SlashCommandArgSpec
}

export const SLASH_COMMAND_SPECS: readonly SlashCommandSpec[] = [
    {
        name: 'new',
        usage: '/new [name]',
        description: 'start a new session (current becomes inactive)',
        scope: 'session',
        arg: { name: 'name', description: 'optional session name', required: false }
    },
    {
        name: 'list',
        usage: '/list [page]',
        description: 'show sessions in this chat',
        scope: 'session',
        arg: { name: 'page', description: 'page number', required: false }
    },
    {
        name: 'switch',
        usage: '/switch <number|name>',
        description: 'switch to another session',
        scope: 'session',
        arg: {
            name: 'target',
            description: 'session number or name',
            required: true
        }
    },
    {
        name: 'current',
        usage: '/current',
        description: 'show the active session',
        scope: 'session'
    },
    {
        name: 'rename',
        usage: '/rename [name]',
        description:
            'rename the active session; empty value clears the custom name',
        scope: 'session',
        arg: {
            name: 'name',
            description: 'new name (empty clears it)',
            required: false
        }
    },
    {
        name: 'delete',
        usage: '/delete <number|name>',
        description: 'delete a session',
        scope: 'session',
        arg: {
            name: 'target',
            description: 'session number or name',
            required: true
        }
    },
    {
        name: 'stop',
        usage: '/stop',
        description: 'stop the current response and discard queued messages',
        scope: 'session'
    },
    {
        name: 'model',
        usage: '/model [name]',
        description: 'show or change the agent model (applies to all sessions)',
        scope: 'agent',
        arg: {
            name: 'name',
            description: 'model to set (omit to show current + options)',
            required: false
        }
    },
    {
        name: 'usage',
        usage: '/usage',
        description: 'show token and cost usage for this session and agent',
        scope: 'session'
    },
    {
        name: 'history',
        usage: '/history',
        description: 'show the recent messages in the active session',
        scope: 'session'
    },
    {
        name: 'help',
        usage: '/help',
        description: 'show this command reference',
        scope: 'session',
        helpLine: 'this message'
    }
]

export const SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(
    SLASH_COMMAND_SPECS.map((spec) => spec.name)
)

const SLASH_COMMAND_SCOPE_BY_NAME: ReadonlyMap<string, 'agent' | 'session'> =
    new Map(SLASH_COMMAND_SPECS.map((spec) => [spec.name, spec.scope]))

// Unknown commands default to 'agent' (fail-safe): a name we don't recognize is
// never assumed to be a harmless session-scoped command.
export const slashCommandScope = (name: string): 'agent' | 'session' =>
    SLASH_COMMAND_SCOPE_BY_NAME.get(name) ?? 'agent'

export const buildHelpText = (): string =>
    [
        'Channel session commands:',
        ...SLASH_COMMAND_SPECS.map(
            (spec) => `${spec.usage} — ${spec.helpLine ?? spec.description}`
        )
    ].join('\n')

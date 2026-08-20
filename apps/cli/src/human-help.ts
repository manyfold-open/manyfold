import type { Command } from 'commander'

export interface HumanHelpGroup {
    title: string
    commands: readonly string[]
}

export const HUMAN_HELP_GROUPS: readonly HumanHelpGroup[] = [
    {
        title: 'Core commands',
        commands: [
            'setup',
            'login',
            'whoami',
            'agent',
            'runtime',
            'model-config'
        ]
    },
    {
        title: 'Workflow commands',
        commands: [
            'channels',
            'automations',
            'files',
            'backups',
            'skills',
            'usage',
            'connections',
            'a2a'
        ]
    },
    {
        title: 'Access and local tools',
        commands: ['auth', 'daemon', 'profile', 'update', 'help']
    }
] as const

const ROOT_EXAMPLES = [
    'mf setup',
    'mf login',
    'mf agent list',
    'mf runtime list',
    'mf daemon status',
    'mf <command> --help'
] as const

const ROOT_ENVIRONMENT = [
    ['MF_API_URL', 'override the Manyfold API URL'],
    ['MF_TOKEN', 'override the stored token; prefer --token - for stdin'],
    ['MF_AGENT_ID', 'set the default agent context'],
    ['MF_PROFILE', 'select a named CLI profile'],
    ['MF_HTTP_TIMEOUT', 'set the ordinary API request timeout (default: 30s)'],
    [
        'MF_DAEMON_AUTO_UPDATE',
        'force daemon auto-update on/off (default: on for the official API URL)'
    ]
] as const

const commandTerm = (command: Command): string =>
    [command.name(), ...command.aliases()].join('|')

const renderRows = (rows: ReadonlyArray<readonly [string, string]>): string => {
    const width = Math.max(...rows.map(([term]) => term.length))
    return rows
        .map(([term, description]) => `  ${term.padEnd(width)}  ${description}`)
        .join('\n')
}

export const renderGroupedRootHelp = (program: Command): string => {
    const byName = new Map(
        program.commands.map((command) => [command.name(), command])
    )
    const sections = HUMAN_HELP_GROUPS.map((group) => {
        const rows = group.commands.map((name) => {
            const command = byName.get(name)
            if (!command)
                throw new Error(
                    `human help group references unregistered command '${name}'`
                )
            return [commandTerm(command), command.description()] as const
        })
        return `${group.title}:\n${renderRows(rows)}`
    })

    return [
        ...sections,
        `Examples:\n${ROOT_EXAMPLES.map((example) => `  ${example}`).join('\n')}`,
        `Environment:\n${renderRows(ROOT_ENVIRONMENT)}`,
        'Learn more:\n  Run mf <command> --help for command-specific arguments and options.\n  Run mf help --agent for the agent operations guide.'
    ].join('\n\n')
}

export const configureHumanHelp = (program: Command): void => {
    // Keep Commander's usage, description, and options rendering. Only suppress
    // its flat root command list and replace it with product-owned groups.
    program.configureHelp({ visibleCommands: () => [] })
    program.addHelpText('after', () => `\n${renderGroupedRootHelp(program)}\n`)
}

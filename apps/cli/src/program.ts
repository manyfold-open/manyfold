import { Command } from 'commander'
import { registerAuth } from '@/commands/auth'
import { registerLogin } from '@/commands/login'
import { registerWhoami } from '@/commands/whoami'
import { registerAgent } from '@/commands/agent'
import { registerAutomations } from '@/commands/automations'
import { registerBackups } from '@/commands/backups'
import { registerChannels } from '@/commands/channels'
import { registerFiles } from '@/commands/files'
import { registerConnections } from '@/commands/connections'
import { registerHelp } from '@/commands/help'
import { registerModelConfig } from '@/commands/model-config'
import { registerProfile } from '@/commands/profile'
import { registerRuntime } from '@/commands/runtime'
import { registerSkills } from '@/commands/skills'
import { registerUsage } from '@/commands/usage'
import { registerA2a } from '@/commands/a2a'
import { registerDaemon } from '@/commands/daemon'
import { registerSetup } from '@/commands/setup'
import { registerUpdate } from '@/commands/update'
import { configureHumanHelp } from '@/human-help'
import { resolveProfile, setProfileFlag } from '@/config'
import { MF_CLI_VERSION } from '@/version'

export const buildProgram = (): Command => {
    const program = new Command()

    program
        .name('mf')
        .description('Manyfold CLI')
        .version(MF_CLI_VERSION)
        .option(
            '--profile <name>',
            'CLI profile: separate credentials and daemon state per environment (env: MF_PROFILE)'
        )
        .option('--api-url <url>', 'API base URL', process.env.MF_API_URL)
        .option(
            '--token <token>',
            'API token override ("-" reads stdin; direct values may appear in shell history and process lists)',
            process.env.MF_TOKEN
        )
        .option(
            '--agent-id <id>',
            'agent context: default agent for agent-scoped commands, accepted before or after the subcommand (env: MF_AGENT_ID)',
            process.env.MF_AGENT_ID
        )
        .option(
            '--account',
            'act at account scope: operate across the current account instead of only the current agent (default). Requires user-granted permission; without it the command stays scoped to the current agent.'
        )

    // The flag must reach @/config before any action touches a profile path;
    // resolving here also fails fast on an invalid --profile / MF_PROFILE.
    program.hook('preAction', () => {
        setProfileFlag(program.opts<{ profile?: string }>().profile)
        resolveProfile()
    })

    registerAuth(program)
    registerSetup(program)
    registerLogin(program)
    registerWhoami(program)
    registerAgent(program)
    registerAutomations(program)
    registerBackups(program)
    registerChannels(program)
    registerFiles(program)
    registerConnections(program)
    registerModelConfig(program)
    registerRuntime(program)
    registerSkills(program)
    registerUsage(program)
    registerA2a(program)
    registerDaemon(program)
    registerProfile(program)
    registerUpdate(program)
    registerHelp(program)
    configureHumanHelp(program)

    return program
}

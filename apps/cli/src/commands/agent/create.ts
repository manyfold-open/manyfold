import { Option, type Command } from 'commander'
import kleur from 'kleur'
import {
    isPiProvider,
    isRuntimeAuthProfileFramework,
    managedChannelFor,
    providerRowVerdict,
    runtimeSignInCommandFor,
    type AgentCreateEvent,
    type AgentRuntimeSummary,
    type AgentSummary,
    type CreateAgentBody,
    type SandboxSummary,
    type UserModelProviderSummary
} from '@manyfold/shared'
import { ApiError, type NcaClient } from '@manyfold/sdk'
import { buildClient } from '@/client'
import { emit } from '@/output'
import { resolveSecretInput } from '@/secret-input'
import { createProgress } from '@/commands/agent/create-progress'
import {
    bindSource,
    CREATE_FRAMEWORKS,
    resolveModelSource,
    resolveSandboxRef,
    runtimeToJoin,
    UsageError,
    type CreateFramework,
    type ModelSource
} from '@/commands/agent/create-source'

interface CreateOptions {
    framework: CreateFramework
    modelProvider?: string
    model?: string
    sandbox?: string
    anthropicAuthToken?: string
    anthropicBaseUrl?: string
    openaiApiKey?: string
    openaiBaseUrl?: string
    googleApiKey?: string
    googleGeminiBaseUrl?: string
    piApiKey?: string
    piProvider?: string
    piBaseUrl?: string
    runtimeProvider?: string
    json?: boolean
}

type KeyOption = Extract<
    keyof CreateOptions,
    | 'anthropicAuthToken'
    | 'anthropicBaseUrl'
    | 'openaiApiKey'
    | 'openaiBaseUrl'
    | 'googleApiKey'
    | 'googleGeminiBaseUrl'
    | 'piApiKey'
    | 'piProvider'
    | 'piBaseUrl'
>

interface KeyFlag {
    option: KeyOption
    flag: string
    frameworks: readonly CreateFramework[]
    // The shell variable older releases read it from.
    env?: string
}

// The key itself for each framework, then what may ride along with it.
const KEYS: Record<CreateFramework, KeyFlag> = {
    'claude-code': {
        option: 'anthropicAuthToken',
        flag: '--anthropic-auth-token',
        frameworks: ['claude-code'],
        env: 'ANTHROPIC_AUTH_TOKEN'
    },
    codex: {
        option: 'openaiApiKey',
        flag: '--openai-api-key',
        frameworks: ['codex'],
        env: 'OPENAI_API_KEY'
    },
    'gemini-cli': {
        option: 'googleApiKey',
        flag: '--google-api-key',
        frameworks: ['gemini-cli', 'antigravity-cli'],
        env: 'GEMINI_API_KEY'
    },
    'antigravity-cli': {
        option: 'googleApiKey',
        flag: '--google-api-key',
        frameworks: ['gemini-cli', 'antigravity-cli'],
        env: 'GEMINI_API_KEY'
    },
    pi: {
        option: 'piApiKey',
        flag: '--pi-api-key',
        frameworks: ['pi'],
        env: 'PI_API_KEY'
    }
}

const KEY_EXTRAS: readonly KeyFlag[] = [
    {
        option: 'anthropicBaseUrl',
        flag: '--anthropic-base-url',
        frameworks: ['claude-code']
    },
    {
        option: 'openaiBaseUrl',
        flag: '--openai-base-url',
        frameworks: ['codex']
    },
    {
        option: 'googleGeminiBaseUrl',
        flag: '--google-gemini-base-url',
        frameworks: ['gemini-cli', 'antigravity-cli']
    },
    { option: 'piProvider', flag: '--pi-provider', frameworks: ['pi'] },
    { option: 'piBaseUrl', flag: '--pi-base-url', frameworks: ['pi'] }
]

const ALL_KEY_FLAGS: readonly KeyFlag[] = [
    ...new Map(
        [...Object.values(KEYS), ...KEY_EXTRAS].map((flag) => [
            flag.option,
            flag
        ])
    ).values()
]

// Older releases also read these; say so when one is set, since a create
// that used to pick it up now stops at the usage error instead.
const LEGACY_KEY_ENV = [
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'PI_API_KEY'
]

// How often a dropped stream is picked up again, and how long a stream may
// stay silent (the API sends a keepalive every 15 s) before it counts as
// dropped.
const REATTACHES = 3
const IDLE_MS = 60_000

type SourceReport =
    | {
          kind: 'managed' | 'provider'
          providerId: string
          providerName: string
          model: string | null
          // The provider's id for `model`, where that is an alias.
          providerModel: string | null
      }
    | { kind: 'key'; model: string | null }
    | { kind: 'subscription'; authProfileId: string | null }
    | { kind: 'inherited' }

export const registerAgentCreate = (cmd: Command, program: Command): void => {
    const create = cmd
        .command('create <name>')
        .description(
            'Create a coding agent on a new sandbox, or add one to a sandbox you have'
        )
        .addOption(
            new Option('--framework <framework>', 'coding framework')
                .choices(CREATE_FRAMEWORKS)
                .default('claude-code')
        )
        .option(
            '--model-provider <source>',
            'who serves the model: managed | subscription | a saved provider id or name (mf model-providers list)'
        )
        .option(
            '--model <model>',
            "model to run, from the provider's tested models; with a pasted key only for gemini-cli, pi and antigravity-cli"
        )
        .option(
            '--sandbox <sandbox>',
            'add the agent to this sandbox (id or name, mf sandbox list) instead of creating one'
        )
        .option(
            '--anthropic-auth-token <token>',
            'Anthropic key for claude-code; "-" reads it from stdin'
        )
        .option(
            '--anthropic-base-url <url>',
            'Anthropic base URL override (claude-code)'
        )
        .option(
            '--openai-api-key <key>',
            'OpenAI key for codex; "-" reads it from stdin'
        )
        .option('--openai-base-url <url>', 'OpenAI base URL override (codex)')
        .option(
            '--google-api-key <key>',
            'Gemini key for gemini-cli and antigravity-cli; "-" reads it from stdin'
        )
        .option(
            '--google-gemini-base-url <url>',
            'Gemini base URL override (gemini-cli, antigravity-cli)'
        )
        .option(
            '--pi-api-key <key>',
            'vendor key for pi, with --pi-provider; "-" reads it from stdin'
        )
        .option(
            '--pi-provider <provider>',
            'the vendor the pi key belongs to: anthropic | openai | google'
        )
        .option('--pi-base-url <url>', 'vendor base URL override for pi')
        .option(
            '--runtime-provider <id>',
            'admin only: the runtime provider a new sandbox is placed on'
        )
        .option('--json', 'output the result as JSON', false)
    create.action(async (name: string, opts: CreateOptions) => {
        try {
            await runCreate(program, name, opts)
        } catch (err) {
            if (err instanceof UsageError) create.error(`error: ${err.message}`)
            throw err
        }
    })
}

const runCreate = async (
    program: Command,
    name: string,
    opts: CreateOptions
): Promise<void> => {
    const global = program.opts<{ apiUrl?: string; token?: string }>()
    const framework = opts.framework
    const keyFlag = KEYS[framework]
    for (const flag of ALL_KEY_FLAGS)
        if (
            opts[flag.option] !== undefined &&
            !flag.frameworks.includes(framework)
        )
            throw new UsageError(
                `${flag.flag} is for ${flag.frameworks.join(' and ')}, not ${framework}`
            )
    const hasKey = opts[keyFlag.option] !== undefined
    const extra = KEY_EXTRAS.find((flag) => opts[flag.option] !== undefined)
    if (extra && !hasKey)
        throw new UsageError(`${extra.flag} goes with ${keyFlag.flag}`)
    if (hasKey && opts.modelProvider)
        throw new UsageError(
            `pass either --model-provider or ${keyFlag.flag}, not both`
        )
    if (opts.piProvider !== undefined && !isPiProvider(opts.piProvider))
        throw new UsageError('--pi-provider takes anthropic, openai or google')
    if (opts.runtimeProvider && opts.sandbox)
        throw new UsageError(
            '--runtime-provider places a new sandbox; leave it out with --sandbox'
        )
    // "-" reads the key from stdin, which works only piped, and only once.
    if (opts[keyFlag.option]?.trim() === '-') {
        if (global.token?.trim() === '-')
            throw new UsageError(
                `${keyFlag.flag} - and --token - both read stdin; pass one of them another way`
            )
        if (process.stdin.isTTY)
            throw new UsageError(
                `${keyFlag.flag} - reads the key from stdin; pipe it in, for example: printenv ${keyFlag.env} | mf agent create …`
            )
    }

    const { client } = await buildClient(global)
    const body: CreateAgentBody = { name, framework, runtime: 'sprites' }
    if (opts.runtimeProvider) body.providerId = opts.runtimeProvider

    let sandbox: SandboxSummary | null = null
    let joining: AgentRuntimeSummary | null = null
    if (opts.sandbox) {
        const [sandboxes, runtimes] = await Promise.all([
            client.sandboxes.list(),
            client.agentRuntimes.list()
        ])
        sandbox = resolveSandboxRef(sandboxes, opts.sandbox)
        if (sandbox.status !== 'ready')
            throw new Error(
                `sandbox ${sandbox.name} is ${sandbox.status}; mf sandbox list shows its state`
            )
        joining = runtimeToJoin(runtimes, sandbox, framework)
        body.sandboxId = sandbox.id
    }

    let report: SourceReport
    if (joining && sandbox) {
        // Credentials belong to the framework's instance on the sandbox, so
        // an agent joining it takes what is there; a subscription is the one
        // choice made per agent.
        if (
            hasKey ||
            (opts.modelProvider && opts.modelProvider !== 'subscription')
        )
            throw new UsageError(
                `an agent added to ${sandbox.name} uses the ${framework} credentials already there, which every agent on it shares: leave out ${hasKey ? keyFlag.flag : '--model-provider'}, or change them for all of them after the create with mf agent credentials update <agent-id>`
            )
        if (opts.model)
            throw new UsageError(
                `--model does not apply to an agent joining ${sandbox.name}; set it after the create with mf model-config update <agent-id> --model <model>`
            )
        if (opts.modelProvider === 'subscription') {
            const authProfileId = await defaultAuthProfile(client, joining)
            body.modelConfigSource = 'runtime-local'
            if (authProfileId) body.runtimeAuthProfileId = authProfileId
            report = { kind: 'subscription', authProfileId }
        } else report = { kind: 'inherited' }
    } else {
        const source = await chooseSource(client, name, opts)
        const bound = bindSource(framework, source, opts.model)
        Object.assign(body, bound.fields)
        report =
            source.kind === 'managed' || source.kind === 'provider'
                ? {
                      kind: source.kind,
                      providerId: source.row.id,
                      providerName: source.row.providerName,
                      model: bound.model,
                      providerModel: bound.providerModel
                  }
                : source.kind === 'key'
                  ? { kind: 'key', model: bound.model }
                  : { kind: 'subscription', authProfileId: null }
    }

    const { agent, rerun } = await streamCreate(client, body, opts)
    const chatUrl = await chatLink(client, agent.id)
    const signInCommand =
        report.kind === 'subscription' && !report.authProfileId
            ? runtimeSignInCommandFor(framework)
            : null
    const extras = {
        resumed: rerun,
        sandbox: {
            id: agent.hostId,
            name: agent.hostName,
            created: sandbox === null
        },
        modelSource: report,
        chatUrl,
        signInCommand
    }
    emit(opts, { ...agent, create: extras }, () => {
        if (rerun)
            console.log(
                kleur.dim(
                    `This run picked up the create of ${agent.name} that was already under way.`
                )
            )
        console.log(
            `${kleur.green('✓')} ${kleur.cyan(agent.name)} (${agent.id})  ${agent.framework}  ${agent.status}`
        )
        if (agent.hostId)
            console.log(
                `  sandbox  ${agent.hostName ?? agent.hostId} (${agent.hostId}), ${sandbox ? 'existing' : 'new'}`
            )
        console.log(`  model    ${describeSource(report, framework)}`)
        if (chatUrl) console.log(`  chat     ${chatUrl}`)
        if (report.kind === 'subscription' && signInCommand) {
            console.log('')
            console.log(
                joining
                    ? `If the sandbox is not signed in to your subscription yet, open the chat and follow its sign-in card, or run this in the sandbox's terminal:`
                    : `Next, sign in to your subscription on the sandbox: open the chat and follow its sign-in card, or run this in the sandbox's terminal:`
            )
            console.log(`  ${signInCommand}`)
        }
    })
}

// A new agent needs to be told who serves its model; saying nothing is a
// usage error that lists the choices this account has.
const chooseSource = async (
    client: NcaClient,
    name: string,
    opts: CreateOptions
): Promise<ModelSource> => {
    const framework = opts.framework
    const keyFlag = KEYS[framework]
    const pasted = opts[keyFlag.option]
    if (pasted !== undefined)
        return {
            kind: 'key',
            key: {
                key: readKey(keyFlag, pasted),
                baseUrl: KEY_EXTRAS.filter(
                    (flag) =>
                        flag.option !== 'piProvider' &&
                        flag.frameworks.includes(framework)
                )
                    .map((flag) => opts[flag.option])
                    .find((value) => value !== undefined),
                ...(isPiProvider(opts.piProvider)
                    ? { piProvider: opts.piProvider }
                    : {})
            }
        }
    const ref = opts.modelProvider
    if (ref === 'subscription') return { kind: 'subscription' }
    const providers = await client.modelProviders.list()
    if (ref) return resolveModelSource(framework, ref, providers)
    throw new UsageError(noSourceMessage(name, framework, providers))
}

const noSourceMessage = (
    name: string,
    framework: CreateFramework,
    providers: readonly UserModelProviderSummary[]
): string => {
    const keyFlag = KEYS[framework]
    const saved = providers.filter(
        (row) =>
            row.source !== 'managed' &&
            providerRowVerdict(framework, row) === 'usable'
    )
    const choices: Array<[string, string]> = []
    if (managedChannelFor(framework, providers))
        choices.push(['--model-provider managed', 'Manyfold managed models'])
    choices.push([
        '--model-provider subscription',
        'your own subscription, signed in on the sandbox after the create'
    ])
    choices.push([
        '--model-provider <id|name>',
        saved.length > 0
            ? `a saved provider: ${saved.map((row) => `${row.providerName} (${row.id})`).join(', ')}`
            : 'a saved provider (mf model-providers list)'
    ])
    choices.push([`${keyFlag.flag} -`, 'your own key, read from stdin'])
    const width = Math.max(...choices.map(([flag]) => flag.length))
    const lines = [
        `say who serves ${framework}'s model:`,
        ...choices.map(([flag, what]) => `  ${flag.padEnd(width)}  ${what}`)
    ]
    const set = LEGACY_KEY_ENV.find((env) => process.env[env])
    if (set)
        lines.push(
            `${set} is set in this shell, but mf no longer reads keys from the environment. To use it: printenv ${set} | mf agent create ${name} --framework ${framework} ${keyFlag.flag} -`
        )
    return lines.join('\n')
}

const readKey = (flag: KeyFlag, value: string): string => {
    const key = resolveSecretInput(value, flag.flag)
    if (!key) throw new UsageError(`${flag.flag} is empty`)
    return key
}

// The sandbox's default sign-in for this framework, for the joining agent to
// use. Null when there is none to name (never signed in, or asleep and not
// woken for this), which leaves the agent on the machine's own sign-in.
const defaultAuthProfile = async (
    client: NcaClient,
    runtime: AgentRuntimeSummary
): Promise<string | null> => {
    if (!isRuntimeAuthProfileFramework(runtime.framework)) return null
    try {
        const view = await client.runtimeAuth.list(runtime.id)
        return view.availability === 'ok' ? view.defaultProfileId : null
    } catch {
        return null
    }
}

// The API never answered (a proxy or a restart in between), or the stream
// broke: pick the create up again. Anything the API itself answered is the
// create's outcome.
const reattachable = (err: unknown): boolean =>
    !(err instanceof ApiError) ||
    ([502, 503, 504].includes(err.status) && err.serverMessage === undefined)

const streamCreate = async (
    client: NcaClient,
    body: CreateAgentBody,
    opts: { json?: boolean }
): Promise<{ agent: AgentSummary; rerun: boolean }> => {
    const progress = createProgress({
        write: (line) => console.error(line),
        tty: process.stderr.isTTY === true
    })
    let requestId: string | null = null
    let resumed = false
    const onEvent = (event: AgentCreateEvent): void => {
        if (event.type === 'step') progress.step(event.step)
        if (event.type === 'complete' && event.resumed) resumed = true
    }
    // The create runs on the server whether or not anyone watches it, so a
    // Ctrl-C only stops the watching; the same command picks it up again.
    const interrupt = (): void => {
        progress.end('stopped')
        const message = requestId
            ? 'Stopped watching. The create goes on on the server: run the same command again to pick it up.'
            : 'Stopped watching. The create may go on on the server: check mf agent list before running it again.'
        const line = opts.json
            ? JSON.stringify({ error: { code: 'interrupted', message } })
            : kleur.yellow(message)
        process.stderr.write(`${line}\n`, () => process.exit(130))
    }
    process.once('SIGINT', interrupt)
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                const agent = await client.agents.createStream(body, onEvent, {
                    idleTimeoutMs: IDLE_MS,
                    ...(requestId ? { resume: requestId } : {}),
                    onAccepted: (id) => {
                        requestId = id ?? requestId
                    }
                })
                progress.end('done')
                return { agent, rerun: resumed && attempt === 0 }
            } catch (err) {
                if (!requestId || attempt >= REATTACHES || !reattachable(err)) {
                    progress.end('failed')
                    throw err
                }
                console.error(
                    kleur.yellow(
                        `  lost the connection to the create; picking it up again (${attempt + 1}/${REATTACHES})`
                    )
                )
                await new Promise((resolve) =>
                    setTimeout(resolve, 1_000 * (attempt + 1))
                )
            }
        }
    } finally {
        process.removeListener('SIGINT', interrupt)
    }
}

// Where the agent's chat lives in the web app, as this deployment names its
// own address; null when the API does not say.
const chatLink = async (
    client: NcaClient,
    agentId: string
): Promise<string | null> => {
    try {
        const { branding } = await client.config.capabilities()
        if (!branding?.webBaseUrl) return null
        return `${branding.webBaseUrl.replace(/\/+$/, '')}/agents/${encodeURIComponent(agentId)}/chat`
    } catch {
        return null
    }
}

const describeSource = (
    report: SourceReport,
    framework: CreateFramework
): string => {
    if (report.kind === 'inherited')
        return `shared with the other ${framework} agents on this sandbox`
    if (report.kind === 'subscription')
        return report.authProfileId
            ? "your own subscription, the sandbox's default sign-in"
            : 'your own subscription, through its sign-in on the sandbox'
    const pinned =
        report.kind !== 'key' &&
        report.providerModel &&
        report.providerModel !== report.model
            ? ` (${report.providerModel})`
            : ''
    const model = report.model ? `, ${report.model}${pinned}` : ''
    if (report.kind === 'key') return `your own key${model}`
    if (report.kind === 'managed')
        return `Manyfold managed (${report.providerName})${model}`
    return `${report.providerName}${model}`
}

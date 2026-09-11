import type { Command } from 'commander'
import kleur from 'kleur'
import { isPiProvider, type CreateAgentBody } from '@manyfold/shared'
import { buildClient } from '@/client'
import { emit } from '@/output'

interface CreateOptions {
    framework: 'claude-code' | 'codex' | 'gemini-cli' | 'pi'
    anthropicAuthToken?: string
    anthropicBaseUrl?: string
    openaiApiKey?: string
    openaiBaseUrl?: string
    googleApiKey?: string
    googleGeminiBaseUrl?: string
    geminiModel?: string
    piApiKey?: string
    piProvider?: string
    piBaseUrl?: string
    piModel?: string
    accountId?: string
    json?: boolean
}

export const registerAgentCreate = (cmd: Command, program: Command): void => {
    cmd.command('create <name>')
        .description('Create a new agent on sprites.dev')
        .option(
            '--framework <framework>',
            'claude-code | codex | gemini-cli | pi',
            'claude-code'
        )
        .option(
            '--anthropic-auth-token <token>',
            'Anthropic auth token (claude-code only; or env ANTHROPIC_AUTH_TOKEN)'
        )
        .option(
            '--anthropic-base-url <url>',
            'Anthropic base URL override (claude-code only)'
        )
        .option(
            '--openai-api-key <key>',
            'OpenAI API key (codex only; or env OPENAI_API_KEY)'
        )
        .option(
            '--openai-base-url <url>',
            'OpenAI base URL override (codex only)'
        )
        .option(
            '--google-api-key <key>',
            'Gemini API key (gemini-cli only; or env GEMINI_API_KEY / GOOGLE_API_KEY)'
        )
        .option(
            '--google-gemini-base-url <url>',
            'Gemini base URL override (gemini-cli only; or env GOOGLE_GEMINI_BASE_URL)'
        )
        .option(
            '--gemini-model <model>',
            'Gemini model override (gemini-cli only)'
        )
        .option(
            '--pi-api-key <key>',
            'Vendor API key for pi (pi only; pair with --pi-provider)'
        )
        .option(
            '--pi-provider <provider>',
            'Which vendor the pi key belongs to: anthropic | openai | google (pi only)'
        )
        .option(
            '--pi-base-url <url>',
            'Vendor base URL override for pi (pi only; sandbox runtimes only)'
        )
        .option(
            '--pi-model <model>',
            'pi default model, e.g. anthropic/claude-sonnet-4-6 (pi only)'
        )
        .option(
            '--account-id <id>',
            'Admin only: pin to a specific sprites.dev account id'
        )
        .option('--json', 'output the result as JSON', false)
        .action(async (name: string, opts: CreateOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const body = buildBody(name, opts)
            // Provisioning blocks for minutes (sprite boot + framework
            // install), far past the CLI transport's default request timeout.
            // The NDJSON stream is exempt from that timeout and is the same
            // path web/admin use; progress goes to stderr so --json stdout
            // stays a single parseable payload.
            const res = await client.agents.createStream(body, (event) => {
                if (event.type === 'step')
                    console.error(
                        kleur.dim(
                            `  [${event.index + 1}/${event.total}] ${event.step}`
                        )
                    )
            })
            emit(opts, res, () => {
                console.log(
                    `${res.id}  ${kleur.cyan(res.name)}  ${kleur.yellow(res.framework)}/${res.runtime}  ${res.status}`
                )
                if (res.spriteName)
                    console.log(kleur.dim(`  sprite: ${res.spriteName}`))
                if (res.accountSlug)
                    console.log(kleur.dim(`  account: ${res.accountSlug}`))
            })
        })
}

const buildBody = (name: string, opts: CreateOptions): CreateAgentBody => {
    const framework = opts.framework
    if (framework === 'claude-code') {
        const token =
            opts.anthropicAuthToken ?? process.env.ANTHROPIC_AUTH_TOKEN
        if (!token)
            throw new Error(
                'Claude Code requires --anthropic-auth-token or ANTHROPIC_AUTH_TOKEN'
            )
        return {
            name,
            framework: 'claude-code',
            accountId: opts.accountId,
            claudeCodeCredentials: {
                anthropicAuthToken: token,
                anthropicBaseUrl:
                    opts.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL
            }
        }
    }
    if (framework === 'gemini-cli') {
        const key =
            opts.googleApiKey ??
            process.env.GEMINI_API_KEY ??
            process.env.GOOGLE_API_KEY
        if (!key)
            throw new Error(
                'Gemini CLI requires --google-api-key, GEMINI_API_KEY, or GOOGLE_API_KEY'
            )
        return {
            name,
            framework: 'gemini-cli',
            accountId: opts.accountId,
            geminiCliCredentials: {
                googleApiKey: key,
                googleGeminiBaseUrl:
                    opts.googleGeminiBaseUrl ??
                    process.env.GOOGLE_GEMINI_BASE_URL,
                model: opts.geminiModel ?? process.env.GEMINI_MODEL
            }
        }
    }
    if (framework === 'pi') {
        const provider = opts.piProvider
        if (!isPiProvider(provider))
            throw new Error(
                'pi requires --pi-provider anthropic | openai | google'
            )
        const key = opts.piApiKey ?? process.env.PI_API_KEY
        if (!key) throw new Error('pi requires --pi-api-key or PI_API_KEY')
        return {
            name,
            framework: 'pi',
            accountId: opts.accountId,
            piCredentials: {
                apiKey: key,
                provider,
                baseUrl: opts.piBaseUrl,
                model: opts.piModel ?? null
            }
        }
    }
    const key = opts.openaiApiKey ?? process.env.OPENAI_API_KEY
    if (!key)
        throw new Error('Codex requires --openai-api-key or OPENAI_API_KEY')
    return {
        name,
        framework: 'codex',
        accountId: opts.accountId,
        codexCredentials: {
            openaiApiKey: key,
            openaiBaseUrl: opts.openaiBaseUrl ?? process.env.OPENAI_BASE_URL
        }
    }
}

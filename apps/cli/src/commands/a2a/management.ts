import type { Command } from 'commander'
import kleur from 'kleur'
import type { AddA2aSelfCallerBody, A2aGrantSummary } from '@manyfold/shared'
import {
    addSelfCaller,
    fetchSelfCallers,
    fetchSelfExposure,
    revokeSelfCaller,
    setSelfExposure,
    type GlobalAuthOpts
} from '@/commands/a2a/self'

interface JsonOpts {
    json?: boolean
}

interface AddCallerOpts extends JsonOpts {
    external?: boolean
    callerAgentId?: string
    name?: string
    expiresInDays?: string
    replaceExisting?: boolean
}

interface RevokeCallerOpts extends JsonOpts {
    yes?: boolean
}

export const parseExpiresInDays = (
    value: string | undefined
): number | undefined => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error('--expires-in-days must be a positive integer')
    return parsed
}

export const buildAddCallerBody = (
    opts: AddCallerOpts
): AddA2aSelfCallerBody => {
    const callerAgentId = opts.callerAgentId?.trim()
    const selected =
        Number(opts.external === true) + Number(Boolean(callerAgentId))
    if (selected !== 1)
        throw new Error(
            'pass exactly one of --external or --caller-agent-id <id>'
        )
    const expiresInDays = parseExpiresInDays(opts.expiresInDays)
    if (opts.external) {
        if (opts.replaceExisting)
            throw new Error(
                '--replace-existing is only valid with --caller-agent-id'
            )
        return {
            kind: 'external',
            name: opts.name?.trim() || undefined,
            expiresInDays
        }
    }
    if (opts.name !== undefined)
        throw new Error('--name is only valid with --external')
    return {
        kind: 'peer',
        callerAgentId: callerAgentId as string,
        expiresInDays,
        replaceExisting: opts.replaceExisting === true
    }
}

const printExposure = (
    exposure: Awaited<ReturnType<typeof fetchSelfExposure>>
): void => {
    console.log(
        `${exposure.agentId}  ${
            exposure.enabled ? kleur.green('enabled') : kleur.dim('disabled')
        }`
    )
    console.log(kleur.dim(`  card: ${exposure.cardUrl}`))
    console.log(kleur.dim(`  rpc:  ${exposure.rpcUrl}`))
}

const runExposure = async (
    program: Command,
    opts: JsonOpts,
    enabled?: boolean
): Promise<void> => {
    const global = program.opts<GlobalAuthOpts>()
    const exposure =
        enabled === undefined
            ? await fetchSelfExposure(global)
            : await setSelfExposure(global, enabled)
    if (opts.json) {
        console.log(JSON.stringify(exposure, null, 2))
        return
    }
    printExposure(exposure)
}

const callerStatus = (caller: A2aGrantSummary): string => {
    if (!caller.expiresAt) return kleur.dim('never expires')
    const expired = new Date(caller.expiresAt).getTime() <= Date.now()
    return expired
        ? kleur.red(`expired ${caller.expiresAt}`)
        : kleur.dim(`expires ${caller.expiresAt}`)
}

const printCaller = (caller: A2aGrantSummary): void => {
    const kind = caller.callerAgentId ? 'peer' : 'external'
    const label = caller.callerAgentId
        ? (caller.callerAgentName ?? caller.callerAgentId)
        : (caller.name ?? 'External client')
    console.log(
        `${caller.tokenId}  ${kleur.yellow(kind)}  ${kleur.cyan(label)}  ${callerStatus(caller)}`
    )
}

export const registerA2aManagement = (a2a: Command, program: Command): void => {
    const exposure = a2a
        .command('exposure')
        .description("Manage this agent's hosted A2A exposure")

    exposure
        .command('get')
        .description('Show hosted A2A exposure and public endpoints')
        .option('--json', 'emit JSON', false)
        .action((opts: JsonOpts) => runExposure(program, opts))

    exposure
        .command('enable')
        .description('Expose this agent as an A2A server')
        .option('--json', 'emit JSON', false)
        .action((opts: JsonOpts) => runExposure(program, opts, true))

    exposure
        .command('disable')
        .description('Stop exposing this agent as an A2A server')
        .option('--json', 'emit JSON', false)
        .action((opts: JsonOpts) => runExposure(program, opts, false))

    const callers = a2a
        .command('callers')
        .description('Manage callers authorized to invoke this agent')

    callers
        .command('list')
        .description('List peer and external callers')
        .option('--json', 'emit JSON', false)
        .action(async (opts: JsonOpts) => {
            const rows = await fetchSelfCallers(program.opts<GlobalAuthOpts>())
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 2))
                return
            }
            if (rows.length === 0) {
                console.error(kleur.dim('no A2A callers'))
                return
            }
            for (const row of rows) printCaller(row)
        })

    callers
        .command('add')
        .description('Add an external client or peer agent caller')
        .option('--external', 'create an External client bearer', false)
        .option('--caller-agent-id <id>', 'authorize a Manyfold peer agent')
        .option('--name <name>', 'External client label')
        .option(
            '--expires-in-days <days>',
            'positive integer; omit for no expiry'
        )
        .option(
            '--replace-existing',
            'replace an existing grant for the peer agent',
            false
        )
        .option(
            '--json',
            'emit JSON (includes a new External client token)',
            false
        )
        .action(async (opts: AddCallerOpts) => {
            const result = await addSelfCaller(
                program.opts<GlobalAuthOpts>(),
                buildAddCallerBody(opts)
            )
            if (opts.json) {
                console.log(JSON.stringify(result, null, 2))
                return
            }
            if (result.kind === 'peer') {
                console.log(
                    `${result.tokenId}  ${kleur.green('authorized')}  ${result.callerAgentId} → ${result.agentId}`
                )
                return
            }
            console.error(
                kleur.yellow(
                    'Copy this bearer token now. It is shown once and must not be pasted into chat or logs.'
                )
            )
            console.error(kleur.dim(`token id: ${result.tokenId}`))
            console.error(kleur.dim(`card: ${result.cardUrl}`))
            console.error(kleur.dim(`rpc:  ${result.rpcUrl}`))
            console.error(
                kleur.dim(
                    result.expiresAt
                        ? `expires: ${result.expiresAt}`
                        : 'expires: never'
                )
            )
            console.log(result.token)
        })

    callers
        .command('revoke <tokenId>')
        .description('Revoke an A2A caller grant')
        .option('-y, --yes', 'confirm revocation', false)
        .option('--json', 'emit JSON', false)
        .action(async (tokenId: string, opts: RevokeCallerOpts) => {
            if (!opts.yes)
                throw new Error(
                    `refusing to revoke ${tokenId} without --yes (or -y)`
                )
            await revokeSelfCaller(program.opts<GlobalAuthOpts>(), tokenId)
            if (opts.json) {
                console.log(JSON.stringify({ ok: true, id: tokenId }, null, 2))
                return
            }
            console.error(kleur.green(`✓ revoked A2A caller ${tokenId}`))
        })
}

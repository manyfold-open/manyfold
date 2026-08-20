import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    AutomationSchedulePreset,
    AutomationStatus,
    CreateAutomationBody,
    UpdateAutomationBody
} from '@manyfold/shared'

import { resolveAgentId, resolveOptionalAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { emit } from '@/output'

interface RootOpts {
    apiUrl?: string
    token?: string
}

interface ListOpts {
    agentId?: string
    json?: boolean
}

interface CreateOpts {
    agentId?: string
    title: string
    prompt: string
    schedulePreset: string
    rrule: string
    timezone: string
    dtstart?: string
    model?: string
    json?: boolean
}

interface UpdateOpts {
    title?: string
    prompt?: string
    status?: string
    schedulePreset?: string
    rrule?: string
    timezone?: string
    dtstart?: string
    model?: string
    clearModel?: boolean
    json?: boolean
}

interface JsonOpt {
    json?: boolean
}

interface DeleteOpts {
    yes?: boolean
    json?: boolean
}

const isSchedulePreset = (s: string): s is AutomationSchedulePreset =>
    s === 'hourly' ||
    s === 'daily' ||
    s === 'weekdays' ||
    s === 'weekly' ||
    s === 'custom'

const isStatus = (s: string): s is AutomationStatus =>
    s === 'active' || s === 'paused'

export const registerAutomations = (program: Command): void => {
    const cmd = program
        .command('automations')
        .description('Manage scheduled automations')

    cmd.command('list')
        .alias('ls')
        .description('List automations (optionally filter by agent)')
        .option('--agent-id <id>', 'filter to this agent')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: ListOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const list = await client.automations.list({
                agentId: resolveOptionalAgentId(opts.agentId, program)
            })
            if (opts.json) {
                console.log(JSON.stringify(list, null, 2))
                return
            }
            if (list.length === 0) {
                console.log(kleur.dim('(no automations)'))
                return
            }
            for (const a of list) {
                console.log(
                    `${a.id}  ${kleur.cyan(a.title)}  ${a.status}  ${kleur.yellow(a.schedulePreset)}  ${kleur.dim(a.agentId)}`
                )
            }
        })

    cmd.command('get <id>')
        .description('Show a single automation (with recent runs)')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (id: string, _opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const detail = await client.automations.get(id)
            console.log(JSON.stringify(detail, null, 2))
        })

    cmd.command('create')
        .description('Create a new automation')
        .option(
            '--agent-id <id>',
            'agent id to run as (defaults to $MF_AGENT_ID)'
        )
        .requiredOption('--title <title>', 'short title')
        .requiredOption('--prompt <prompt>', 'prompt body')
        .requiredOption(
            '--schedule-preset <preset>',
            'hourly | daily | weekdays | weekly | custom'
        )
        .requiredOption('--rrule <rrule>', 'RRULE string (iCalendar)')
        .requiredOption('--timezone <tz>', 'IANA timezone (e.g. UTC)')
        .option('--dtstart <iso>', 'first run start (ISO8601)')
        .option('--model <model>', 'model override')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: CreateOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const agentId = resolveAgentId(opts.agentId, program)
            if (!isSchedulePreset(opts.schedulePreset))
                throw new Error(
                    `--schedule-preset must be one of hourly|daily|weekdays|weekly|custom (got ${opts.schedulePreset})`
                )
            const body: CreateAutomationBody = {
                agentId,
                title: opts.title,
                prompt: opts.prompt,
                schedulePreset: opts.schedulePreset,
                rrule: opts.rrule,
                timezone: opts.timezone
            }
            if (opts.dtstart) body.dtstart = opts.dtstart
            if (opts.model) body.model = opts.model
            const detail = await client.automations.create(body)
            if (opts.json) {
                console.log(JSON.stringify(detail, null, 2))
                return
            }
            console.log(
                `${detail.id}  ${kleur.cyan(detail.title)}  ${detail.status}`
            )
        })

    cmd.command('update <id>')
        .description('Update an existing automation')
        .option('--title <title>', 'new title')
        .option('--prompt <prompt>', 'new prompt')
        .option('--status <status>', 'active | paused')
        .option(
            '--schedule-preset <preset>',
            'hourly | daily | weekdays | weekly | custom'
        )
        .option('--rrule <rrule>', 'new RRULE')
        .option('--timezone <tz>', 'new IANA timezone')
        .option('--dtstart <iso>', 'new dtstart')
        .option('--model <model>', 'new model override')
        .option('--clear-model', 'clear model override', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (id: string, opts: UpdateOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const body: UpdateAutomationBody = {}
            if (opts.title !== undefined) body.title = opts.title
            if (opts.prompt !== undefined) body.prompt = opts.prompt
            if (opts.status) {
                if (!isStatus(opts.status))
                    throw new Error(
                        `--status must be active or paused (got ${opts.status})`
                    )
                body.status = opts.status
            }
            if (opts.schedulePreset) {
                if (!isSchedulePreset(opts.schedulePreset))
                    throw new Error(
                        `--schedule-preset must be one of hourly|daily|weekdays|weekly|custom (got ${opts.schedulePreset})`
                    )
                body.schedulePreset = opts.schedulePreset
            }
            if (opts.rrule) body.rrule = opts.rrule
            if (opts.timezone) body.timezone = opts.timezone
            if (opts.dtstart) body.dtstart = opts.dtstart
            if (opts.clearModel) body.model = null
            else if (opts.model !== undefined) body.model = opts.model
            if (Object.keys(body).length === 0)
                throw new Error('nothing to update')
            const detail = await client.automations.update(id, body)
            if (opts.json) {
                console.log(JSON.stringify(detail, null, 2))
                return
            }
            console.log(
                `${detail.id}  ${kleur.cyan(detail.title)}  ${detail.status}`
            )
        })

    cmd.command('run <id>')
        .description('Trigger an automation run now')
        .option('--json', 'emit raw JSON', false)
        .action(async (id: string, opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const run = await client.automations.run(id)
            if (opts.json) {
                console.log(JSON.stringify(run, null, 2))
                return
            }
            console.log(
                `${run.id}  ${kleur.yellow(run.trigger)}  ${run.status}`
            )
        })

    cmd.command('delete <id>')
        .alias('rm')
        .description('Delete an automation')
        .option('-y, --yes', 'confirm deletion', false)
        .option('--json', 'output the result as JSON', false)
        .action(async (id: string, opts: DeleteOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            if (!opts.yes)
                throw new Error(
                    `refusing to delete ${id} without --yes (or -y)`
                )
            await client.automations.delete(id)
            emit(opts, { ok: true, id }, () =>
                console.log(kleur.dim(`✓ deleted ${id}`))
            )
        })
}

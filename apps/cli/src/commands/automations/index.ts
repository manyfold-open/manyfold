import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    AutomationStatus,
    AutomationSummary,
    CreateAutomationBody,
    UpdateAutomationBody
} from '@manyfold/shared'

import { resolveAgentId, resolveOptionalAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { emit } from '@/output'
import { UsageError } from '@/usage-error'
import {
    clockIn,
    describeSchedule,
    localTimezone,
    resolveSchedule
} from '@/commands/automations/schedule'

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
    schedulePreset?: string
    rrule?: string
    at?: string
    day?: string
    timezone?: string
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
    at?: string
    day?: string
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

// "aut_…  Title  active  daily at 09:00 (Asia/Shanghai) · next 2026-10-01 09:00"
const summaryLine = (automation: AutomationSummary): string =>
    `${automation.id}  ${kleur.cyan(automation.title)}  ${automation.status}  ${describeSchedule(automation)} (${automation.timezone})${automation.nextRunAt && automation.status === 'active' ? kleur.dim(` · next ${clockIn(automation.nextRunAt, automation.timezone)}`) : ''}`

const PRESET_HELP =
    'hourly | daily | weekdays | weekly (timed with --at, and --day for weekly); custom goes with --rrule'

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

    const create = cmd
        .command('create')
        .description('Create a new automation')
        .option(
            '--agent-id <id>',
            'agent id to run as (defaults to $MF_AGENT_ID)'
        )
        .requiredOption('--title <title>', 'short title')
        .requiredOption('--prompt <prompt>', 'prompt body')
        .option('--schedule-preset <preset>', PRESET_HELP)
        .option(
            '--at <time>',
            'time of day for a preset, HH:MM (default 09:00)'
        )
        .option(
            '--day <weekday>',
            'weekday for the weekly preset, mon … sun (default mon)'
        )
        .option(
            '--rrule <rrule>',
            'iCalendar RRULE for a custom schedule (the preset is then custom)'
        )
        .option(
            '--timezone <tz>',
            "IANA timezone the schedule keeps (default: this machine's)"
        )
        .option('--dtstart <iso>', 'first run start (ISO8601)')
        .option('--model <model>', 'model override')
        .option('--json', 'emit raw JSON', false)
    create.action(async (opts: CreateOpts) => {
        try {
            const schedule = resolveSchedule(opts)
            if (!schedule)
                throw new UsageError(
                    "say when it runs: --schedule-preset hourly | daily | weekdays | weekly (with --at HH:MM, and --day for weekly), or --rrule '<RRULE>'"
                )
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const body: CreateAutomationBody = {
                agentId: resolveAgentId(opts.agentId, program),
                title: opts.title,
                prompt: opts.prompt,
                ...schedule,
                timezone: opts.timezone ?? localTimezone()
            }
            if (opts.dtstart) body.dtstart = opts.dtstart
            if (opts.model) body.model = opts.model
            const detail = await client.automations.create(body)
            if (opts.json) {
                console.log(JSON.stringify(detail, null, 2))
                return
            }
            console.log(summaryLine(detail))
        } catch (err) {
            if (err instanceof UsageError) create.error(`error: ${err.message}`)
            throw err
        }
    })

    const update = cmd
        .command('update <id>')
        .description('Update an existing automation')
        .option('--title <title>', 'new title')
        .option('--prompt <prompt>', 'new prompt')
        .option('--status <status>', 'active | paused')
        .option('--schedule-preset <preset>', PRESET_HELP)
        .option(
            '--at <time>',
            'new time of day, HH:MM; alone it re-times the current preset'
        )
        .option('--day <weekday>', 'new weekday for the weekly preset')
        .option('--rrule <rrule>', 'new RRULE (the preset is then custom)')
        .option('--timezone <tz>', 'new IANA timezone')
        .option('--dtstart <iso>', 'new dtstart')
        .option('--model <model>', 'new model override')
        .option('--clear-model', 'clear model override', false)
        .option('--json', 'emit raw JSON', false)
    update.action(async (id: string, opts: UpdateOpts) => {
        try {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const body: UpdateAutomationBody = {}
            if (opts.title !== undefined) body.title = opts.title
            if (opts.prompt !== undefined) body.prompt = opts.prompt
            if (opts.status) {
                if (!isStatus(opts.status))
                    throw new UsageError(
                        `--status must be active or paused (got ${opts.status})`
                    )
                body.status = opts.status
            }
            // --at or --day alone re-time the automation's own preset.
            const current =
                (opts.at !== undefined || opts.day !== undefined) &&
                opts.schedulePreset === undefined &&
                opts.rrule === undefined
                    ? await client.automations.get(id)
                    : undefined
            const schedule = resolveSchedule(opts, current)
            if (schedule) Object.assign(body, schedule)
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
            console.log(summaryLine(detail))
        } catch (err) {
            if (err instanceof UsageError) update.error(`error: ${err.message}`)
            throw err
        }
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

import type { Command } from 'commander'
import kleur from 'kleur'
import { resolveOptionalAgentId } from '@/agent-context'
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

interface JsonOpt {
    json?: boolean
}

interface DeleteOpts {
    yes?: boolean
    json?: boolean
}

interface RestoreOpts {
    backupId: string
    yes?: boolean
    json?: boolean
}

export const registerBackups = (program: Command): void => {
    const cmd = program
        .command('backups')
        .description('Manage agent backups and restores')

    cmd.command('list')
        .alias('ls')
        .description('List backups (optionally filter by agent)')
        .option('--agent-id <id>', 'filter to this agent')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: ListOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const list = await client.backups.list({
                agentId: resolveOptionalAgentId(opts.agentId, program)
            })
            if (opts.json) {
                console.log(JSON.stringify(list, null, 2))
                return
            }
            if (list.length === 0) {
                console.log(kleur.dim('(no backups)'))
                return
            }
            for (const b of list) {
                console.log(
                    `${b.id}  ${kleur.cyan(b.sourceAgentName)}  ${b.status}  ${kleur.dim(`${b.archiveBytes}B`)}`
                )
            }
        })

    cmd.command('create <agentId>')
        .description('Snapshot an agent into a new backup')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (agentId: string, _opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.backups.create(agentId)
            console.log(JSON.stringify(res, null, 2))
        })

    cmd.command('delete <backupId>')
        .alias('rm')
        .description('Delete a backup (irreversible)')
        .option('-y, --yes', 'confirm irreversible deletion', false)
        .option('--json', 'output the result as JSON', false)
        .action(async (backupId: string, opts: DeleteOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            if (!opts.yes)
                throw new Error(
                    `refusing to delete ${backupId} without --yes (or -y)`
                )
            await client.backups.delete(backupId)
            emit(opts, { ok: true, id: backupId }, () =>
                console.log(kleur.dim(`✓ deleted ${backupId}`))
            )
        })

    cmd.command('restore <agentId>')
        .description('Restore an agent from a backup (replaces current state)')
        .requiredOption('--backup-id <id>', 'backup id to restore from')
        .option('-y, --yes', 'confirm replacement of current state', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (agentId: string, opts: RestoreOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            if (!opts.yes)
                throw new Error(
                    `restoring overwrites ${agentId}'s current state; pass --yes to confirm`
                )
            const res = await client.backups.restore(agentId, {
                backupId: opts.backupId
            })
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            console.log(
                `${res.id}  ${kleur.yellow(res.status)}  ${kleur.dim(`backup=${opts.backupId}`)}`
            )
        })

    cmd.command('get-restore <restoreId>')
        .description('Show status of a restore operation')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (restoreId: string, _opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.backups.getRestore(restoreId)
            console.log(JSON.stringify(res, null, 2))
        })
}

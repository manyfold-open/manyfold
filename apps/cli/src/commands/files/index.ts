import type { Command } from 'commander'
import type { FileRootCapabilitiesSdk } from '@manyfold/shared'
import kleur from 'kleur'
import { basename } from 'node:path'
import { resolveAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import {
    downloadToFile,
    downloadToStdout,
    uploadFile
} from '@/commands/files/transfer'
import { emit } from '@/output'

interface RootOpts {
    apiUrl?: string
    token?: string
}

interface RootScope {
    root?: string
}

interface JsonOpts {
    json?: boolean
}

interface ReadOpts extends RootScope {
    output?: string
}

interface WriteOpts extends RootScope, JsonOpts {
    content?: string
    file?: string
}

interface RmOpts extends RootScope, JsonOpts {
    recursive?: boolean
    yes?: boolean
}

const formatTransferBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`
    const mib = bytes / (1024 * 1024)
    if (mib >= 1) return `${Math.round(mib * 10) / 10}MiB`
    return `${Math.round(bytes / 1024)}KiB`
}

const describeCapabilities = (
    caps: FileRootCapabilitiesSdk | undefined
): string => {
    if (!caps) return ''
    const notes: string[] = []
    if (caps.maxUploadBytes !== undefined)
        notes.push(`up<=${formatTransferBytes(caps.maxUploadBytes)}`)
    if (caps.maxDownloadBytes !== undefined)
        notes.push(`down<=${formatTransferBytes(caps.maxDownloadBytes)}`)
    if (!caps.binarySafe) notes.push('text-only')
    return notes.length > 0 ? `  [${notes.join(' ')}]` : ''
}

// The agent id used to be a required leading positional. It stays supported, but
// arity now decides: pass the extra leading argument and it is the agent id, omit
// it and the agent comes from --agent-id / $MF_AGENT_ID like every other command.
interface PathTarget {
    agentId: string
    paths: string[]
}

const resolvePathTarget = (
    program: Command,
    args: Array<string | undefined>,
    pathCount: number,
    defaults: string[] = []
): PathTarget => {
    const given = args.filter((a): a is string => a !== undefined)
    if (given.length > pathCount)
        return { agentId: given[0], paths: given.slice(1) }
    const paths = [...given, ...defaults.slice(given.length)]
    if (paths.length < pathCount)
        throw new Error(`expected ${pathCount} path argument(s)`)
    return { agentId: resolveAgentId(undefined, program), paths }
}

export const registerFiles = (program: Command): void => {
    const cmd = program
        .command('files')
        .description('Read/write files on an agent runtime')

    cmd.command('roots [agentId]')
        .description('List available file roots for an agent')
        .option('--json', 'emit raw JSON', false)
        .action(async (maybeAgentId: string | undefined, opts: JsonOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const agentId = maybeAgentId ?? resolveAgentId(undefined, program)
            const res = await client.files.roots(agentId)
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            for (const r of res.roots) {
                console.log(
                    `${r.id}  ${kleur.cyan(r.label)}  ${kleur.dim(r.path)}${r.writable ? '' : kleur.dim(' (ro)')}${kleur.dim(describeCapabilities(r.capabilities))}`
                )
            }
        })

    cmd.command('list [agentIdOrPath] [path]')
        .alias('ls')
        .description('List directory entries on an agent')
        .option('--root <rootId>', 'root id (default: workspace)')
        .option('--json', 'emit raw JSON', false)
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                opts: JsonOpts & RootScope
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second],
                    1,
                    ['.']
                )
                const res = await client.files.list(agentId, paths[0], {
                    rootId: opts.root
                })
                if (opts.json) {
                    console.log(JSON.stringify(res, null, 2))
                    return
                }
                for (const e of res.entries) {
                    const typeFlag =
                        e.type === 'dir'
                            ? kleur.cyan('d')
                            : e.type === 'symlink'
                              ? kleur.yellow('l')
                              : '-'
                    console.log(
                        `${typeFlag} ${kleur.dim(String(e.size).padStart(8))}  ${e.name}`
                    )
                }
            }
        )

    cmd.command('stat [agentIdOrPath] [path]')
        .description('Show file metadata')
        .option('--root <rootId>', 'root id')
        .option('--json', 'emit raw JSON (default)', true)
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                opts: RootScope
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second],
                    1
                )
                const res = await client.files.stat(agentId, paths[0], {
                    rootId: opts.root
                })
                console.log(JSON.stringify(res, null, 2))
            }
        )

    cmd.command('read [agentIdOrPath] [path]')
        .description('Read file contents (to stdout or --output)')
        .option('--root <rootId>', 'root id')
        .option(
            '--output <localPath>',
            'write to this local file instead of stdout'
        )
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                opts: ReadOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second],
                    1
                )
                const target = {
                    client,
                    agentId,
                    remotePath: paths[0],
                    rootId: opts.root
                }
                if (!opts.output) {
                    await downloadToStdout(target)
                    return
                }
                const { bytes } = await downloadToFile(target, opts.output)
                console.log(
                    kleur.dim(`✓ wrote ${bytes} bytes to ${opts.output}`)
                )
            }
        )

    cmd.command('write [agentIdOrPath] [path]')
        .description('Write file contents from --content or --file')
        .option('--content <data>', 'inline content (string)')
        .option('--file <localPath>', 'read content from a local file')
        .option('--root <rootId>', 'root id')
        .option('--json', 'output the result as JSON', false)
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                opts: WriteOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second],
                    1
                )
                const path = paths[0]
                if (opts.content === undefined && !opts.file)
                    throw new Error('--content or --file is required')
                if (opts.content !== undefined && opts.file)
                    throw new Error(
                        '--content and --file are mutually exclusive'
                    )
                if (opts.file) {
                    await uploadFile(
                        {
                            client,
                            agentId,
                            remotePath: path,
                            rootId: opts.root
                        },
                        opts.file
                    )
                } else {
                    await client.files.write(
                        agentId,
                        path,
                        new TextEncoder().encode(opts.content as string),
                        { rootId: opts.root }
                    )
                }
                emit(opts, { ok: true, path }, () =>
                    console.log(kleur.dim(`✓ wrote ${path}`))
                )
            }
        )

    cmd.command('upload <localPath> [remotePath]')
        .description(
            'Upload a local file to an agent (remotePath defaults to the file name)'
        )
        .option('--root <rootId>', 'root id (default: workspace)')
        .option('--json', 'output the result as JSON', false)
        .action(
            async (
                localPath: string,
                remotePath: string | undefined,
                opts: RootScope & JsonOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const agentId = resolveAgentId(undefined, program)
                const target = remotePath ?? basename(localPath)
                const { bytes } = await uploadFile(
                    {
                        client,
                        agentId,
                        remotePath: target,
                        rootId: opts.root
                    },
                    localPath
                )
                emit(opts, { ok: true, path: target, bytes }, () =>
                    console.log(
                        kleur.dim(
                            `✓ uploaded ${formatTransferBytes(bytes)} to ${target}`
                        )
                    )
                )
            }
        )

    cmd.command('download <remotePath> [localPath]')
        .description(
            'Download a file from an agent (localPath defaults to the file name, - for stdout)'
        )
        .option('--root <rootId>', 'root id (default: workspace)')
        .option('--json', 'output the result as JSON', false)
        .action(
            async (
                remotePath: string,
                localPath: string | undefined,
                opts: RootScope & JsonOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const agentId = resolveAgentId(undefined, program)
                const target = {
                    client,
                    agentId,
                    remotePath,
                    rootId: opts.root
                }
                if (localPath === '-') {
                    await downloadToStdout(target)
                    return
                }
                const dest = localPath ?? basename(remotePath)
                const { bytes } = await downloadToFile(target, dest)
                emit(opts, { ok: true, path: dest, bytes }, () =>
                    console.log(
                        kleur.dim(
                            `✓ downloaded ${formatTransferBytes(bytes)} to ${dest}`
                        )
                    )
                )
            }
        )

    cmd.command('mkdir [agentIdOrPath] [path]')
        .description('Create a directory on an agent')
        .option('--root <rootId>', 'root id')
        .option('--json', 'output the result as JSON', false)
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                opts: RootScope & JsonOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second],
                    1
                )
                const path = paths[0]
                await client.files.mkdir(agentId, path, {
                    rootId: opts.root
                })
                emit(opts, { ok: true, path }, () =>
                    console.log(kleur.dim(`✓ mkdir ${path}`))
                )
            }
        )

    cmd.command('mv [agentIdOrFrom] [from] [to]')
        .description('Move or rename a path on an agent')
        .option('--root <rootId>', 'root id')
        .option('--json', 'output the result as JSON', false)
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                third: string | undefined,
                opts: RootScope & JsonOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second, third],
                    2
                )
                const [from, to] = paths
                await client.files.mv(agentId, from, to, {
                    rootId: opts.root
                })
                emit(opts, { ok: true, from, to }, () =>
                    console.log(kleur.dim(`✓ mv ${from} → ${to}`))
                )
            }
        )

    cmd.command('rm [agentIdOrPath] [path]')
        .description('Remove a file or directory on an agent')
        .option('--root <rootId>', 'root id')
        .option('--recursive', 'remove directories recursively', false)
        .option('-y, --yes', 'confirm irreversible deletion', false)
        .option('--json', 'output the result as JSON', false)
        .action(
            async (
                first: string | undefined,
                second: string | undefined,
                opts: RmOpts
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const { agentId, paths } = resolvePathTarget(
                    program,
                    [first, second],
                    1
                )
                const path = paths[0]
                if (!opts.yes)
                    throw new Error(
                        `refusing to remove ${path} without --yes (or -y)`
                    )
                await client.files.rm(agentId, path, {
                    rootId: opts.root,
                    recursive: opts.recursive
                })
                emit(opts, { ok: true, path }, () =>
                    console.log(kleur.dim(`✓ rm ${path}`))
                )
            }
        )
}

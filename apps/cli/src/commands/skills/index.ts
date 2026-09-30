import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Command } from 'commander'
import kleur from 'kleur'
import { isObjectId, MAX_LIBRARY_SKILL_FILE_BYTES } from '@manyfold/shared'
import type { LibrarySkillImportConflict } from '@manyfold/shared'
import { ApiError, type NcaClient } from '@manyfold/sdk'
import { resolveOptionalAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { emit, fail, printJson } from '@/output'
import { formatTable, type TableCell } from '@/table'
import { UsageError } from '@/usage-error'
import { plural } from '@/commands/doctor/describe'
import {
    frontmatterName,
    packSkillDir,
    type PackedSkill
} from '@/commands/skills/pack'

interface RootOpts {
    apiUrl?: string
    token?: string
    agentId?: string
}

interface InstalledOpts {
    agentId?: string
    includeRuntime?: boolean
    json?: boolean
}

interface DiscoverOpts {
    agentId?: string
    q?: string
    repoId?: string
    sort?: string
    cursor?: string
    limit?: string
    json?: boolean
}

interface InstallOpts {
    skillId?: string
    agentId?: string
    agentIds?: string
    json?: boolean
}

interface UpdateOpts {
    enabled?: boolean
    disabled?: boolean
    json?: boolean
}

interface DeleteOpts {
    yes?: boolean
    json?: boolean
}

interface JsonOpt {
    json?: boolean
}

interface CreateRepoOpts {
    owner: string
    name: string
    branch?: string
    json?: boolean
}

interface LibraryCreateOpts {
    name?: string
    description?: string
    content?: string
    contentFile?: string
    json?: boolean
}

interface LibraryUpdateOpts {
    name?: string
    description?: string
    content?: string
    contentFile?: string
    json?: boolean
}

interface LibraryImportOpts {
    url?: string
    file?: string
    catalogSkillId?: string
    share?: string
    onConflict?: string
    json?: boolean
}

interface LibraryExportOpts {
    output?: string
    json?: boolean
}

interface LibraryFileSetOpts {
    path: string
    content?: string
    contentFile?: string
    json?: boolean
}

const IMPORT_CONFLICT_MODES = ['fail', 'overwrite', 'rename'] as const

const resolveContentOpt = async (opts: {
    content?: string
    contentFile?: string
}): Promise<string | undefined> => {
    if (opts.content !== undefined && opts.contentFile !== undefined)
        throw new UsageError('pass at most one of --content / --content-file')
    if (opts.contentFile !== undefined)
        return readFile(opts.contentFile, 'utf8')
    return opts.content
}

const resolveConflictOpt = (
    value: string | undefined
): LibrarySkillImportConflict | undefined => {
    if (value === undefined) return undefined
    if (!(IMPORT_CONFLICT_MODES as readonly string[]).includes(value))
        throw new UsageError(
            `--on-conflict must be one of ${IMPORT_CONFLICT_MODES.join(', ')}`
        )
    return value as LibrarySkillImportConflict
}

// What `--file` names, as the archive to import: a skill folder is packed
// first, a .skill/.zip archive goes as it is.
const localArchive = async (
    path: string
): Promise<{ blob: Blob; filename: string; packed?: PackedSkill }> => {
    const info = await stat(path).catch(() => null)
    if (!info) throw new Error(`${path} does not exist`)
    if (info.isDirectory()) {
        const packed = await packSkillDir(path)
        return {
            blob: new Blob([packed.archive]),
            filename: packed.filename,
            packed
        }
    }
    if (!/\.(skill|zip)$/i.test(path))
        throw new UsageError(
            `--file takes a skill folder or a .skill/.zip archive; for one SKILL.md, mf skills library create --content-file ${path}`
        )
    return {
        blob: new Blob([new Uint8Array(await readFile(path))]),
        filename: basename(path)
    }
}

const LARGE_FILE_MIB = MAX_LIBRARY_SKILL_FILE_BYTES / (1024 * 1024)

// Files a packed folder left out, and an archive the API found too large.
const reportPacked = (packed: PackedSkill | undefined): void => {
    for (const path of packed?.tooLarge ?? [])
        console.error(
            kleur.dim(
                `left out ${path}: a skill's files are ${LARGE_FILE_MIB} MiB at most`
            )
        )
}

const packedTooLarge = (err: unknown, packed: PackedSkill | undefined) =>
    packed && err instanceof ApiError && err.status === 413
        ? {
              hint: 'Is there a node_modules or build output in the folder? A skill holds its instructions and the files they use.'
          }
        : undefined

export const parseShareRef = (value: string): string => {
    const trimmed = value.trim()
    if (isObjectId(trimmed, 'librarySkillShare')) return trimmed
    try {
        const url = new URL(trimmed)
        const match = /^\/skills\/shared\/([^/]+)\/?$/.exec(url.pathname)
        const candidate = match ? decodeURIComponent(match[1]) : ''
        if (isObjectId(candidate, 'librarySkillShare')) return candidate
    } catch {
        // not a URL; fall through to the error below
    }
    throw new UsageError(
        'pass a share link (…/skills/shared/lss_…) or a bare lss_… id'
    )
}

const resolveLibrarySkillId = async (
    client: NcaClient,
    ref: string
): Promise<string> => {
    if (isObjectId(ref, 'librarySkill')) return ref
    const list = await client.skills.library.list()
    const match = list.find((skill) => skill.name === ref)
    if (!match) throw new Error(`no library skill named "${ref}"`)
    return match.id
}

// How far a name is looked for in the catalog: `q` matches names,
// descriptions and repos alike, so a common word can fill several pages.
const NAME_LOOKUP_PAGES = 10

export interface SkillRef {
    skillId: string
    // Where a skill named on the command line was found; null for an id.
    source: string | null
}

interface SkillMatch {
    skillId: string
    source: string
    // How to name it alone: <owner>/<name>, or the id for a library skill.
    handle: string
}

// A skill as the command line names it: an id passes through (a catalog id
// holds a colon, a library one is skl_…); a name is looked for, exactly
// and case-blind, in the library and in the catalog (by its name or its
// folder's), and `<owner>/<name>` narrows it to one repo owner's.
export const resolveSkillRef = async (
    client: NcaClient,
    ref: string
): Promise<SkillRef> => {
    const given = ref.trim()
    if (given.includes(':') || isObjectId(given, 'librarySkill'))
        return { skillId: given, source: null }
    const slash = given.indexOf('/')
    const owner = slash > 0 ? given.slice(0, slash).toLowerCase() : null
    const name = slash > 0 ? given.slice(slash + 1) : given
    const wanted = name.toLowerCase()
    const found = new Map<string, SkillMatch>()
    if (owner === null)
        for (const skill of await client.skills.library.list())
            if (skill.name.toLowerCase() === wanted)
                found.set(skill.id, {
                    skillId: skill.id,
                    source: 'your library',
                    handle: skill.id
                })
    let cursor: string | undefined
    for (let page = 0; page < NAME_LOOKUP_PAGES; page++) {
        const result = await client.skills.discoverPage({
            q: name,
            limit: 100,
            ...(cursor ? { cursor } : {})
        })
        for (const skill of result.items) {
            const folder = skill.sourcePath?.split('/').pop()?.toLowerCase()
            if (
                (skill.name.toLowerCase() === wanted || folder === wanted) &&
                (owner === null || skill.repoOwner.toLowerCase() === owner)
            )
                found.set(skill.skillId, {
                    skillId: skill.skillId,
                    source: `${skill.repoOwner}/${skill.repoName}`,
                    handle: `${skill.repoOwner}/${name}`
                })
        }
        if (!result.nextCursor) break
        cursor = result.nextCursor
    }
    const matches = [...found.values()]
    if (matches.length === 1)
        return { skillId: matches[0].skillId, source: matches[0].source }
    if (matches.length === 0)
        throw new Error(
            `no skill named "${given}" in ${owner === null ? 'your library or ' : ''}the catalog (mf skills discover --q ${name} searches the catalog)`
        )
    throw new UsageError(
        `${matches.length} skills are named "${given}"; name the one to install as below:\n${matches.map((match) => `  ${match.handle}  ${kleur.dim(match.handle === match.skillId ? match.source : match.skillId)}`).join('\n')}`
    )
}

interface UpdateRepoOpts {
    branch?: string
    enabled?: boolean
    disabled?: boolean
    json?: boolean
}

export type InstallTarget =
    | { mode: 'single'; skillId: string; agentId: string }
    | { mode: 'batch'; skillId: string; agentIds: string[] }

// `agentId` is the pre-resolved agent context (see @/agent-context).
// An explicit `--agent-ids` batch wins over it so an ambient
// `$MF_AGENT_ID` never blocks or hijacks a batch install.
export const resolveInstallTarget = (input: {
    skillId: string
    agentId?: string
    agentIds?: string
}): InstallTarget => {
    if (input.agentIds !== undefined) {
        const agentIds = input.agentIds
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        if (agentIds.length === 0) throw new UsageError('--agent-ids is empty')
        return { mode: 'batch', skillId: input.skillId, agentIds }
    }
    const agentId = input.agentId?.trim()
    if (!agentId)
        throw new UsageError(
            'pass --agent-id (or --agent-ids for a batch install), or set $MF_AGENT_ID'
        )
    return { mode: 'single', skillId: input.skillId, agentId }
}

export const registerSkills = (program: Command): void => {
    const cmd = program
        .command('skills')
        .description('Manage installed agent skills')

    cmd.command('installed')
        .aliases(['list', 'ls'])
        .description('List installed skills (optionally filter by agent)')
        .option('--agent-id <id>', 'filter to this agent')
        .option('--include-runtime', 'include runtime-level skills', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: InstalledOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const list = await client.skills.installed(
                resolveOptionalAgentId(opts.agentId, program),
                {
                    includeRuntime: opts.includeRuntime ?? false
                }
            )
            if (opts.json) {
                console.log(JSON.stringify(list, null, 2))
                return
            }
            if (list.length === 0) {
                console.log(kleur.dim('(no installed skills)'))
                return
            }
            for (const group of list) {
                console.log(
                    kleur.cyan(`${group.agent.name} (${group.agent.id})`)
                )
                if (group.skills.length === 0) {
                    console.log(kleur.dim('  (none)'))
                    continue
                }
                const [header, ...lines] = formatTable(
                    ['ID', 'DIR', 'STATE'],
                    group.skills.map((s): TableCell[] => {
                        const state = s.enabled ? 'enabled' : 'disabled'
                        return [
                            s.id,
                            [s.installDir, kleur.dim],
                            s.materializeStatus === 'failed'
                                ? [`${state}, materialize failed`, kleur.red]
                                : s.materializeStatus === 'installing'
                                  ? [`${state}, installing`, kleur.yellow]
                                  : state
                        ]
                    })
                )
                console.log(`  ${header}`)
                group.skills.forEach((s, index) => {
                    console.log(`  ${lines[index]}`)
                    if (s.materializeStatus === 'failed' && s.materializeError)
                        console.log(`      ${kleur.dim(s.materializeError)}`)
                })
            }
        })

    cmd.command('discover')
        .description('Discover skills available to install')
        .option('--agent-id <id>', 'filter to this agent context')
        .option('--q <query>', 'search query')
        .option('--repo-id <id>', 'filter to a specific repo')
        .option('--sort <order>', "'featured' (default) or 'latest'")
        .option('--cursor <cursor>', 'opaque cursor from previous page')
        .option('--limit <n>', 'page size (1-100, default 100)')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: DiscoverOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const sort =
                opts.sort === 'featured' || opts.sort === 'latest'
                    ? opts.sort
                    : undefined
            if (opts.sort !== undefined && sort === undefined)
                throw new UsageError("--sort must be 'featured' or 'latest'")
            // Max page size on purpose: the pre-envelope command returned the
            // whole result set in one response, so defaulting to the server
            // cap keeps single-page parity at today's catalog sizes; beyond
            // it the cursor is the honest contract (the offset cursor is not
            // stable across concurrent re-ranks, so no client-side looping).
            const page = await client.skills.discoverPage({
                agentId: resolveOptionalAgentId(opts.agentId, program),
                q: opts.q,
                repoId: opts.repoId,
                sort,
                cursor: opts.cursor,
                limit: opts.limit ? Number(opts.limit) : 100
            })
            if (opts.json) {
                console.log(JSON.stringify(page, null, 2))
                return
            }
            if (page.items.length === 0)
                console.log(kleur.dim('(no skills found)'))
            else
                for (const line of formatTable(
                    ['ID', 'NAME', 'DESCRIPTION'],
                    page.items.map((s): TableCell[] => [
                        s.skillId,
                        [s.name, kleur.cyan],
                        [s.description ?? '', kleur.dim]
                    ])
                ))
                    console.log(line)
            if (page.pendingRepos?.length)
                console.error(
                    kleur.dim(
                        `still reading ${page.pendingRepos.map((repo) => `${repo.owner}/${repo.name}`).join(', ')}: their skills are not listed yet; run this again in a minute`
                    )
                )
            if (page.nextCursor)
                console.error(
                    kleur.dim(
                        `(more — continue with --cursor ${page.nextCursor})`
                    )
                )
        })

    const install = cmd
        .command('install [skill]')
        .description(
            'Install a skill on one agent (or many via --agent-ids): its id, or its name'
        )
        .option(
            '--skill-id <id>',
            'skill id from discover or library (the same as [skill])'
        )
        .option(
            '--agent-id <id>',
            'agent id (defaults to the global --agent-id / $MF_AGENT_ID)'
        )
        .option(
            '--agent-ids <ids>',
            'comma-separated agent ids for a batch install'
        )
        .option('--json', 'emit raw JSON', false)
    install.action(async (skill: string | undefined, opts: InstallOpts) => {
        try {
            if (skill !== undefined && opts.skillId !== undefined)
                throw new UsageError(
                    'name the skill once: as [skill] or as --skill-id'
                )
            const ref = skill ?? opts.skillId
            if (ref === undefined)
                throw new UsageError(
                    'which skill: pass its name or its id (mf skills discover lists them)'
                )
            const agentId = resolveOptionalAgentId(opts.agentId, program)
            // The agent first: its check needs no request.
            resolveInstallTarget({
                skillId: ref,
                agentId,
                agentIds: opts.agentIds
            })
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const resolved = await resolveSkillRef(client, ref)
            const target = resolveInstallTarget({
                skillId: resolved.skillId,
                agentId,
                agentIds: opts.agentIds
            })
            const from = resolved.source
                ? kleur.dim(`  from ${resolved.source}`)
                : ''
            if (target.mode === 'batch') {
                const res = await client.skills.installBatch({
                    skillId: target.skillId,
                    agentIds: target.agentIds
                })
                if (opts.json) {
                    console.log(JSON.stringify(res, null, 2))
                    return
                }
                for (const item of res.results) {
                    console.log(
                        item.status === 'installed'
                            ? `${item.agentId}  ${kleur.green('installed')}  ${item.skill?.id ?? ''}${from}`
                            : `${item.agentId}  ${kleur.red('failed')}  ${kleur.dim(item.error ?? '')}`
                    )
                }
                return
            }
            const res = await client.skills.install({
                skillId: target.skillId,
                agentId: target.agentId
            })
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            const status =
                res.materializeStatus === 'failed'
                    ? kleur.red(
                          `failed: ${res.materializeError ?? 'materialization failed'}`
                      )
                    : res.materializeStatus === 'installing'
                      ? kleur.yellow('installing')
                      : kleur.green('installed')
            console.log(
                `${res.id}  ${kleur.cyan(res.name)}  ${res.enabled ? 'enabled' : 'disabled'}  ${status}${from}`
            )
        } catch (err) {
            if (err instanceof UsageError)
                install.error(`error: ${err.message}`)
            throw err
        }
    })

    cmd.command('update <userSkillId>')
        .description('Enable or disable an installed skill')
        .option('--enabled', 'enable the skill', false)
        .option('--disabled', 'disable the skill', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (userSkillId: string, opts: UpdateOpts) => {
            if (opts.enabled === opts.disabled)
                throw new UsageError(
                    'pass exactly one of --enabled or --disabled'
                )
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.update(userSkillId, {
                enabled: Boolean(opts.enabled)
            })
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            console.log(
                `${res.id}  ${kleur.cyan(res.name)}  ${res.enabled ? 'enabled' : 'disabled'}`
            )
        })

    cmd.command('delete <userSkillId>')
        .alias('rm')
        .description('Uninstall a skill')
        .option('-y, --yes', 'confirm uninstall', false)
        .option('--json', 'output the result as JSON', false)
        .action(async (userSkillId: string, opts: DeleteOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            if (!opts.yes)
                throw new Error(
                    `refusing to delete ${userSkillId} without --yes (or -y)`
                )
            await client.skills.delete(userSkillId)
            emit(opts, { ok: true, id: userSkillId }, () =>
                console.log(kleur.dim(`✓ deleted ${userSkillId}`))
            )
        })

    const library = cmd
        .command('library')
        .description('Manage your personal skill library')

    library
        .command('list')
        .alias('ls')
        .description('List library skills')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const list = await client.skills.library.list()
            if (opts.json) {
                console.log(JSON.stringify(list, null, 2))
                return
            }
            if (list.length === 0) {
                console.log(kleur.dim('(no library skills)'))
                return
            }
            const rows = list.map((s): TableCell[] => [
                s.id,
                [s.name, kleur.cyan],
                String(s.fileCount),
                String(s.installedAgentCount)
            ])
            for (const line of formatTable(
                ['ID', 'NAME', 'FILES', 'AGENTS'],
                rows
            ))
                console.log(line)
        })

    library
        .command('get <skillId>')
        .description('Show a library skill (metadata + SKILL.md)')
        .option('--json', 'emit raw JSON', false)
        .action(async (skillId: string, opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.library.get(skillId)
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            console.log(`${res.id}  ${kleur.cyan(res.name)}`)
            if (res.description) console.log(kleur.dim(res.description))
            for (const f of res.files) console.log(`  ${kleur.dim(f.path)}`)
            console.log('')
            console.log(res.content)
        })

    const libraryCreate = library
        .command('create')
        .description('Create a library skill')
        .option(
            '--name <name>',
            "skill name (default: the name in the content's frontmatter)"
        )
        .option('--description <text>', 'skill description')
        .option('--content <markdown>', 'SKILL.md content inline')
        .option('--content-file <path>', 'read SKILL.md content from a file')
        .option('--json', 'emit raw JSON', false)
    libraryCreate.action(async (opts: LibraryCreateOpts) => {
        try {
            const content = await resolveContentOpt(opts)
            const name =
                opts.name ??
                (content === undefined ? undefined : frontmatterName(content))
            if (!name)
                throw new UsageError(
                    'name the skill: --name, or a name: line in its SKILL.md frontmatter'
                )
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.library.create({
                name,
                description: opts.description,
                content
            })
            emit(opts, res, () =>
                console.log(`${res.id}  ${kleur.cyan(res.name)}`)
            )
        } catch (err) {
            if (err instanceof UsageError)
                libraryCreate.error(`error: ${err.message}`)
            throw err
        }
    })

    library
        .command('update <skillId>')
        .description('Update a library skill (name / description / SKILL.md)')
        .option('--name <name>', 'new skill name')
        .option('--description <text>', 'new description')
        .option('--content <markdown>', 'new SKILL.md content inline')
        .option('--content-file <path>', 'read new SKILL.md from a file')
        .option('--json', 'emit raw JSON', false)
        .action(async (skillId: string, opts: LibraryUpdateOpts) => {
            const content = await resolveContentOpt(opts)
            if (
                opts.name === undefined &&
                opts.description === undefined &&
                content === undefined
            )
                throw new UsageError('nothing to update')
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.library.update(skillId, {
                name: opts.name,
                description: opts.description,
                content
            })
            emit(opts, res, () =>
                console.log(`${res.id}  ${kleur.cyan(res.name)}`)
            )
        })

    const libraryImport = library
        .command('import')
        .description(
            'Import a skill from a GitHub URL, catalog entry, share link, local folder, or .skill/.zip archive'
        )
        .option('--url <url>', 'github.com repo / tree / SKILL.md blob URL')
        .option(
            '--file <path>',
            'local skill folder (SKILL.md at its top) or .skill/.zip archive'
        )
        .option(
            '--catalog-skill-id <id>',
            'copy a catalog skill to the library'
        )
        .option(
            '--share <url-or-id>',
            'copy a shared skill via its link or lss_… id'
        )
        .option('--on-conflict <mode>', 'fail | overwrite | rename')
        .option('--json', 'emit raw JSON', false)
    libraryImport.action(async (opts: LibraryImportOpts) => {
        let packed: PackedSkill | undefined
        try {
            const provided = [
                opts.url,
                opts.file,
                opts.catalogSkillId,
                opts.share
            ].filter((v) => v !== undefined)
            if (provided.length !== 1)
                throw new UsageError(
                    'pass exactly one of --url / --file / --catalog-skill-id / --share'
                )
            const onConflict = resolveConflictOpt(opts.onConflict)
            const local = opts.file ? await localArchive(opts.file) : null
            packed = local?.packed
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = local
                ? await client.skills.library.importArchive(
                      local.blob,
                      local.filename,
                      { onConflict }
                  )
                : await client.skills.library.import({
                      url: opts.url,
                      catalogSkillId: opts.catalogSkillId,
                      shareId: opts.share
                          ? parseShareRef(opts.share)
                          : undefined,
                      onConflict
                  })
            emit(opts, res, () => {
                reportPacked(packed)
                console.log(
                    `${res.status}  ${res.skill.id}  ${kleur.cyan(res.skill.name)}`
                )
            })
        } catch (err) {
            if (err instanceof UsageError)
                libraryImport.error(`error: ${err.message}`)
            const extra = packedTooLarge(err, packed)
            if (extra) {
                fail(opts, err, extra)
                return
            }
            throw err
        }
    })

    const publish = library
        .command('publish <dir>')
        .description(
            'Create or update the library skill of a local folder (by its name), then push it to the agents that have it'
        )
        .option('--json', 'emit raw JSON', false)
    publish.action(async (dir: string, opts: JsonOpt) => {
        let packed: PackedSkill | undefined
        try {
            packed = await packSkillDir(dir)
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.library.importArchive(
                new Blob([packed.archive]),
                packed.filename,
                { onConflict: 'overwrite' }
            )
            // A new skill is on no agent yet; an update reaches the agents
            // that have it.
            const push =
                res.status === 'updated'
                    ? await client.skills.library.push(res.skill.id)
                    : null
            if (opts.json) {
                printJson({ ...res, push })
                return
            }
            reportPacked(packed)
            console.log(
                `${res.status}  ${res.skill.id}  ${kleur.cyan(res.skill.name)}  ${kleur.dim(plural(packed.files, 'file'))}`
            )
            for (const item of push?.results ?? [])
                console.log(
                    item.status === 'pushed'
                        ? `  ${item.agentId}  ${kleur.green('pushed')}`
                        : `  ${item.agentId}  ${kleur.red('failed')}  ${kleur.dim(item.error ?? '')}`
                )
            if (!push || push.results.length === 0)
                console.error(
                    kleur.dim(
                        `on no agent yet; install it with mf skills install ${res.skill.name} --agent-id <agent>`
                    )
                )
        } catch (err) {
            if (err instanceof UsageError)
                publish.error(`error: ${err.message}`)
            const extra = packedTooLarge(err, packed)
            if (extra) {
                fail(opts, err, extra)
                return
            }
            throw err
        }
    })

    library
        .command('share <skill>')
        .description(
            'Create or show the share link for a library skill (id or name)'
        )
        .option('--revoke', 'revoke the active share link', false)
        .option('--json', 'emit raw JSON', false)
        .action(
            async (
                skill: string,
                opts: { revoke?: boolean; json?: boolean }
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const skillId = await resolveLibrarySkillId(client, skill)
                if (opts.revoke) {
                    await client.skills.library.revokeShare(skillId)
                    emit(opts, { ok: true, id: skillId }, () =>
                        console.log(kleur.dim(`✓ share revoked for ${skillId}`))
                    )
                    return
                }
                const res = await client.skills.library.share(skillId)
                emit(opts, res, () => {
                    console.log(`${res.id}  ${kleur.cyan(res.url)}`)
                    console.log(
                        kleur.dim(
                            `imported ${plural(res.importCount, 'time')}; anyone with the link can view and copy this skill`
                        )
                    )
                })
            }
        )

    library
        .command('export <skillId>')
        .description('Download a library skill as a .skill archive')
        .option('-o, --output <path>', 'output file path')
        .option('--json', 'emit raw JSON', false)
        .action(async (skillId: string, opts: LibraryExportOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const { blob, filename } =
                await client.skills.library.export(skillId)
            const out = opts.output ?? filename
            await writeFile(
                out,
                Buffer.from(new Uint8Array(await blob.arrayBuffer()))
            )
            emit(opts, { ok: true, file: out }, () =>
                console.log(kleur.dim(`✓ exported to ${out}`))
            )
        })

    library
        .command('delete <skillId>')
        .alias('rm')
        .description('Delete a library skill')
        .option('-y, --yes', 'confirm deletion', false)
        .option('--force', 'uninstall from all agents before deleting', false)
        .option('--json', 'output the result as JSON', false)
        .action(
            async (skillId: string, opts: DeleteOpts & { force?: boolean }) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                if (!opts.yes)
                    throw new Error(
                        `refusing to delete ${skillId} without --yes (or -y)`
                    )
                try {
                    await client.skills.library.delete(skillId, {
                        force: opts.force
                    })
                } catch (err) {
                    if (
                        !(err instanceof ApiError) ||
                        err.code !== 'skill_installed'
                    )
                        throw err
                    const ids =
                        (
                            err.details as
                                | { installedAgentIds?: string[] }
                                | undefined
                        )?.installedAgentIds ?? []
                    const hint =
                        'Pass --force to uninstall it from those agents and delete it, or uninstall it there first.'
                    if (opts.json || ids.length === 0) {
                        fail(opts, err, { hint })
                        return
                    }
                    console.error(
                        kleur.red(
                            `${skillId} is installed on ${plural(ids.length, 'agent')}: ${ids.join(', ')}`
                        )
                    )
                    console.error(kleur.dim(hint))
                    process.exitCode = 1
                    return
                }
                emit(opts, { ok: true, id: skillId }, () =>
                    console.log(kleur.dim(`✓ deleted ${skillId}`))
                )
            }
        )

    library
        .command('push <skillId>')
        .description(
            'Push the current skill content to installed agents (all by default)'
        )
        .option('--agent-ids <ids>', 'comma-separated agent ids to push to')
        .option('--json', 'emit raw JSON', false)
        .action(
            async (
                skillId: string,
                opts: { agentIds?: string; json?: boolean }
            ) => {
                const global = program.opts<RootOpts>()
                const { client } = await buildClient(global)
                const agentIds = opts.agentIds
                    ?.split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                const res = await client.skills.library.push(
                    skillId,
                    agentIds && agentIds.length > 0 ? { agentIds } : undefined
                )
                if (opts.json) {
                    console.log(JSON.stringify(res, null, 2))
                    return
                }
                if (res.results.length === 0) {
                    console.log(kleur.dim('(not installed on any agent)'))
                    return
                }
                for (const item of res.results) {
                    console.log(
                        item.status === 'pushed'
                            ? `${item.agentId}  ${kleur.green('pushed')}`
                            : `${item.agentId}  ${kleur.red('failed')}  ${kleur.dim(item.error ?? '')}`
                    )
                }
            }
        )

    const libraryFiles = library
        .command('files')
        .description('Manage a library skill’s supporting files')

    libraryFiles
        .command('set <skillId>')
        .description('Create or update a supporting file')
        .requiredOption('--path <path>', 'file path inside the skill')
        .option('--content <text>', 'file content inline')
        .option('--content-file <path>', 'read file content from a local file')
        .option('--json', 'emit raw JSON', false)
        .action(async (skillId: string, opts: LibraryFileSetOpts) => {
            const content = await resolveContentOpt(opts)
            if (content === undefined)
                throw new UsageError('pass one of --content / --content-file')
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.library.upsertFile(skillId, {
                path: opts.path,
                content
            })
            emit(opts, res, () =>
                console.log(`${res.id}  ${kleur.cyan(res.name)}  ${opts.path}`)
            )
        })

    libraryFiles
        .command('delete <skillId> <fileId>')
        .alias('rm')
        .description('Delete a supporting file')
        .option('--json', 'emit raw JSON', false)
        .action(async (skillId: string, fileId: string, opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.library.deleteFile(skillId, fileId)
            emit(opts, res, () =>
                console.log(kleur.dim(`✓ deleted file ${fileId}`))
            )
        })

    const repos = cmd
        .command('repos')
        .description('Manage skill repositories (admin / api.full)')

    repos
        .command('list')
        .alias('ls')
        .description('List skill repos')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: JsonOpt) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const list = await client.skills.repos.list()
            if (opts.json) {
                console.log(JSON.stringify(list, null, 2))
                return
            }
            if (list.length === 0) {
                console.log(kleur.dim('(no skill repos)'))
                return
            }
            for (const line of formatTable(
                ['ID', 'REPO'],
                list.map((r): TableCell[] => [
                    r.id,
                    [`${r.owner}/${r.name}@${r.branch}`, kleur.cyan]
                ])
            ))
                console.log(line)
        })

    repos
        .command('create')
        .description('Register a new skill repo')
        .requiredOption('--owner <owner>', 'github owner')
        .requiredOption('--name <name>', 'repo name')
        .option('--branch <branch>', 'branch (default: main)')
        .option('--json', 'emit raw JSON', false)
        .action(async (opts: CreateRepoOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.repos.create({
                owner: opts.owner,
                name: opts.name,
                branch: opts.branch
            })
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            console.log(`${res.id}  ${kleur.cyan(`${res.owner}/${res.name}`)}`)
        })

    repos
        .command('update <repoId>')
        .description('Update a skill repo (branch / enabled)')
        .option('--branch <branch>', 'new branch')
        .option('--enabled', 'enable the repo', false)
        .option('--disabled', 'disable the repo', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (repoId: string, opts: UpdateRepoOpts) => {
            const body: { branch?: string; enabled?: boolean } = {}
            if (opts.branch) body.branch = opts.branch
            if (opts.enabled && opts.disabled)
                throw new UsageError(
                    'cannot pass both --enabled and --disabled'
                )
            if (opts.enabled) body.enabled = true
            else if (opts.disabled) body.enabled = false
            if (Object.keys(body).length === 0)
                throw new UsageError('nothing to update')
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.skills.repos.update(repoId, body)
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            console.log(`${res.id}  ${kleur.cyan(`${res.owner}/${res.name}`)}`)
        })

    repos
        .command('delete <repoId>')
        .alias('rm')
        .description('Remove a skill repo')
        .option('-y, --yes', 'confirm deletion', false)
        .option('--json', 'output the result as JSON', false)
        .action(async (repoId: string, opts: DeleteOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            if (!opts.yes)
                throw new Error(
                    `refusing to delete ${repoId} without --yes (or -y)`
                )
            await client.skills.repos.delete(repoId)
            emit(opts, { ok: true, id: repoId }, () =>
                console.log(kleur.dim(`✓ deleted ${repoId}`))
            )
        })
}

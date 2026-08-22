import type { Writable } from 'node:stream'
import { and, asc, eq, gt, or } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    authIdentities,
    automations,
    channels,
    chatMessages,
    chatSessions,
    librarySkillFiles,
    librarySkills,
    sandboxActiveDurationDays,
    skillRepos,
    userApiUsageDays,
    userConnections,
    userSkills,
    users,
    type Database
} from '@manyfold/db'
import type { UserLifecyclePort } from '@/common/ports/user-lifecycle.ports'
import { ExportBundleWriter } from './export-bundle'
import { redactExportValue } from './export-redact'

const MESSAGE_BATCH = 200

export interface WriteUserExportArgs {
    db: Database
    userId: string
    exportId: string
    port: UserLifecyclePort
    out: Writable
}

// The takeout pipeline (ADR-0023 §9.2): per-domain collectors stream
// DB-resident user data into a zip, one JSON/NDJSON entry per domain.
//
// The secret-free guarantee is structural, not reviewed-in: every collector
// SELECTs an explicit column allowlist — credential columns
// (channels.credentials_ciphertext, user_connections.secret_ciphertext,
// api_tokens/token hashes, key_version) are never read — and every free-form
// config blob that is included (agent extras, channel config, connection
// metadata, port output) passes redactExportValue. Whole credential-holding
// tables (api_tokens, agent_credentials, token holders of any kind) have no
// collector at all. V-6 in user-export.pg.test.ts seeds every cheaply
// seedable credential shape and scans the finished bundle for zero hits.
//
// Deliberately absent (and why):
// - workspace files: live on the sprite VM / user's machine, not in the DB;
//   the existing backups/files APIs are the self-serve path (§9.2).
// - local financial rows: Stripe is the system of record; the cloud edition
//   attaches a Stripe-sourced summary through the port hook instead.
// - other people's data (shared skills' upstream content, channel peers).
export async function writeUserExportBundle(
    args: WriteUserExportArgs
): Promise<{ entries: string[] }> {
    const { db, userId } = args
    const bundle = new ExportBundleWriter(args.out)

    await collectProfile(db, userId, bundle)
    await collectAgents(db, userId, bundle)
    await collectChat(db, userId, bundle)
    await collectSkills(db, userId, bundle)
    await collectAutomations(db, userId, bundle)
    await collectChannels(db, userId, bundle)
    await collectUsage(db, userId, bundle)
    await collectConnections(db, userId, bundle)
    await collectPortDomains(args, bundle)

    await bundle.json('manifest.json', {
        format: 'manyfold-takeout/1',
        exportId: args.exportId,
        userId,
        generatedAt: new Date().toISOString(),
        entries: [...bundle.entryNames]
    })
    await bundle.finish()
    return { entries: bundle.entryNames }
}

async function collectProfile(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    const [user] = await db
        .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            role: users.role,
            planId: users.planId,
            statefulSandboxLimit: users.statefulSandboxLimit,
            alwaysOnlineRuntimeBonus: users.alwaysOnlineRuntimeBonus,
            activeHoursBonus: users.activeHoursBonus,
            frameworkRuntimeOverrides: users.frameworkRuntimeOverrides,
            deactivatedAt: users.deactivatedAt,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    if (!user) throw new Error(`user ${userId} not found`)
    await bundle.json('profile.json', user)
}

async function collectAgents(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    const runtimeEntry = bundle.entry('agent-runtimes.ndjson')
    const runtimes = await db
        .select({
            id: agentRuntimes.id,
            name: agentRuntimes.name,
            framework: agentRuntimes.framework,
            kind: agentRuntimes.kind,
            status: agentRuntimes.status,
            createdAt: agentRuntimes.createdAt,
            updatedAt: agentRuntimes.updatedAt
        })
        .from(agentRuntimes)
        .where(eq(agentRuntimes.userId, userId))
        .orderBy(asc(agentRuntimes.createdAt), asc(agentRuntimes.id))
    for (const row of runtimes) await runtimeEntry.write(row)
    await runtimeEntry.end()

    const agentEntry = bundle.entry('agents.ndjson')
    const rows = await db
        .select({
            id: agents.id,
            runtimeId: agents.runtimeId,
            name: agents.name,
            framework: agents.framework,
            runtime: agents.runtime,
            status: agents.status,
            model: agents.model,
            workspacePath: agents.workspacePath,
            mountPath: agents.mountPath,
            fileRoots: agents.fileRoots,
            extras: agents.extras,
            lastMessageAt: agents.lastMessageAt,
            createdAt: agents.createdAt,
            updatedAt: agents.updatedAt
        })
        .from(agents)
        .where(eq(agents.userId, userId))
        .orderBy(asc(agents.createdAt), asc(agents.id))
    for (const row of rows) {
        // extras carries envText (raw KEY=value pairs, BYO api keys) and MCP
        // server env/header maps — exactly the credential material §9.2 bans.
        await agentEntry.write({
            ...row,
            extras: redactExportValue(row.extras)
        })
    }
    await agentEntry.end()
}

async function collectChat(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    const sessionEntry = bundle.entry('chat-sessions.ndjson')
    const sessions = await db
        .select({
            id: chatSessions.id,
            agentId: chatSessions.agentId,
            title: chatSessions.title,
            createdAt: chatSessions.createdAt,
            updatedAt: chatSessions.updatedAt
        })
        .from(chatSessions)
        .where(eq(chatSessions.userId, userId))
        .orderBy(asc(chatSessions.createdAt), asc(chatSessions.id))
    for (const row of sessions) await sessionEntry.write(row)
    await sessionEntry.end()

    // One file per session, streamed in keyset batches: a long chat history
    // must bound memory by batch size, never by conversation size. Message
    // content is exported verbatim — it is the user's own conversation, the
    // thing §9.2 exists to hand back (see export-redact.ts).
    for (const session of sessions) {
        const entry = bundle.entry(`chat-messages/${session.id}.ndjson`)
        let cursor: { createdAt: Date; id: string } | null = null
        for (;;) {
            // Annotated to break the batch→cursor→where-clause inference
            // cycle TS otherwise reports as TS7022.
            const batch: Array<{
                id: string
                role: string
                contentBlocksJson: unknown
                createdAt: Date
            }> = await db
                .select({
                    id: chatMessages.id,
                    role: chatMessages.role,
                    contentBlocksJson: chatMessages.contentBlocksJson,
                    createdAt: chatMessages.createdAt
                })
                .from(chatMessages)
                .where(
                    and(
                        eq(chatMessages.sessionId, session.id),
                        cursor
                            ? or(
                                  gt(chatMessages.createdAt, cursor.createdAt),
                                  and(
                                      eq(
                                          chatMessages.createdAt,
                                          cursor.createdAt
                                      ),
                                      gt(chatMessages.id, cursor.id)
                                  )
                              )
                            : undefined
                    )
                )
                .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
                .limit(MESSAGE_BATCH)
            for (const row of batch) await entry.write(row)
            if (batch.length < MESSAGE_BATCH) break
            const last = batch[batch.length - 1]
            cursor = { createdAt: last.createdAt, id: last.id }
        }
        await entry.end()
    }
}

async function collectSkills(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    // The user's own library skills are authored content — the files ride
    // along. Catalog skills are not the user's data; only the install
    // bookkeeping below references them by id.
    const skillEntry = bundle.entry('library-skills.ndjson')
    const skills = await db
        .select({
            id: librarySkills.id,
            name: librarySkills.name,
            description: librarySkills.description,
            content: librarySkills.content,
            origin: librarySkills.origin,
            createdAt: librarySkills.createdAt,
            updatedAt: librarySkills.updatedAt
        })
        .from(librarySkills)
        .where(eq(librarySkills.userId, userId))
        .orderBy(asc(librarySkills.createdAt), asc(librarySkills.id))
    for (const skill of skills) {
        const files = await db
            .select({
                path: librarySkillFiles.path,
                content: librarySkillFiles.content
            })
            .from(librarySkillFiles)
            .where(eq(librarySkillFiles.librarySkillId, skill.id))
            .orderBy(asc(librarySkillFiles.path))
        await skillEntry.write({ ...skill, files })
    }
    await skillEntry.end()

    const installEntry = bundle.entry('skill-installs.ndjson')
    const installs = await db
        .select({
            id: userSkills.id,
            skillId: userSkills.skillId,
            librarySkillId: userSkills.librarySkillId,
            runtimeId: userSkills.runtimeId,
            agentId: userSkills.agentId,
            framework: userSkills.framework,
            enabled: userSkills.enabled,
            installDir: userSkills.installDir,
            installedVersion: userSkills.installedVersion,
            createdAt: userSkills.createdAt
        })
        .from(userSkills)
        .where(eq(userSkills.userId, userId))
        .orderBy(asc(userSkills.createdAt), asc(userSkills.id))
    for (const row of installs) await installEntry.write(row)
    await installEntry.end()

    const repoEntry = bundle.entry('skill-repos.ndjson')
    const repos = await db
        .select({
            id: skillRepos.id,
            owner: skillRepos.owner,
            name: skillRepos.name,
            branch: skillRepos.branch,
            enabled: skillRepos.enabled,
            createdAt: skillRepos.createdAt
        })
        .from(skillRepos)
        .where(eq(skillRepos.userId, userId))
        .orderBy(asc(skillRepos.createdAt), asc(skillRepos.id))
    for (const row of repos) await repoEntry.write(row)
    await repoEntry.end()
}

async function collectAutomations(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    const entry = bundle.entry('automations.ndjson')
    const rows = await db
        .select({
            id: automations.id,
            agentId: automations.agentId,
            title: automations.title,
            prompt: automations.prompt,
            status: automations.status,
            schedulePreset: automations.schedulePreset,
            rrule: automations.rrule,
            timezone: automations.timezone,
            dtstart: automations.dtstart,
            model: automations.model,
            deliveryChannelId: automations.deliveryChannelId,
            deliveryTarget: automations.deliveryTarget,
            deletedAt: automations.deletedAt,
            createdAt: automations.createdAt,
            updatedAt: automations.updatedAt
        })
        .from(automations)
        .where(eq(automations.userId, userId))
        .orderBy(asc(automations.createdAt), asc(automations.id))
    for (const row of rows) {
        await entry.write({
            ...row,
            deliveryTarget: redactExportValue(row.deliveryTarget)
        })
    }
    await entry.end()
}

async function collectChannels(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    const entry = bundle.entry('channels.ndjson')
    // credentials_ciphertext / key_version are never selected. config_json is
    // NOT credential-free in practice (Lark keeps verificationToken and
    // encryptKey there), hence the redaction pass.
    const rows = await db
        .select({
            id: channels.id,
            agentId: channels.agentId,
            provider: channels.provider,
            label: channels.label,
            status: channels.status,
            externalId: channels.externalId,
            config: channels.configJson,
            createdAt: channels.createdAt,
            updatedAt: channels.updatedAt
        })
        .from(channels)
        .where(eq(channels.userId, userId))
        .orderBy(asc(channels.createdAt), asc(channels.id))
    for (const row of rows) {
        await entry.write({
            ...row,
            config: redactExportValue(row.config)
        })
    }
    await entry.end()
}

async function collectUsage(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    const apiEntry = bundle.entry('usage-api-days.ndjson')
    const apiDays = await db
        .select({
            day: userApiUsageDays.day,
            requestCount: userApiUsageDays.requestCount
        })
        .from(userApiUsageDays)
        .where(eq(userApiUsageDays.userId, userId))
        .orderBy(asc(userApiUsageDays.day))
    for (const row of apiDays) await apiEntry.write(row)
    await apiEntry.end()

    const durationEntry = bundle.entry('usage-active-duration-days.ndjson')
    const durations = await db
        .select({
            hostId: sandboxActiveDurationDays.hostId,
            day: sandboxActiveDurationDays.day,
            activeSeconds: sandboxActiveDurationDays.activeSeconds
        })
        .from(sandboxActiveDurationDays)
        .where(eq(sandboxActiveDurationDays.userId, userId))
        .orderBy(
            asc(sandboxActiveDurationDays.day),
            asc(sandboxActiveDurationDays.hostId)
        )
    for (const row of durations) await durationEntry.write(row)
    await durationEntry.end()
}

async function collectConnections(
    db: Database,
    userId: string,
    bundle: ExportBundleWriter
): Promise<void> {
    // §9.2: provider + external identity only. secret_ciphertext (the
    // Cloudflare API token) is never selected.
    const connectionEntry = bundle.entry('connections.ndjson')
    const connections = await db
        .select({
            id: userConnections.id,
            provider: userConnections.provider,
            kind: userConnections.kind,
            displayName: userConnections.displayName,
            externalId: userConnections.externalId,
            metadata: userConnections.metadata,
            revokedAt: userConnections.revokedAt,
            createdAt: userConnections.createdAt
        })
        .from(userConnections)
        .where(eq(userConnections.userId, userId))
        .orderBy(asc(userConnections.createdAt), asc(userConnections.id))
    for (const row of connections) {
        await connectionEntry.write({
            ...row,
            metadata: redactExportValue(row.metadata)
        })
    }
    await connectionEntry.end()

    const identityEntry = bundle.entry('identities.ndjson')
    const identities = await db
        .select({
            provider: authIdentities.provider,
            subject: authIdentities.subject,
            email: authIdentities.email,
            createdAt: authIdentities.createdAt
        })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId))
        .orderBy(asc(authIdentities.provider), asc(authIdentities.subject))
    for (const row of identities) await identityEntry.write(row)
    await identityEntry.end()
}

async function collectPortDomains(
    args: WriteUserExportArgs,
    bundle: ExportBundleWriter
): Promise<void> {
    const extra = (await args.port.collectUserExport?.(args.userId)) ?? {}
    for (const [key, value] of Object.entries(extra)) {
        let name = `${key.replace(/[^\w.-]/g, '_')}.json`
        // An adapter key that collides with a core entry must not shadow it
        // inside the archive.
        if (bundle.entryNames.includes(name)) name = `port-${name}`
        await bundle.json(name, redactExportValue(value))
    }
}

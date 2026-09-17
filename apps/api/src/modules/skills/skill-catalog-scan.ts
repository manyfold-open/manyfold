import { randomUUID } from 'node:crypto'
import {
    and,
    eq,
    inArray,
    isNull,
    notInArray,
    or,
    sql,
    type SQL
} from 'drizzle-orm'
import {
    skillRepoScans,
    skills,
    type Database,
    type SkillRow
} from '@manyfold/db'
import { trace, SpanStatusCode, metrics, type Span } from '@opentelemetry/api'
import { GitHubRequestError } from '@/common/github-request-error'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import {
    withSkillRequestBudget,
    SKILL_SCAN_LIMITS
} from './github-skill-source'
import {
    snapshotRows,
    type DiscoveryRepo,
    type SkillDiscoveryService
} from './skill-discovery.service'
import { installDirBase } from './skill-utils'
import { suppressTracing } from '@sentry/opentelemetry'

export const SKILL_SCAN_LEASE_MS = 180_000
export type PublishedSkillRow = SkillRow & {
    version: string | null
    installDir: string
}
export class SkillScanBusyError extends GitHubRequestError {
    constructor() {
        super('upstream', 'busy')
    }
}
const FRESH_MS = 6 * 60 * 60 * 1000
const meter = metrics.getMeter('manyfold.skills')
const scans = meter.createCounter('skill.discovery.scans')
const duration = meter.createHistogram('skill.discovery.duration', {
    unit: 'ms'
})
const requests = meter.createHistogram('skill.discovery.requests')

export const canonicalSkillRepoKey = (repo: DiscoveryRepo): string =>
    JSON.stringify([
        repo.owner.toLowerCase(),
        repo.name.toLowerCase(),
        repo.branch
    ])

const published = (
    aliases: Array<{ owner: string; name: string }>,
    repo: DiscoveryRepo
): boolean =>
    aliases.some(
        (alias) => alias.owner === repo.owner && alias.name === repo.name
    )

const repoCond = (repo: DiscoveryRepo): SQL =>
    and(
        eq(skills.repoOwner, repo.owner),
        eq(skills.repoName, repo.name),
        eq(skills.repoBranch, repo.branch)
    ) as SQL

export const staleSkillRepos = async (
    db: Database,
    repos: DiscoveryRepo[]
): Promise<DiscoveryRepo[]> => {
    if (!repos.length) return []
    const states = await db
        .select({
            key: skillRepoScans.key,
            scannedAt: skillRepoScans.scannedAt,
            publishedAliases: skillRepoScans.publishedAliases
        })
        .from(skillRepoScans)
        .where(
            inArray(skillRepoScans.key, [
                ...new Set(repos.map(canonicalSkillRepoKey))
            ])
        )
    const byKey = new Map(states.map((state) => [state.key, state]))
    return repos.filter((repo) => {
        const state = byKey.get(canonicalSkillRepoKey(repo))
        return (
            !state?.scannedAt ||
            Date.now() - state.scannedAt.getTime() > FRESH_MS ||
            !published(state.publishedAliases, repo)
        )
    })
}

// Two repo pipelines per process share the eight-request transport budget.
// A bounded queue avoids retaining an unbounded list of waiting refresh tasks.
let active = 0
const waiting: Array<() => void> = []
const runSlot = async <T>(
    work: () => Promise<T>,
    signal?: AbortSignal
): Promise<T> => {
    if (signal?.aborted) throw new SkillScanBusyError()
    if (active >= 2) {
        if (waiting.length >= 32) throw new SkillScanBusyError()
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', cancel)
            }
            const resume = () => {
                cleanup()
                resolve()
            }
            const cancel = () => {
                const index = waiting.indexOf(resume)
                if (index >= 0) waiting.splice(index, 1)
                cleanup()
                reject(new SkillScanBusyError())
            }
            const timer = setTimeout(cancel, 15_000)
            waiting.push(resume)
            signal?.addEventListener('abort', cancel, { once: true })
            if (signal?.aborted) cancel()
        })
    } else active++
    try {
        return await work()
    } finally {
        const next = waiting.shift()
        if (next) next()
        else active--
    }
}

export const refreshSkillRepo = async (
    db: Database,
    discovery: SkillDiscoveryService,
    repo: DiscoveryRepo,
    signal?: AbortSignal
): Promise<PublishedSkillRow[]> =>
    await runSlot(
        () =>
            inBackgroundContext(() =>
                trace
                    .getTracer('manyfold.skills')
                    .startActiveSpan('skill.discovery.scan', (span) =>
                        suppressTracing(() =>
                            scanAndPublish(db, discovery, repo, span, signal)
                        )
                    )
            )(),
        signal
    )

const scanAndPublish = async (
    db: Database,
    discovery: SkillDiscoveryService,
    repo: DiscoveryRepo,
    span: Span,
    signal?: AbortSignal
): Promise<PublishedSkillRow[]> => {
    const key = canonicalSkillRepoKey(repo)
    const holderId = randomUUID()
    const started = performance.now()
    let outcome = 'failed'
    let count = 0
    let classification = 'none'
    try {
        const [claim] = await db
            .insert(skillRepoScans)
            .values({
                key,
                holderId,
                expiresAt: sql`clock_timestamp() + ${SKILL_SCAN_LEASE_MS} * interval '1 millisecond'`
            })
            .onConflictDoUpdate({
                target: skillRepoScans.key,
                set: {
                    holderId,
                    generation: sql`${skillRepoScans.generation} + 1`,
                    expiresAt: sql`clock_timestamp() + ${SKILL_SCAN_LEASE_MS} * interval '1 millisecond'`,
                    updatedAt: sql`clock_timestamp()`
                },
                setWhere: or(
                    isNull(skillRepoScans.holderId),
                    sql`${skillRepoScans.expiresAt} <= clock_timestamp()`
                )
            })
            .returning()
        // No wait or freshness write: later requests can publish an alias
        // after the canonical owner's successful result is available.
        if (!claim) {
            outcome = 'busy'
            throw new SkillScanBusyError()
        }
        const canonical = {
            ...repo,
            owner: repo.owner.toLowerCase(),
            name: repo.name.toLowerCase()
        }
        const result = await withSkillRequestBudget(async (budget) => {
            try {
                const revision = await discovery.resolveRepoRevision(canonical)
                const unchanged =
                    revision === claim.revision && claim.snapshot !== null
                const snapshot = unchanged
                    ? claim.snapshot!
                    : await discovery.scanRevision(canonical, revision)
                const rows = snapshotRows(repo, revision, snapshot)
                const saved = await db.transaction(async (tx) => {
                    // The row update both fences and locks publication. Takeover
                    // cannot race any part of the following catalog transaction.
                    const [owned] = await tx
                        .update(skillRepoScans)
                        .set({
                            updatedAt: sql`clock_timestamp()`
                        })
                        .where(
                            and(
                                eq(skillRepoScans.key, key),
                                eq(skillRepoScans.holderId, holderId),
                                eq(skillRepoScans.generation, claim.generation),
                                sql`${skillRepoScans.expiresAt} > clock_timestamp()`
                            )
                        )
                        .returning()
                    if (!owned) return null
                    const output: SkillRow[] = []
                    for (let index = 0; index < rows.length; index += 250) {
                        const batch = rows.slice(index, index + 250)
                        output.push(
                            ...(await tx
                                .insert(skills)
                                .values(
                                    batch.map((row) => ({
                                        id: row.skillId,
                                        name: row.name,
                                        description: row.description,
                                        repoOwner: repo.owner,
                                        repoName: repo.name,
                                        repoBranch: repo.branch,
                                        sourcePath: row.sourcePath,
                                        latestRevision: revision,
                                        readmeUrl: row.readmeUrl,
                                        missingSince: null
                                    }))
                                )
                                .onConflictDoUpdate({
                                    target: skills.id,
                                    set: {
                                        name: sql`excluded.name`,
                                        description: sql`coalesce(excluded.description, ${skills.description})`,
                                        latestRevision: sql`excluded.latest_revision`,
                                        readmeUrl: sql`excluded.readme_url`,
                                        missingSince: null,
                                        scannedAt: sql`clock_timestamp()`,
                                        updatedAt: sql`case when ${skills.latestRevision} is distinct from excluded.latest_revision then clock_timestamp() else ${skills.updatedAt} end`
                                    }
                                })
                                .returning())
                        )
                    }
                    await tx
                        .update(skills)
                        .set({
                            missingSince: sql`clock_timestamp()`
                        })
                        .where(
                            and(
                                repoCond(repo),
                                isNull(skills.missingSince),
                                rows.length
                                    ? notInArray(
                                          skills.id,
                                          rows.map((row) => row.skillId)
                                      )
                                    : undefined
                            )
                        )
                    const aliases = unchanged ? owned.publishedAliases : []
                    if (!published(aliases, repo))
                        aliases.push({
                            owner: repo.owner,
                            name: repo.name
                        })
                    if (
                        Buffer.byteLength(
                            JSON.stringify({ snapshot, aliases })
                        ) > SKILL_SCAN_LIMITS.snapshotBytes
                    )
                        throw new GitHubRequestError()
                    const completed = await tx
                        .update(skillRepoScans)
                        .set({
                            revision,
                            snapshot,
                            publishedAliases: aliases,
                            scannedAt: sql`clock_timestamp()`,
                            holderId: null,
                            expiresAt: null,
                            updatedAt: sql`clock_timestamp()`
                        })
                        .where(
                            and(
                                eq(skillRepoScans.key, key),
                                eq(skillRepoScans.holderId, holderId),
                                eq(skillRepoScans.generation, claim.generation),
                                sql`${skillRepoScans.expiresAt} > clock_timestamp()`
                            )
                        )
                        .returning({
                            key: skillRepoScans.key
                        })
                    if (!completed.length) throw new GitHubRequestError()
                    return output
                })
                if (!saved) {
                    outcome = 'superseded'
                    throw new SkillScanBusyError()
                }
                outcome = unchanged ? 'unchanged' : 'changed'
                span.setAttribute('scan.revision', revision)
                span.setAttribute('scan.skills', snapshot.length)
                const metadata = new Map(
                    snapshot.map((item) => [item.sourcePath, item])
                )
                return saved.map((row) => ({
                    ...row,
                    version: metadata.get(row.sourcePath)?.version ?? null,
                    installDir: installDirBase(row.name)
                }))
            } finally {
                count = budget.requests
                span.setAttribute('scan.requests', count)
                span.setAttribute('scan.bytes', budget.bytes)
                if (budget.rateRemaining !== null)
                    span.setAttribute(
                        'scan.rest_remaining',
                        budget.rateRemaining
                    )
            }
        }, signal)
        return result
    } catch (error) {
        if (error instanceof SkillScanBusyError) throw error
        classification =
            error instanceof GitHubRequestError
                ? error.classification
                : 'upstream'
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw new GitHubRequestError(
            classification as GitHubRequestError['classification']
        )
    } finally {
        try {
            await db
                .update(skillRepoScans)
                .set({
                    holderId: null,
                    expiresAt: null
                })
                .where(
                    and(
                        eq(skillRepoScans.key, key),
                        eq(skillRepoScans.holderId, holderId)
                    )
                )
        } catch {}
        span.setAttributes({
            'scan.outcome': outcome,
            'scan.classification': classification
        })
        const attributes = { outcome, classification }
        scans.add(1, attributes)
        duration.record(performance.now() - started, attributes)
        requests.record(count, attributes)
        span.end()
    }
}

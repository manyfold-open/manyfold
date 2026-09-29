import {
    K8S_HOME_BASE,
    SkillFramework,
    codingAgentWorkspacePathForHome
} from '@manyfold/shared'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ResourceChangesService } from '@/modules/resource-events/resource-changes.service'
import { and, eq, sql, isNotNull } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    auditLogs,
    librarySkillFiles,
    librarySkills,
    runtimeHosts,
    skills,
    userSkills,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { RuntimeContextService } from '@/modules/hosts/runtime-context.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import {
    HostDaemonAccess,
    type HostExecResult,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import {
    assertSkillFramework,
    assertSafeGitHubOwner,
    assertSafeGitHubRepo,
    assertSafeGitRef,
    assertSafeInstallDir,
    assertSafeLibraryFilePath,
    assertSafeSourcePath,
    DEFAULT_SKILL_FRAMEWORK,
    installDirBase,
    isManagedSkillWorkspace,
    isStoreActivationFramework,
    libraryStoreKey,
    SKILL_CONTENT_FILENAME,
    skillActivationMode,
    skillActivationSubdir,
    skillStateDirName,
    skillStoreDir,
    skillStoreKey,
    shellEscape,
    type StoreActivationFramework
} from './skill-utils'

interface LockEntry {
    skillId: string
    repoOwner: string
    repoName: string
    repoBranch: string
    sourcePath: string
    installDir: string
    revision: string
    materializedAt: number
}

interface SkillLock {
    version: 1
    skills: Record<string, LockEntry>
}

interface DesiredSkillBase {
    userSkillId: string
    skillId: string
    installDir: string
    revision: string
}

// Two content sources share one reconcile pipeline: GitHub-discovered skills
// download a repo tarball, library skills push DB-stored bytes. `revision` is
// the git sha for github and the contentHash for library, so lock comparison
// and copy-on-write store keys work identically for both.
export type DesiredSkill =
    | (DesiredSkillBase & {
          kind: 'github'
          repoOwner: string
          repoName: string
          repoBranch: string
          sourcePath: string
      })
    | (DesiredSkillBase & {
          kind: 'library'
          librarySkillId: string
          name: string
      })

// Per-skill terminal result of one reconcile pass, mapped back to the
// user_skills row so the store intent and the runtime materialization can be
// reported as distinct states. A single infra failure (probe/lock) produces no
// outcomes and instead marks every enabled row failed via persistOutcomes.
export interface SkillOutcome {
    userSkillId: string
    status: 'installed' | 'failed'
    error?: string
}

// One script on the machine, run by its daemon.
export type HostRun = (script: string, timeoutMs: number) => Promise<HostExecResult>

// Where one agent's skills go, and the machine's daemon to write them with.
// The placement decides the layout: a sandbox and a self-owned computer take
// the host store + workspace activation for claude/codex/gemini on a managed
// workspace; everything else keeps a per-home clone with a lock file — under
// the framework's home on a sandbox or a pod, and namespaced beside the user's
// own skills on a self-owned computer.
export interface MaterializeTarget {
    agentId: string
    runtimeId: string
    userId: string
    framework: SkillFramework
    placement: 'sprites' | 'k8s' | 'daemon'
    hostId: string
    homeDir?: string | null
    // The agent's workspace (turn cwd). Store-activation frameworks symlink/copy
    // their skills into `${workspacePath}/<.claude|.agents>/skills`. Defaults to
    // the managed `${home}/.manyfold/workspaces/${agentId}` path.
    workspacePath?: string | null
    run: HostRun
    // Before a github download: open the machine's outbound access to GitHub
    // where its provider restricts it.
    beforeDownload?: () => Promise<void>
    timeoutMs?: number
}

// Resolved context for the host-store + per-agent-activation path.
interface SkillStoreContext {
    agentId: string
    userId: string
    framework: StoreActivationFramework
    homeDir: string
    // ADR-0014: the host store lives where the registration declared it
    // (daemon hosts), or at the machine-scoped default (sandbox hosts) —
    // never re-derived from homeDir here.
    storeDir: string
    workspacePath: string
    timeoutMs?: number
    run(
        script: string,
        timeoutMs: number
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>
    hasStoreSkill(skillMdPath: string): Promise<boolean>
    beforeDownload?(): Promise<void>
}

export interface RuntimeSkillInventoryItem {
    installDir: string
    name: string
    description: string | null
    sourcePath: string
}

interface SkillMaterializationBackend {
    readLock(): Promise<SkillLock>
    beforeEnsure?(desired: DesiredSkill[]): Promise<void>
    ensureBase(): Promise<void>
    remove(installDir: string): Promise<void>
    hasSkill(skill: DesiredSkill): Promise<boolean>
    install(skill: DesiredSkill): Promise<void>
    writeLock(lock: SkillLock): Promise<void>
}

const EMPTY_LOCK: SkillLock = { version: 1, skills: {} }
const DEFAULT_HERMES_HOME = `${K8S_HOME_BASE}/.hermes`
const HERMES_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const MATERIALIZER_LOCK_NAMESPACE = 2
const SKILL_DOWNLOAD_DOMAINS = [
    'api.github.com',
    'codeload.github.com',
    // github.com is needed for the sparse-checkout fast path (git clone/fetch);
    // codeload is only hit by the full-tarball fallback.
    'github.com'
]
// Store downloads get their own generous ceiling instead of the generic 60s
// exec timeout: the sparse fast path is small, but a full-tarball fallback for
// a large repo can legitimately take minutes. Materialization is async now
// (#341 Phase 1), so a long download no longer blocks the install request.
const SKILL_STORE_DOWNLOAD_TIMEOUT_MS = 300_000

@Injectable()
export class SkillMaterializerService {
    private readonly log = new Logger(SkillMaterializerService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimeContext: RuntimeContextService,
        private readonly hostProviders: HostProviderResolver,
        private readonly hostAccess: HostDaemonAccess,
        @Optional() private readonly changes?: ResourceChangesService
    ) {}

    async materializeReadyRuntimes(
        userId: string,
        framework: SkillFramework = DEFAULT_SKILL_FRAMEWORK
    ): Promise<void> {
        const safeFramework = assertSkillFramework(framework)
        const runtimes = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.userId, userId),
                    eq(agentRuntimes.framework, safeFramework),
                    isNotNull(agentRuntimes.hostId),
                    eq(agentRuntimes.status, 'ready')
                )
            )
        await Promise.all(
            runtimes.map((runtime) => this.materializeRuntimeRow(runtime))
        )
    }

    async materializeRuntime(runtimeId: string): Promise<void> {
        const [runtime] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        if (!runtime) return
        await this.materializeRuntimeRow(runtime)
    }

    async materializeAgent(agentId: string): Promise<SkillOutcome[]> {
        const [row] = await this.db
            .select({ agent: agents, runtime: agentRuntimes })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agents.runtimeId, agentRuntimes.id))
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!row) return []
        return this.materializeAgentRow(row.agent, row.runtime)
    }

    private async materializeRuntimeRow(
        runtime: AgentRuntimeRow
    ): Promise<void> {
        if (runtime.status !== 'ready' || !runtime.hostId) return
        let framework: SkillFramework
        try {
            framework = assertSkillFramework(runtime.framework)
        } catch {
            return
        }
        const agentRows = await this.db
            .select()
            .from(agents)
            .where(
                and(
                    eq(agents.userId, runtime.userId),
                    eq(agents.runtimeId, runtime.id),
                    eq(agents.framework, framework)
                )
            )
        await Promise.all(
            agentRows.map((agent) => this.materializeAgentRow(agent, runtime))
        )
    }

    // Where the skills land is a fact of the runtime's host (ADR-0037), and
    // everything is written through the host's daemon, under its awake hold: a
    // hosted machine is woken and its daemon brought up, a self-owned computer
    // only while online.
    private async materializeAgentRow(
        agent: Agent,
        runtime: AgentRuntimeRow
    ): Promise<SkillOutcome[]> {
        if (runtime.status !== 'ready' || !runtime.hostId) return []
        const ctx = await this.runtimeContext.forRuntime(runtime.id)
        if (!ctx?.host || ctx.host.status !== 'ready') return []
        if (ctx.host.kind === 'local' && !ctx.daemonOnline) return []
        if (ctx.placement === 'external') return []
        const placement = ctx.placement
        const host = ctx.host
        let framework: SkillFramework
        try {
            framework = assertSkillFramework(agent.framework)
        } catch {
            return []
        }
        if (runtime.userId !== agent.userId || runtime.framework !== framework)
            return []
        try {
            // persistOutcomes writes each row's terminal status on success and,
            // on an infra throw (probe/lock/account) that yields no per-skill
            // outcomes, marks every enabled row failed — so a swallowed error
            // here can never leave a row reported as installed.
            return await this.persistOutcomes(agent.id, () =>
                this.hostAccess.withHost(
                    {
                        host,
                        daemon: ctx.daemon,
                        placement,
                        agentId: agent.id,
                        reason: `skills-${agent.id}`
                    },
                    (session) =>
                        this.materializeOn({
                            agentId: agent.id,
                            runtimeId: runtime.id,
                            userId: runtime.userId,
                            framework,
                            placement,
                            hostId: host.id,
                            homeDir:
                                placement === 'k8s'
                                    ? k8sHomeDirForAgent(agent, runtime, framework)
                                    : host.homeDir,
                            workspacePath: agent.workspacePath,
                            run: runOn(session),
                            beforeDownload:
                                host.kind === 'hosted'
                                    ? () => this.allowSkillDownloads(host)
                                    : undefined
                        })
                )
            )
        } catch (err) {
            const message = (err as Error).message
            this.log.warn(
                `skills materialize failed agent=${agent.id} runtime=${runtime.id}: ${message}`
            )
            await this.audit(
                runtime.userId,
                'skills.materialize_failed',
                agent.id,
                {
                    agentId: agent.id,
                    runtimeId: runtime.id,
                    hostId: runtime.hostId,
                    message
                }
            )
            // persistOutcomes already marked the enabled rows failed in the DB;
            // the empty list just means this caller has no per-skill result to
            // overlay (the durable state is authoritative).
            return []
        }
    }

    // A provider that restricts the machine's outbound access opens it to
    // GitHub for the download.
    private async allowSkillDownloads(host: RuntimeHostRow): Promise<void> {
        const { provider, adapter } = await this.hostProviders.resolve(host)
        await adapter.allowEgress?.({ host, provider }, SKILL_DOWNLOAD_DOMAINS)
    }

    // One agent's skills on its machine. Store-activation frameworks on a
    // managed workspace take the host store: the download-once store under a
    // HOST-level lock across co-resident agents, then the per-agent activation
    // under the agent's lock — never nested, always the host lock first.
    // Everything else reconciles a per-home clone under the agent's lock.
    async materializeOn(target: MaterializeTarget): Promise<SkillOutcome[]> {
        const framework = target.framework
        if (target.placement === 'daemon' && framework === 'hermes') {
            this.log.warn(
                `skill materialize for daemon skipped: hermes is k8s-only`
            )
            return []
        }
        const homeDir =
            target.homeDir ??
            (await this.probeHome(target.run, target.timeoutMs))
        const workspacePath =
            target.workspacePath ??
            codingAgentWorkspacePathForHome(homeDir, target.agentId)
        if (
            target.placement !== 'k8s' &&
            isStoreActivationFramework(framework) &&
            isManagedSkillWorkspace(workspacePath)
        ) {
            const ctx: SkillStoreContext = {
                agentId: target.agentId,
                userId: target.userId,
                framework,
                homeDir,
                storeDir:
                    (target.placement === 'daemon'
                        ? await this.declaredSkillsDir(target.hostId)
                        : null) ?? skillStoreDir(homeDir),
                workspacePath,
                timeoutMs: target.timeoutMs,
                run: target.run,
                hasStoreSkill: async (path) =>
                    (
                        await target.run(
                            `test -f ${shellEscape(path)}`,
                            target.timeoutMs ?? 15_000
                        )
                    ).exitCode === 0,
                beforeDownload: target.beforeDownload
            }
            return this.runStorePhases(
                ctx,
                storeLockKey(target.userId, target.hostId)
            )
        }
        const layout = cloneLayout(target.placement, homeDir, framework)
        return this.withLock(
            materializationLockKey(target.userId, target.agentId),
            () =>
                this.materializeDesiredSkills(
                    target.agentId,
                    this.cloneBackend(target, layout)
                )
        )
    }

    private cloneBackend(
        target: MaterializeTarget,
        layout: CloneLayout
    ): SkillMaterializationBackend {
        const { run, timeoutMs } = target
        const dirOf = (installDir: string): string =>
            `${layout.skillsDir}/${layout.installDirOf(installDir)}`
        return {
            readLock: () => this.readLock(run, layout.lockPath, timeoutMs),
            beforeEnsure: async (desired) => {
                if (desired.some((skill) => skill.kind === 'github'))
                    await target.beforeDownload?.()
            },
            ensureBase: () =>
                this.ensureBase(run, layout.baseDir, layout.skillsDir, timeoutMs),
            remove: (installDir) => this.rm(run, dirOf(installDir), timeoutMs),
            hasSkill: (skill) =>
                this.statFile(
                    run,
                    `${dirOf(skill.installDir)}/SKILL.md`,
                    timeoutMs
                ),
            install: (skill) =>
                this.installSkill(
                    run,
                    layout.skillsDir,
                    skill,
                    layout.installDirOf(skill.installDir),
                    timeoutMs
                ),
            writeLock: (lock) =>
                this.writeFile(
                    run,
                    layout.lockPath,
                    `${JSON.stringify(lock, null, 2)}\n`,
                    '600',
                    timeoutMs
                )
        }
    }

    // Run a per-agent reconcile and persist its per-skill status. A successful
    // pass writes each row installed/failed; a thrown infra error (before any
    // per-skill outcome) marks every enabled row failed and rethrows so callers
    // that need to surface provisioning failures still can.
    private async persistOutcomes(
        agentId: string,
        produce: () => Promise<SkillOutcome[]>
    ): Promise<SkillOutcome[]> {
        try {
            const outcomes = await produce()
            await this.writeSkillStatuses(outcomes)
            return outcomes
        } catch (err) {
            await this.markDesiredFailed(
                agentId,
                sanitizeMaterializeReason(err)
            ).catch((markErr) =>
                this.log.warn(
                    `mark skills failed agent=${agentId}: ${(markErr as Error).message}`
                )
            )
            throw err
        }
    }

    private async writeSkillStatuses(
        outcomes: SkillOutcome[]
    ): Promise<void> {
        for (const outcome of outcomes) {
            const rows = await this.db
                .update(userSkills)
                .set(
                    outcome.status === 'installed'
                        ? {
                              materializeStatus: 'installed',
                              materializeError: null,
                              materializedAt: new Date()
                          }
                        : {
                              materializeStatus: 'failed',
                              materializeError:
                                  outcome.error ?? 'materialization failed'
                          }
                )
                .where(eq(userSkills.id, outcome.userSkillId))
                .returning()
            for (const row of rows)
                this.changes?.emit(row.userId, { resource: 'skill', resourceId: row.id, agentId: row.agentId ?? undefined, reason: 'updated' })
        }
    }

    private async markDesiredFailed(
        agentId: string,
        reason: string
    ): Promise<void> {
        const rows = await this.db
            .update(userSkills)
            .set({ materializeStatus: 'failed', materializeError: reason })
            .where(
                and(
                    eq(userSkills.agentId, agentId),
                    eq(userSkills.enabled, true)
                )
            )
            .returning()
        for (const row of rows)
            this.changes?.emit(row.userId, { resource: 'skill', resourceId: row.id, agentId, reason: 'updated' })
    }

    async listHermesRuntimeSkills(input: {
        agent: Agent
        runtime: AgentRuntimeRow
        timeoutMs?: number
    }): Promise<RuntimeSkillInventoryItem[]> {
        if (input.agent.framework !== 'hermes') return []
        if (input.runtime.framework !== 'hermes') return []
        if (input.runtime.status !== 'ready') return []
        const ctx = await this.runtimeContext.forRuntime(input.runtime.id)
        if (!ctx?.host || ctx.placement !== 'k8s') return []
        const host = ctx.host
        const profileHome = hermesProfileHome(
            input.runtime.mountPath || DEFAULT_HERMES_HOME,
            input.agent.internalId
        )
        return this.hostAccess.withHost(
            {
                host,
                daemon: ctx.daemon,
                placement: ctx.placement,
                agentId: input.agent.id,
                reason: `skills-inventory-${input.agent.id}`
            },
            (session) =>
                this.scanHermesSkills(
                    runOn(session),
                    profileHome,
                    input.timeoutMs ?? 30_000
                )
        )
    }

    // Two-phase store materialize: host-store lock (download-once) then
    // per-agent lock (workspace activation). Never nested — always host-store
    // lock first.
    private async runStorePhases(
        ctx: SkillStoreContext,
        hostStoreLockKey: string
    ): Promise<SkillOutcome[]> {
        const desired = await this.loadDesired(ctx.agentId)
        // userSkillId -> sanitized reason; populate + activate record per-skill
        // failures here so one bad skill never aborts its co-desired siblings.
        const failed = new Map<string, string>()
        await this.withLock(hostStoreLockKey, () =>
            this.populateStore(ctx, desired, failed)
        )
        await this.withLock(
            materializationLockKey(ctx.userId, ctx.agentId),
            () => this.activateWorkspace(ctx, desired, failed)
        )
        return desired.map((skill) =>
            failed.has(skill.userSkillId)
                ? {
                      userSkillId: skill.userSkillId,
                      status: 'failed' as const,
                      error: failed.get(skill.userSkillId)
                  }
                : {
                      userSkillId: skill.userSkillId,
                      status: 'installed' as const
                  }
        )
    }

    // Phase A — download each desired skill once into the host store
    // `${home}/.manyfold/skills/<skillKey>`. Skips keys already present, so
    // co-resident agents share one copy. GC is deferred for MVP.
    private async populateStore(
        ctx: SkillStoreContext,
        desired: DesiredSkill[],
        failed: Map<string, string>
    ): Promise<void> {
        if (desired.length === 0) return
        // Library skills are pushed from the DB, no network involved — only a
        // github download needs the sprite's network policy opened up.
        if (desired.some((skill) => skill.kind === 'github'))
            await ctx.beforeDownload?.()
        const storeDir = ctx.storeDir
        await this.ensureDir(ctx, storeDir)
        await this.pruneStaleStoreTmp(ctx, storeDir)
        for (const skill of desired) {
            const key = storeKeyFor(skill)
            try {
                if (!(await ctx.hasStoreSkill(`${storeDir}/${key}/SKILL.md`)))
                    await this.installToStore(ctx, storeDir, skill, key)
            } catch (err) {
                failed.set(skill.userSkillId, sanitizeMaterializeReason(err))
            }
        }
    }

    // Phase B — reconcile the agent's workspace activation set to exactly its
    // desired skills: claude/gemini get symlinks into the store, codex gets real
    // copies (it ignores symlinked skill dirs). The activation set IS the per-
    // agent state — no `.skill-lock.json` here.
    private async activateWorkspace(
        ctx: SkillStoreContext,
        desired: DesiredSkill[],
        failed: Map<string, string>
    ): Promise<void> {
        const storeDir = ctx.storeDir
        const activationDir = `${ctx.workspacePath}/${skillActivationSubdir(ctx.framework)}`
        const mode = skillActivationMode(ctx.framework)
        await this.ensureDir(ctx, activationDir)
        const current = await this.listActivation(ctx, activationDir, mode)
        const desiredByDir = new Map<string, string>()
        for (const skill of desired)
            desiredByDir.set(skill.installDir, storeKeyFor(skill))
        for (const installDir of current.keys())
            if (!desiredByDir.has(installDir))
                await this.removeActivation(ctx, activationDir, installDir, mode)
        for (const skill of desired) {
            // A skill whose store copy failed to populate keeps whatever
            // activation it already had: don't re-link or tear it down on a
            // transient download failure.
            if (failed.has(skill.userSkillId)) continue
            const key = storeKeyFor(skill)
            try {
                if (current.get(skill.installDir) !== key)
                    await this.activateSkill(
                        ctx,
                        activationDir,
                        storeDir,
                        skill.installDir,
                        key,
                        mode
                    )
                await this.verifyActivation(
                    ctx,
                    activationDir,
                    skill.installDir
                )
            } catch (err) {
                failed.set(skill.userSkillId, sanitizeMaterializeReason(err))
            }
        }
    }

    // Confirm the activated skill is actually loadable: `test -e` follows a
    // symlink (so a dangling link fails) and checks the copied dir's SKILL.md,
    // turning a silently-broken activation into a reported failure.
    private async verifyActivation(
        ctx: SkillStoreContext,
        activationDir: string,
        installDir: string
    ): Promise<void> {
        await this.runChecked(
            ctx,
            `test -e ${shellEscape(`${activationDir}/${installDir}/${SKILL_CONTENT_FILENAME}`)}`,
            ctx.timeoutMs ?? 30_000,
            `verify activation ${installDir}`
        )
    }

    private async runChecked(
        ctx: SkillStoreContext,
        script: string,
        timeoutMs: number,
        label: string
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const result = await ctx.run(script, timeoutMs)
        if (result.exitCode !== 0)
            throw new Error(
                `${label} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
        return result
    }

    private async ensureDir(
        ctx: SkillStoreContext,
        dir: string
    ): Promise<void> {
        await this.runChecked(
            ctx,
            `mkdir -p ${shellEscape(dir)}`,
            ctx.timeoutMs ?? 30_000,
            `mkdir ${dir}`
        )
    }

    // A SIGKILL'd download can't run its `trap … EXIT`, so a half-written
    // `.tmp.*` (or library `.tmp-lib-*`) dir — up to a full tarball — can be
    // orphaned in the store. Sweep ones older than an hour; best-effort so a
    // cleanup hiccup never fails materialization, and the age guard never races
    // an in-flight sibling download.
    private async pruneStaleStoreTmp(
        ctx: SkillStoreContext,
        storeDir: string
    ): Promise<void> {
        await ctx
            .run(
                `find ${shellEscape(storeDir)} -maxdepth 1 -name '.tmp*' -mmin +60 -exec rm -rf -- {} + 2>/dev/null || true`,
                ctx.timeoutMs ?? 30_000
            )
            .catch(() => undefined)
    }

    private async installToStore(
        ctx: SkillStoreContext,
        storeDir: string,
        skill: DesiredSkill,
        key: string
    ): Promise<void> {
        if (skill.kind === 'library') {
            await this.installLibraryTree(
                (script, timeoutMs) => ctx.run(script, timeoutMs),
                storeDir,
                `${storeDir}/${key}`,
                skill,
                ctx.timeoutMs ?? 60_000
            )
            return
        }
        const httpsUrl = `https://github.com/${skill.repoOwner}/${skill.repoName}.git`
        const tarUrl = `https://codeload.github.com/${skill.repoOwner}/${skill.repoName}/tar.gz/${encodeURIComponent(
            skill.revision
        )}`
        const dest = `${storeDir}/${key}`
        // Fast path: sparse-fetch only the skill's own subtree so a huge source
        // repo (issue #341 saw ~597 MiB) downloads just its few-MB skill dir.
        // Any problem — no git, clone/fetch fails, or the sparse tree lacks
        // SKILL.md — falls through to the full-repo tarball, so behavior never
        // regresses. Stage under the store dir then atomically `mv` so a
        // concurrent reader never sees a half-written `<skillKey>` dir.
        const script = [
            'set -eu',
            `store=${shellEscape(storeDir)}`,
            'mkdir -p "$store"',
            'tmp="$(mktemp -d "$store/.tmp.XXXXXX")"',
            'trap \'rm -rf "$tmp"\' EXIT',
            'mkdir -p "$tmp/staged"',
            `url=${shellEscape(httpsUrl)}`,
            `ref=${shellEscape(skill.revision)}`,
            `tar_url=${shellEscape(tarUrl)}`,
            skill.sourcePath === '.'
                ? 'path=.'
                : `path=${shellEscape(skill.sourcePath)}`,
            'staged=""',
            'if [ "$path" != "." ] && command -v git >/dev/null 2>&1; then',
            '  if (',
            '    set -e',
            '    git init -q "$tmp/repo"',
            '    cd "$tmp/repo"',
            '    git remote add origin "$url"',
            '    git sparse-checkout set "$path" >/dev/null 2>&1',
            '    git -c protocol.version=2 fetch -q --depth 1 --filter=blob:none origin "$ref"',
            '    git checkout -q FETCH_HEAD',
            '  ) >/dev/null 2>&1 && [ -f "$tmp/repo/$path/SKILL.md" ]; then',
            '    cp -a "$tmp/repo/$path/." "$tmp/staged/"',
            '    staged=1',
            '  fi',
            'fi',
            'if [ -z "$staged" ]; then',
            '  rm -rf "$tmp/repo"',
            '  curl -fsSL "$tar_url" -o "$tmp/repo.tgz"',
            '  mkdir -p "$tmp/repo"',
            '  tar -xzf "$tmp/repo.tgz" -C "$tmp/repo"',
            '  root="$(find "$tmp/repo" -mindepth 1 -maxdepth 1 -type d | head -n 1)"',
            '  test -n "$root"',
            '  if [ "$path" = "." ]; then src="$root"; else src="$root/$path"; fi',
            '  test -f "$src/SKILL.md"',
            '  cp -a "$src/." "$tmp/staged/"',
            'fi',
            'test -f "$tmp/staged/SKILL.md"',
            `dest=${shellEscape(dest)}`,
            'rm -rf -- "$dest"',
            'mv "$tmp/staged" "$dest"'
        ].join('\n')
        await this.runChecked(
            ctx,
            script,
            Math.max(ctx.timeoutMs ?? 0, SKILL_STORE_DOWNLOAD_TIMEOUT_MS),
            `store skill ${key}`
        )
    }

    // Push a library skill's DB-stored files onto the host over plain exec —
    // no network, no tar. Content travels as base64 chunks inside the script
    // itself (kept well under MAX_ARG_STRLEN and daemon RPC frame limits), so
    // the same writer works over sprite REST, daemon RPC and k8s exec without
    // any stdin wire support. Staged into a sibling tmp dir then atomically
    // `mv`-ed, mirroring installToStore.
    private async installLibraryTree(
        run: LibraryScriptRunner,
        parentDir: string,
        dest: string,
        skill: Extract<DesiredSkill, { kind: 'library' }>,
        timeoutMs: number
    ): Promise<void> {
        const bundle = await this.loadLibraryBundle(skill.librarySkillId)
        if (!bundle)
            throw new Error(
                `library skill ${skill.librarySkillId} no longer exists`
            )
        const entries = [
            { path: SKILL_CONTENT_FILENAME, content: bundle.content },
            ...bundle.files.map((file) => ({
                path: assertSafeLibraryFilePath(file.path),
                content: file.content
            }))
        ]
        const staged = `${parentDir}/.tmp-lib-${randomUUID()}`
        const label = `library skill ${skill.installDir}`
        try {
            await runLibraryScript(
                run,
                `set -eu\nmkdir -p ${shellEscape(staged)}`,
                timeoutMs,
                label
            )
            for (const script of buildLibraryWriteScripts(staged, entries))
                await runLibraryScript(run, script, timeoutMs, label)
            await runLibraryScript(
                run,
                [
                    'set -eu',
                    `test -f ${shellEscape(`${staged}/${SKILL_CONTENT_FILENAME}`)}`,
                    `rm -rf -- ${shellEscape(dest)}`,
                    `mv ${shellEscape(staged)} ${shellEscape(dest)}`
                ].join('\n'),
                timeoutMs,
                label
            )
        } catch (err) {
            await run(`rm -rf -- ${shellEscape(staged)}`, 30_000).catch(
                () => undefined
            )
            throw err
        }
    }

    // installDir -> storeKey for the activation entries we own. Symlink mode:
    // readlink each symlink, key = basename(target). Copy mode (codex): read the
    // `.mf-skillkey` marker written alongside each copy. Foreign entries (real
    // dirs in symlink mode, markerless dirs in copy mode) are omitted so the
    // reconcile never touches them.
    private async listActivation(
        ctx: SkillStoreContext,
        activationDir: string,
        mode: 'symlink' | 'copy'
    ): Promise<Map<string, string>> {
        const script =
            mode === 'symlink'
                ? [
                      'set -eu',
                      `dir=${shellEscape(activationDir)}`,
                      '[ -d "$dir" ] || exit 0',
                      'for e in "$dir"/*; do',
                      '  [ -L "$e" ] || continue',
                      '  printf "%s\\t%s\\n" "$(basename "$e")" "$(basename "$(readlink "$e")")"',
                      'done'
                  ].join('\n')
                : [
                      'set -eu',
                      `dir=${shellEscape(activationDir)}`,
                      '[ -d "$dir" ] || exit 0',
                      'for e in "$dir"/*/; do',
                      '  [ -f "$e/.mf-skillkey" ] || continue',
                      '  printf "%s\\t%s\\n" "$(basename "$e")" "$(cat "$e/.mf-skillkey")"',
                      'done'
                  ].join('\n')
        const result = await this.runChecked(
            ctx,
            script,
            ctx.timeoutMs ?? 30_000,
            `list activation ${activationDir}`
        )
        const map = new Map<string, string>()
        for (const line of result.stdout.split('\n')) {
            if (!line) continue
            const tab = line.indexOf('\t')
            if (tab < 0) continue
            map.set(line.slice(0, tab), line.slice(tab + 1))
        }
        return map
    }

    private async activateSkill(
        ctx: SkillStoreContext,
        activationDir: string,
        storeDir: string,
        installDir: string,
        key: string,
        mode: 'symlink' | 'copy'
    ): Promise<void> {
        const dest = `${activationDir}/${installDir}`
        const source = `${storeDir}/${key}`
        const script =
            mode === 'symlink'
                ? [
                      'set -eu',
                      `d=${shellEscape(dest)}`,
                      `s=${shellEscape(source)}`,
                      'if [ -L "$d" ]; then [ "$(readlink "$d")" = "$s" ] && exit 0; rm -f "$d"; fi',
                      'if [ -e "$d" ]; then echo "refuse: real path at $d" >&2; exit 3; fi',
                      'ln -s "$s" "$d"'
                  ].join('\n')
                : [
                      'set -eu',
                      `d=${shellEscape(dest)}`,
                      `s=${shellEscape(source)}`,
                      'rm -rf -- "$d"',
                      'cp -a "$s" "$d"',
                      `printf "%s" ${shellEscape(key)} > "$d/.mf-skillkey"`
                  ].join('\n')
        await this.runChecked(
            ctx,
            script,
            ctx.timeoutMs ?? 30_000,
            `activate ${installDir}`
        )
    }

    // Remove an activation entry we own — a symlink (symlink mode) or a copy
    // bearing our `.mf-skillkey` marker (copy mode). Never touches a real dir or
    // markerless entry the agent created itself.
    private async removeActivation(
        ctx: SkillStoreContext,
        activationDir: string,
        installDir: string,
        mode: 'symlink' | 'copy'
    ): Promise<void> {
        const dest = `${activationDir}/${installDir}`
        const guarded =
            mode === 'symlink'
                ? `d=${shellEscape(dest)}; if [ -L "$d" ]; then rm -f "$d"; fi`
                : `d=${shellEscape(dest)}; if [ -f "$d/.mf-skillkey" ]; then rm -rf -- "$d"; fi`
        await this.runChecked(
            ctx,
            `set -eu; ${guarded}`,
            ctx.timeoutMs ?? 30_000,
            `remove activation ${installDir}`
        )
    }

    private async materializeDesiredSkills(
        agentId: string,
        backend: SkillMaterializationBackend
    ): Promise<SkillOutcome[]> {
        const [desired, lock] = await Promise.all([
            this.loadDesired(agentId),
            backend.readLock()
        ])
        await backend.beforeEnsure?.(desired)
        await backend.ensureBase()

        const nextLock: SkillLock = { version: 1, skills: {} }
        const desiredByInstallDir = new Map(
            desired.map((skill) => [skill.installDir, skill])
        )

        for (const installDir of Object.keys(lock.skills)) {
            if (!desiredByInstallDir.has(installDir))
                await backend.remove(installDir)
        }

        const outcomes: SkillOutcome[] = []
        for (const skill of desired) {
            try {
                const lockEntry = lock.skills[skill.installDir]
                const skillMd = await backend.hasSkill(skill)
                const current =
                    lockEntry?.skillId === skill.skillId &&
                    lockEntry.revision === skill.revision &&
                    skillMd
                if (!current) await backend.install(skill)
                nextLock.skills[skill.installDir] = lockEntryFor(skill)
                outcomes.push({
                    userSkillId: skill.userSkillId,
                    status: 'installed'
                })
            } catch (err) {
                // Keep any prior lock entry so the next reconcile retries this
                // skill instead of treating it as already materialized.
                if (lock.skills[skill.installDir])
                    nextLock.skills[skill.installDir] =
                        lock.skills[skill.installDir]
                outcomes.push({
                    userSkillId: skill.userSkillId,
                    status: 'failed',
                    error: sanitizeMaterializeReason(err)
                })
            }
        }

        await backend.writeLock(nextLock)
        return outcomes
    }

    protected async loadDesired(agentId: string): Promise<DesiredSkill[]> {
        const scope = and(
            eq(userSkills.agentId, agentId),
            eq(userSkills.enabled, true)
        )
        const [rows, libraryRows] = await Promise.all([
            this.db
                .select({ userSkill: userSkills, skill: skills })
                .from(userSkills)
                .innerJoin(skills, eq(userSkills.skillId, skills.id))
                .where(scope),
            this.db
                .select({ userSkill: userSkills, library: librarySkills })
                .from(userSkills)
                .innerJoin(
                    librarySkills,
                    eq(userSkills.librarySkillId, librarySkills.id)
                )
                .where(scope)
        ])
        return [
            ...rows.map(
                ({ userSkill, skill }): DesiredSkill => ({
                    kind: 'github',
                    userSkillId: userSkill.id,
                    skillId: skill.id,
                    installDir: assertSafeInstallDir(userSkill.installDir),
                    repoOwner: assertSafeGitHubOwner(skill.repoOwner),
                    repoName: assertSafeGitHubRepo(skill.repoName),
                    repoBranch: assertSafeGitRef(skill.repoBranch),
                    sourcePath: assertSafeSourcePath(skill.sourcePath),
                    revision:
                        skill.latestRevision ??
                        userSkill.installedRevision ??
                        skill.repoBranch
                })
            ),
            ...libraryRows.map(
                ({ userSkill, library }): DesiredSkill => ({
                    kind: 'library',
                    userSkillId: userSkill.id,
                    skillId: library.id,
                    installDir: assertSafeInstallDir(userSkill.installDir),
                    librarySkillId: library.id,
                    name: library.name,
                    revision: library.contentHash
                })
            )
        ]
    }

    private async loadLibraryBundle(librarySkillId: string): Promise<{
        content: string
        files: { path: string; content: string }[]
    } | null> {
        const [skill] = await this.db
            .select()
            .from(librarySkills)
            .where(eq(librarySkills.id, librarySkillId))
            .limit(1)
        if (!skill) return null
        const files = await this.db
            .select()
            .from(librarySkillFiles)
            .where(eq(librarySkillFiles.librarySkillId, librarySkillId))
        return {
            content: skill.content,
            files: files.map((file) => ({
                path: file.path,
                content: file.content
            }))
        }
    }

    protected async scanHermesSkills(
        run: HostRun,
        profileHome: string,
        timeoutMs: number
    ): Promise<RuntimeSkillInventoryItem[]> {
        const skillsDir = `${profileHome}/skills`
        const script = [
            'set -eu',
            `root=${shellEscape(skillsDir)}`,
            'if [ ! -d "$root" ]; then printf "[]"; exit 0; fi',
            "py=''",
            'for candidate in python3 python /opt/hermes/hermes-agent/.venv/bin/python3 /opt/hermes/hermes-agent/.venv/bin/python; do',
            '  if command -v "$candidate" >/dev/null 2>&1; then py="$(command -v "$candidate")"; break; fi',
            '  if [ -x "$candidate" ]; then py="$candidate"; break; fi',
            'done',
            'if [ -z "$py" ]; then echo "python interpreter not found" >&2; exit 127; fi',
            'HERMES_SCAN_SKILLS="$root" "$py" - <<\'MF_HERMES_SCAN_PY\'',
            'import json, os',
            'root = os.environ["HERMES_SCAN_SKILLS"]',
            'excluded = {".git", ".github", "__pycache__"}',
            'def parse_frontmatter(raw):',
            '    meta = {}',
            '    body = raw',
            '    if raw.startswith("---"):',
            '        end = raw.find("\\n---", 3)',
            '        if end >= 0:',
            '            front = raw[3:end]',
            '            body = raw[end + 4:]',
            '            try:',
            '                import yaml',
            '                parsed = yaml.safe_load(front)',
            '                if isinstance(parsed, dict):',
            '                    meta = parsed',
            '            except Exception:',
            '                for line in front.splitlines():',
            '                    if ":" in line:',
            '                        key, value = line.split(":", 1)',
            '                        meta[key.strip()] = value.strip().strip("\'\\"")',
            '    return meta, body',
            'def parse_skill(path):',
            '    with open(path, "r", encoding="utf-8", errors="ignore") as handle:',
            '        raw = handle.read(65536)',
            '    meta, body = parse_frontmatter(raw)',
            '    name = meta.get("name")',
            '    description = meta.get("description")',
            '    if not name:',
            '        for line in body.splitlines():',
            '            line = line.strip()',
            '            if line.startswith("# "):',
            '                name = line[2:].strip()',
            '                break',
            '    if not description:',
            '        for line in body.splitlines():',
            '            line = line.strip()',
            '            if line and not line.startswith("#"):',
            '                description = line',
            '                break',
            '    return str(name or ""), str(description or "") or None',
            'items = []',
            'seen = set()',
            'for dirpath, dirnames, filenames in os.walk(root):',
            '    dirnames[:] = [d for d in dirnames if d not in excluded]',
            '    if "SKILL.md" not in filenames:',
            '        continue',
            '    rel = os.path.relpath(dirpath, root).replace(os.sep, "/")',
            '    install_dir = os.path.basename(dirpath)',
            '    if not install_dir or install_dir in seen:',
            '        continue',
            '    seen.add(install_dir)',
            '    name, description = parse_skill(os.path.join(dirpath, "SKILL.md"))',
            '    items.append({"installDir": install_dir[:128], "name": (name or install_dir)[:256], "description": description[:1024] if description else None, "sourcePath": rel[:512]})',
            '    if len(items) >= 500:',
            '        break',
            'print(json.dumps(items))',
            'MF_HERMES_SCAN_PY'
        ].join('\n')
        const result = await run(script, timeoutMs)
        if (result.exitCode !== 0)
            throw new Error(
                `scan hermes skills exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
        let parsed: unknown
        try {
            parsed = JSON.parse(result.stdout)
        } catch {
            throw new Error('scan hermes skills returned invalid JSON')
        }
        if (!Array.isArray(parsed)) return []
        const output: RuntimeSkillInventoryItem[] = []
        const seen = new Set<string>()
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue
            const raw = item as Record<string, unknown>
            try {
                const installDir = assertSafeInstallDir(
                    installDirBase(String(raw.installDir ?? ''))
                )
                if (seen.has(installDir)) continue
                seen.add(installDir)
                output.push({
                    installDir,
                    name: String(raw.name ?? installDir).slice(0, 256),
                    description:
                        raw.description === null ||
                        raw.description === undefined
                            ? null
                            : String(raw.description).slice(0, 1024),
                    sourcePath: assertSafeSourcePath(
                        String(raw.sourcePath ?? installDir)
                    )
                })
            } catch {
                continue
            }
        }
        return output
    }

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${key}, ${MATERIALIZER_LOCK_NAMESPACE}))`
            )
            return fn()
        })
    }

    // ADR-0014: daemon hosts declare their skill store at registration; the
    // homeDir-derived default only covers rows registered before that.
    private async declaredSkillsDir(hostId: string): Promise<string | null> {
        const [host] = await this.db
            .select({ skillsDir: runtimeHosts.skillsDir })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        return host?.skillsDir ?? null
    }

    private async probeHome(run: HostRun, timeoutMs?: number): Promise<string> {
        const result = await run('printf "%s" "$HOME"', timeoutMs ?? 15_000)
        if (result.exitCode !== 0)
            throw new Error(`home probe exited ${result.exitCode}`)
        return result.stdout.trim() || '/root'
    }

    private async readLock(
        run: HostRun,
        lockPath: string,
        timeoutMs?: number
    ): Promise<SkillLock> {
        const result = await run(
            `test -f ${shellEscape(lockPath)} || exit 66; cat ${shellEscape(lockPath)}`,
            timeoutMs ?? 30_000
        )
        if (result.exitCode === 66) return EMPTY_LOCK
        if (result.exitCode !== 0)
            throw new Error(
                `read skills lock exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
        try {
            const parsed = JSON.parse(result.stdout)
            if (parsed?.version !== 1 || !parsed.skills) return EMPTY_LOCK
            return parsed as SkillLock
        } catch {
            return EMPTY_LOCK
        }
    }

    private async ensureBase(
        run: HostRun,
        baseDir: string,
        skillsDir: string,
        timeoutMs?: number
    ): Promise<void> {
        const script = [
            'set -eu',
            `mkdir -p ${shellEscape(skillsDir)}`,
            `chmod 700 ${shellEscape(baseDir)}`
        ].join('\n')
        const result = await run(script, timeoutMs ?? 30_000)
        if (result.exitCode !== 0)
            throw new Error(
                `skills base setup exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
    }

    private async rm(
        run: HostRun,
        absPath: string,
        timeoutMs?: number
    ): Promise<void> {
        const result = await run(
            `rm -rf -- ${shellEscape(absPath)}`,
            timeoutMs ?? 30_000
        )
        if (result.exitCode !== 0)
            throw new Error(
                `rm exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
    }

    private async statFile(
        run: HostRun,
        absPath: string,
        timeoutMs?: number
    ): Promise<boolean> {
        const result = await run(
            `test -f ${shellEscape(absPath)}`,
            timeoutMs ?? 15_000
        )
        if (result.exitCode === 0) return true
        if (result.exitCode === 1) return false
        throw new Error(
            `stat exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
    }

    private async installSkill(
        run: HostRun,
        skillsDir: string,
        skill: DesiredSkill,
        installDirOnDisk: string,
        timeoutMs?: number
    ): Promise<void> {
        if (skill.kind === 'library') {
            await this.installLibraryTree(
                run,
                skillsDir,
                `${skillsDir}/${installDirOnDisk}`,
                skill,
                timeoutMs ?? 60_000
            )
            return
        }
        const tarUrl = `https://codeload.github.com/${skill.repoOwner}/${skill.repoName}/tar.gz/${encodeURIComponent(
            skill.revision
        )}`
        const dest = `${skillsDir}/${installDirOnDisk}`
        const sourcePath =
            skill.sourcePath === '.'
                ? '"$root"'
                : `"$root"/${shellEscape(skill.sourcePath)}`
        const script = [
            'set -eu',
            'tmp="$(mktemp -d)"',
            'trap \'rm -rf "$tmp"\' EXIT',
            `curl -fsSL ${shellEscape(tarUrl)} -o "$tmp/repo.tgz"`,
            'mkdir -p "$tmp/repo"',
            'tar -xzf "$tmp/repo.tgz" -C "$tmp/repo"',
            'root="$(find "$tmp/repo" -mindepth 1 -maxdepth 1 -type d | head -n 1)"',
            'test -n "$root"',
            `src=${sourcePath}`,
            'test -f "$src/SKILL.md"',
            `rm -rf -- ${shellEscape(dest)}`,
            `mkdir -p ${shellEscape(dest)}`,
            `cp -a "$src/." ${shellEscape(dest)}/`
        ].join('\n')
        const result = await run(script, timeoutMs ?? 60_000)
        if (result.exitCode !== 0)
            throw new Error(
                `install skill ${skill.installDir} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
    }

    private async writeFile(
        run: HostRun,
        absPath: string,
        body: string,
        mode: string,
        timeoutMs?: number
    ): Promise<void> {
        const encoded = Buffer.from(body).toString('base64')
        const script = [
            'set -eu',
            `mkdir -p "$(dirname ${shellEscape(absPath)})"`,
            `printf '%s' ${shellEscape(encoded)} | base64 -d > ${shellEscape(absPath)}`,
            `chmod ${shellEscape(mode)} ${shellEscape(absPath)}`
        ].join('\n')
        const result = await run(script, timeoutMs ?? 30_000)
        if (result.exitCode !== 0)
            throw new Error(
                `write file ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(`audit failed: ${(err as Error).message}`)
        }
    }
}

const runOn =
    (session: HostSession): HostRun =>
    (script, timeoutMs) =>
        session.exec({ cmd: ['bash', '-lc', script], timeoutMs })

interface CloneLayout {
    baseDir: string
    skillsDir: string
    lockPath: string
    installDirOf: (installDir: string) => string
}

// A self-owned computer keeps its user's own skills beside ours, so ours are
// namespaced and locked apart and never read or overwrite one the user
// installed by hand. A sandbox or a pod is the platform's.
const cloneLayout = (
    placement: MaterializeTarget['placement'],
    homeDir: string,
    framework: SkillFramework
): CloneLayout => {
    const baseDir =
        placement === 'k8s'
            ? k8sSkillBaseDir(homeDir, framework)
            : `${homeDir}/.${skillStateDirName(framework)}`
    const own = placement === 'daemon'
    return {
        baseDir,
        skillsDir: `${baseDir}/skills`,
        lockPath: `${baseDir}/${own ? '.nca-skill-lock.json' : '.skill-lock.json'}`,
        installDirOf: own ? (raw) => `nca-${raw}` : (raw) => raw
    }
}

const materializationLockKey = (userId: string, agentId: string): string =>
    `skills:${userId}:${agentId}`

// Materialization errors surface to the user (web/CLI), so map the common
// timeout to actionable text and cap length. The underlying messages are exec
// stderr / timeout strings, never secrets.
const sanitizeMaterializeReason = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err)
    const trimmed = raw.trim()
    if (/timed out/i.test(trimmed))
        return 'materialization timed out — the skill may be too large to download within the time limit'
    return (trimmed || 'materialization failed').slice(0, 500)
}

// Host-store population lock keyed on the host: serializes the download-once
// store across every agent on that host. Distinct from the per-agent activation lock; always acquired
// (and released) before it.
const storeLockKey = (userId: string, hostKey: string): string =>
    `skillstore:${userId}:${hostKey}`

const lockEntryFor = (skill: DesiredSkill): LockEntry => ({
    skillId: skill.skillId,
    repoOwner: skill.kind === 'github' ? skill.repoOwner : 'library',
    repoName: skill.kind === 'github' ? skill.repoName : '',
    repoBranch: skill.kind === 'github' ? skill.repoBranch : '',
    sourcePath: skill.kind === 'github' ? skill.sourcePath : '.',
    installDir: skill.installDir,
    revision: skill.revision,
    materializedAt: Math.floor(Date.now() / 1000)
})

const storeKeyFor = (skill: DesiredSkill): string =>
    skill.kind === 'github'
        ? skillStoreKey(skill)
        : libraryStoreKey({
              name: skill.name,
              librarySkillId: skill.librarySkillId,
              contentHash: skill.revision
          })

type LibraryScriptRunner = (
    script: string,
    timeoutMs: number
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const runLibraryScript = async (
    run: LibraryScriptRunner,
    script: string,
    timeoutMs: number,
    label: string
): Promise<void> => {
    const result = await run(script, timeoutMs)
    if (result.exitCode !== 0)
        throw new Error(
            `${label} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
}

// Each generated script stays under ~80KB of payload so `bash -lc <script>`
// never brushes against Linux's per-argument MAX_ARG_STRLEN (~128KB); a 1MiB
// file simply spans multiple sequential scripts appending to its .mfb64 spool
// before a final decode.
const LIBRARY_SCRIPT_PAYLOAD_BUDGET = 80_000
const LIBRARY_B64_CHUNK = 60_000

const buildLibraryWriteScripts = (
    stagedDir: string,
    entries: { path: string; content: string }[]
): string[] => {
    const scripts: string[] = []
    let lines: string[] = ['set -eu']
    let budget = 0
    const flush = (): void => {
        if (lines.length > 1) scripts.push(lines.join('\n'))
        lines = ['set -eu']
        budget = 0
    }
    const emit = (line: string): void => {
        if (budget > 0 && budget + line.length > LIBRARY_SCRIPT_PAYLOAD_BUDGET)
            flush()
        lines.push(line)
        budget += line.length
    }
    const dirs = new Set<string>()
    for (const entry of entries) {
        const idx = entry.path.lastIndexOf('/')
        if (idx > 0) dirs.add(entry.path.slice(0, idx))
    }
    for (const dir of dirs)
        emit(`mkdir -p ${shellEscape(`${stagedDir}/${dir}`)}`)
    for (const entry of entries) {
        const target = shellEscape(`${stagedDir}/${entry.path}`)
        const b64 = Buffer.from(entry.content, 'utf8').toString('base64')
        if (b64.length === 0) {
            emit(`: > ${target}`)
            continue
        }
        const spool = shellEscape(`${stagedDir}/${entry.path}.mfb64`)
        for (let i = 0; i < b64.length; i += LIBRARY_B64_CHUNK)
            emit(
                `printf '%s' '${b64.slice(i, i + LIBRARY_B64_CHUNK)}' >> ${spool}`
            )
        emit(`base64 -d < ${spool} > ${target}`)
        emit(`rm -f ${spool}`)
    }
    flush()
    return scripts
}

const k8sSkillBaseDir = (homeDir: string, framework: SkillFramework): string =>
    framework === 'hermes'
        ? homeDir
        : `${homeDir}/.${skillStateDirName(framework)}`

const k8sHomeDirForAgent = (
    agent: Agent,
    runtime: AgentRuntimeRow,
    framework: SkillFramework
): string | undefined =>
    framework === 'hermes'
        ? hermesProfileHome(
              runtime.mountPath || DEFAULT_HERMES_HOME,
              agent.internalId
          )
        : undefined

const hermesProfileHome = (root: string, internalId: string): string => {
    if (internalId === 'default') return root
    if (!HERMES_PROFILE_RE.test(internalId))
        throw new Error(`invalid hermes profile ${internalId}`)
    return `${root}/profiles/${internalId}`
}

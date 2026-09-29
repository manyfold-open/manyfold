import {
    DAEMON_FEATURE_FS_ROOTS,
    DAEMON_FEATURE_FS_WRITE_STREAM,
    frameworkDefinition,
    isRuntimeUsable,
    type RuntimePlacement,
    type DaemonRpcMethod
} from '@manyfold/shared'
import type {
    FileRootCapabilitiesSdk,
    FileRootSdk,
    FsEntrySdk
} from '@manyfold/shared'
import * as posix from 'node:path/posix'
import {
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agents,
    type Agent,
    type Database,
    type FileRoot,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    HOME_ROOT_ID,
    buildFileRoots,
    defaultFileRoot,
    expectedRootIds
} from '@/modules/agents/bootstrap/file-roots'
import {
    HostDaemonAccess,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import {
    readFileStream,
    writeFileStream
} from '@/modules/agents/adapters/host-file-stream'
import { isCustomWorkspace } from '@/modules/agents/workspace/workspace-preflight'
import { daemonFilesError } from '@/modules/agents/files/files-daemon-error'
import { rootCapabilities } from '@/modules/agents/files/files-capabilities'
import {
    boundedChunks,
    type FileWriteBody,
    type UploadBound
} from '@/modules/agents/files/files-upload'
import { resolveImageContentType } from '@/modules/agents/files/files-content-type'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'

export interface FilesContext {
    agent: Agent
    // The product placement of the agent's host (placementOf, ADR-0037);
    // absent on a context a framework builds for its own files.
    placement?: RuntimePlacement
    root: FileRoot
    mountPath: string
    list(absPath: string): Promise<FsEntrySdk[]>
    stat(
        absPath: string
    ): Promise<{ entry: FsEntrySdk; contentType: string } | null>
    read(absPath: string): Promise<{
        stream: AsyncIterable<Uint8Array | Buffer>
        // undefined when the transport cannot report a trustworthy length up
        // front — the response then goes out chunked rather than with a
        // Content-Length the body will not match
        size?: number
        contentType: string
        done?: Promise<void>
    } | null>
    write(absPath: string, body: FileWriteBody): Promise<void>
    mkdir(absPath: string): Promise<void>
    mv(src: string, dst: string): Promise<void>
    rm(absPath: string, recursive: boolean): Promise<void>
}

// The agent with its machine resolved (ADR-0037): where the files live is a
// fact of the host, never of the agent row.
type AgentContext = RuntimeContext & { agent: Agent }
type HostedAgentContext = AgentContext & { host: RuntimeHostRow }

const withImageContentTypeFallback = (ctx: FilesContext): FilesContext => ({
    ...ctx,
    stat: async (absPath) => {
        const result = await ctx.stat(absPath)
        if (!result) return null
        return {
            ...result,
            contentType: resolveImageContentType(absPath, result.contentType)
        }
    },
    read: async (absPath) => {
        const result = await ctx.read(absPath)
        if (!result) return null
        return {
            ...result,
            contentType: resolveImageContentType(absPath, result.contentType)
        }
    }
})

// The bound an adapter enforces while consuming a write body.
const uploadBound = (ctx: AgentContext, root: FileRoot): UploadBound => ({
    maxBytes: rootCapabilities({ framework: ctx.agent.framework, root })
        .maxUploadBytes,
    rootId: root.id,
    transport: ctx.placement
})

const pickRoot = (roots: FileRoot[], rootId?: string | null): FileRoot => {
    if (!rootId) return roots[0]
    const match = roots.find((r) => r.id === rootId)
    if (!match) throw new NotFoundException(`unknown file root: ${rootId}`)
    return match
}

const FRAMEWORK_HOME_IDS = new Set(['claude-home', 'codex-home', 'gemini-home'])

const deriveHomeFromStored = (stored: FileRoot[]): string | undefined => {
    const home = stored.find((r) => r.id === HOME_ROOT_ID && !!r.path)
    if (home) return home.path
    const cfg = stored.find((r) => FRAMEWORK_HOME_IDS.has(r.id) && !!r.path)
    if (cfg) return posix.dirname(cfg.path)
    return undefined
}

const FS_CALL_TIMEOUT_MS = 30_000

@Injectable()
export class FilesContextBuilder {
    private readonly log = new Logger(FilesContextBuilder.name)

    constructor(
        private readonly runtimeContext: RuntimeContextService,
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hostAccess: HostDaemonAccess,
        // Appended last + @Optional: frameworks whose files their own API
        // serves (ADR-0034); absent means only the core frameworks.
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {}

    private async contextOf(agent: Agent): Promise<AgentContext> {
        const ctx = await this.runtimeContext.forAgent(agent.id)
        if (!ctx?.agent)
            throw new NotFoundException(`agent ${agent.id} not found`)
        return { ...ctx, agent }
    }

    async resolveRoots(agent: Agent): Promise<FileRoot[]> {
        return this.resolveRootsFor(await this.contextOf(agent))
    }

    private async resolveRootsFor(ctx: AgentContext): Promise<FileRoot[]> {
        const { agent } = ctx
        const provider = this.extensions.get(agent.framework)?.files
        if (provider) return await provider.resolveRoots(agent)
        const stored = Array.isArray(agent.fileRoots) ? agent.fileRoots : []
        if (stored.length > 0 && this.storedShapeIsCurrent(ctx, stored))
            return stored
        const computed = await this.computeDefaults(ctx, stored)
        if (computed.length === 0) return [defaultFileRoot(agent.mountPath)]
        if (computed.length < stored.length) return stored
        try {
            await this.db
                .update(agents)
                .set({ fileRoots: computed, updatedAt: new Date() })
                .where(eq(agents.id, agent.id))
        } catch (err) {
            this.log.warn(
                `failed to backfill fileRoots for agent ${agent.id}: ${(err as Error).message}`
            )
        }
        return computed
    }

    async resolveRootsForSdk(agent: Agent): Promise<FileRootSdk[]> {
        const ctx = await this.contextOf(agent)
        const roots = await this.resolveRootsFor(ctx)
        return roots.map((root) =>
            toSdkRoot(
                root,
                rootCapabilities({ framework: agent.framework, root })
            )
        )
    }

    private storedShapeIsCurrent(ctx: AgentContext, stored: FileRoot[]): boolean {
        const homeKnown =
            ctx.placement === 'k8s' ||
            ctx.placement === 'daemon' ||
            stored.some((r) => r.id !== 'workspace' && !!r.path)
        const expected = expectedRootIds({
            framework: ctx.agent.framework,
            runtime: ctx.placement,
            homeKnown
        })
        const have = new Set(stored.map((r) => r.id))
        return expected.every((id) => have.has(id))
    }

    private async computeDefaults(
        ctx: AgentContext,
        stored: FileRoot[] = []
    ): Promise<FileRoot[]> {
        const { agent, host } = ctx
        // The host declared its home when its daemon registered (ADR-0014).
        return buildFileRoots({
            framework: agent.framework,
            runtime: ctx.placement,
            mountPath: agent.mountPath,
            homeDir: host?.homeDir ?? deriveHomeFromStored(stored)
        })
    }

    async build(agent: Agent, rootId?: string | null): Promise<FilesContext> {
        const ctx = await this.contextOf(agent)
        if (ctx.placement === 'external' || !ctx.host)
            throw new NotFoundException(
                `external-runtime agents have no filesystem`
            )
        const hosted = ctx as HostedAgentContext
        const provider = this.extensions.get(agent.framework)?.files
        if (provider) {
            // The framework owns these roots' layout: nothing is created, and a
            // root it does not serve itself falls to the runtime's transport.
            const root = pickRoot(await provider.resolveRoots(agent), rootId)
            const filesCtx =
                (await provider.buildContext(agent, root)) ??
                this.daemonCtx(hosted, root)
            return withImageContentTypeFallback(filesCtx)
        }
        const roots = await this.resolveRootsFor(ctx)
        const root = pickRoot(roots, rootId)
        const filesCtx = this.daemonCtx(hosted, root)
        await this.ensureRootExists(agent, root, filesCtx)
        return withImageContentTypeFallback(filesCtx)
    }

    // Where a terminal opens when the caller names no directory.
    defaultTerminalCwd(agent: Agent, placement: RuntimePlacement): string {
        const fromProvider = this.extensions
            .get(agent.framework)
            ?.files?.defaultTerminalCwd?.(agent)
        if (fromProvider) return fromProvider
        if (placement === 'daemon' && agent.workspacePath)
            return agent.workspacePath
        return agent.mountPath
    }

    // Every machine's files go through its daemon (ADR-0037 R6), each call
    // under the machine's hold, a hosted daemon brought up for it. The
    // platform owns a hosted machine's filesystem, so the root a call works
    // in is vouched for on the call (DAEMON_FEATURE_FS_ROOTS); a self-owned
    // computer admits only what its own daemon registered.
    private daemonCtx(ctx: HostedAgentContext, root: FileRoot): FilesContext {
        const { agent, host } = ctx
        const hosted = host.kind === 'hosted'
        const roots = hosted ? [root.path] : undefined
        const onHost = <T>(
            reason: string,
            requiredFeatures: string[],
            work: (session: HostSession) => Promise<T>
        ): Promise<T> =>
            this.hostAccess
                .withHost(
                    {
                        host,
                        daemon: ctx.daemon,
                        placement: ctx.placement,
                        agentId: agent.id,
                        reason,
                        requiredFeatures: hosted
                            ? [DAEMON_FEATURE_FS_ROOTS, ...requiredFeatures]
                            : requiredFeatures
                    },
                    work
                )
                .catch(daemonFilesError)
        const rpc = (method: DaemonRpcMethod, payload: Record<string, unknown>) =>
            onHost('files', [], (session) =>
                session.rpc({
                    method,
                    payload: roots ? { ...payload, roots } : payload,
                    timeoutMs: FS_CALL_TIMEOUT_MS
                })
            )
        return {
            agent,
            placement: ctx.placement,
            root,
            mountPath: root.path,
            list: async (abs) => {
                const res = await rpc('fs.list', { path: abs })
                const entries = (res?.entries ?? []) as Array<{
                    name: string
                    type: string
                }>
                return entries.map((e) => ({
                    name: e.name,
                    type: e.type === 'dir' ? 'dir' : 'file',
                    size: 0,
                    mtime: 0,
                    mode: '644'
                })) as FsEntrySdk[]
            },
            stat: async (abs) => {
                try {
                    const res = await rpc('fs.stat', { path: abs })
                    if (!res) return null
                    const entry: FsEntrySdk = {
                        name: posix.basename(abs),
                        type: res.isDir ? 'dir' : 'file',
                        size: Number(res.size ?? 0),
                        mtime: Math.floor(
                            Number(res.mtime ?? Date.now()) / 1_000
                        ),
                        mode: '644'
                    }
                    return { entry, contentType: 'application/octet-stream' }
                } catch {
                    return null
                }
            },
            // fs.read reports size only in its final result frame, after every
            // chunk, so the size comes from a stat first; the read runs on
            // after this call returns, holding the machine until it ends.
            read: (abs) =>
                onHost('files-read', [], async (session) => {
                    const statRes = await session.rpc({
                        method: 'fs.stat',
                        payload: roots ? { path: abs, roots } : { path: abs },
                        timeoutMs: FS_CALL_TIMEOUT_MS
                    })
                    if (!statRes || statRes.isDir) return null
                    const hold = this.hostAccess.hold(host, 'files-read')
                    const { stream, done } = readFileStream(session, {
                        path: abs,
                        roots,
                        release: () => void hold.release()
                    })
                    return {
                        stream,
                        size: Number(statRes.size ?? 0),
                        contentType: 'application/octet-stream',
                        done
                    }
                }),
            write: (abs, body) =>
                onHost(
                    'files-write',
                    [DAEMON_FEATURE_FS_WRITE_STREAM],
                    async (session) => {
                        await writeFileStream(session, {
                            path: abs,
                            body: boundedChunks(body, uploadBound(ctx, root)),
                            roots
                        })
                    }
                ),
            mkdir: async (abs) => {
                await rpc('fs.mkdir', { path: abs })
            },
            mv: async (src, dst) => {
                await rpc('fs.mv', { from: src, to: dst })
            },
            rm: async (abs, recursive) => {
                await rpc('fs.rm', { path: abs, recursive })
            }
        }
    }

    private readonly verifiedRoots = new Set<string>()

    private async ensureRootExists(
        agent: Agent,
        root: FileRoot,
        ctx: FilesContext
    ): Promise<void> {
        const key = `${agent.id}:${root.id}`
        if (this.verifiedRoots.has(key)) return
        if (root.id === 'workspace' && isCustomWorkspace(agent)) return
        try {
            await ctx.mkdir(root.path)
            this.verifiedRoots.add(key)
        } catch (err) {
            this.log.warn(
                `failed to ensure root ${root.id} (${root.path}) for agent ${agent.id}: ${(err as Error).message}`
            )
        }
    }
}

// The one admission rule for files (ADR-0037): the agent's runtime is
// installed on a ready host. A hosted machine that is asleep is admitted —
// reads wake it.
export const assertAgentReady = (
    ctx: Pick<RuntimeContext, 'placement' | 'availability'> & { agent: Agent }
): void => {
    if (ctx.placement === 'external')
        throw new NotFoundException(
            `external-runtime agents have no filesystem`
        )
    // Framework-served files need nothing from the runtime transport.
    if (frameworkDefinition(ctx.agent.framework)?.files?.servedBy === 'framework')
        return
    if (!isRuntimeUsable(ctx.availability))
        throw new NotFoundException(
            `agent is ${ctx.availability}; files available only while its runtime is ready`
        )
}

export const resolveSafePath = (mountPath: string, raw: string): string => {
    const base = posix.normalize(mountPath)
    const input = typeof raw === 'string' ? raw.trim() : ''
    if (!input) throw new ForbiddenException('path required')
    const joined = input.startsWith('/')
        ? posix.normalize(input)
        : posix.resolve(base, input)
    if (joined !== base && !joined.startsWith(base + '/'))
        throw new ForbiddenException(`path escapes agent mount (${mountPath})`)
    return joined
}

export const toSdkEntry = (e: FsEntrySdk): FsEntrySdk => ({
    name: e.name,
    type: e.type,
    size: e.size,
    mtime: e.mtime,
    mode: e.mode
})

export const toSdkRoot = (
    root: FileRoot,
    capabilities: FileRootCapabilitiesSdk
): FileRootSdk => ({
    id: root.id,
    label: root.label,
    path: root.path,
    writable: root.writable,
    ...(root.transport ? { transport: root.transport } : {}),
    capabilities
})

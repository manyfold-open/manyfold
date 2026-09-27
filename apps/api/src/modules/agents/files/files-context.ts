import {
    DAEMON_FEATURE_FS_WRITE_BINARY,
    frameworkDefinition,
    isRuntimeUsable,
    type AgentRuntime
} from '@manyfold/shared'
import type {
    FileRootCapabilitiesSdk,
    FileRootSdk,
    FsEntrySdk
} from '@manyfold/shared'
import * as posix from 'node:path/posix'
import {
    BadRequestException,
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
import {
    spriteListDir,
    spriteMkdir,
    spriteMv,
    spriteReadFile,
    spriteRm,
    spriteStatFile,
    spriteWriteFile,
    type FsEntry
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import type { PodExec } from '@/modules/k8s/pod-exec'
import {
    HOME_ROOT_ID,
    buildFileRoots,
    defaultFileRoot,
    expectedRootIds
} from '@/modules/agents/bootstrap/file-roots'
import { extractHomeDir } from '@/modules/agents/bootstrap/home-probe'
import { K8sPodFilesClient } from '@/modules/agents/files/k8s-pod-files-client'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { HostDaemonAccess } from '@/modules/agents/adapters/host-daemon-access'
import { isCustomWorkspace } from '@/modules/agents/workspace/workspace-preflight'
import { spritesHttpError } from '@/modules/agents/files/sprite-http-error'
import { rootCapabilities } from '@/modules/agents/files/files-capabilities'
import {
    boundedChunks,
    collectBounded,
    type FileWriteBody,
    type UploadBound
} from '@/modules/agents/files/files-upload'
import { resolveImageContentType } from '@/modules/agents/files/files-content-type'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'

export interface FilesContext {
    agent: Agent
    // The product placement of the agent's host (placementOf, ADR-0037);
    // absent on a context a framework builds for its own files.
    placement?: AgentRuntime
    root: FileRoot
    mountPath: string
    list(absPath: string): Promise<FsEntry[]>
    stat(
        absPath: string
    ): Promise<{ entry: FsEntry; contentType: string } | null>
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
    // false only for daemon hosts that lack DAEMON_FEATURE_FS_WRITE_BINARY,
    // whose fs.write is UTF-8-lossy; undefined means binary-safe (sprite/k8s).
    binaryWriteSafe?: boolean
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

// The bound an adapter enforces while consuming a write body. binaryWriteSafe
// does not affect sizes, so the capability lookup can assume the safe value.
const uploadBound = (ctx: AgentContext, root: FileRoot): UploadBound => ({
    maxBytes: rootCapabilities({
        framework: ctx.agent.framework,
        placement: ctx.placement,
        root,
        binaryWriteSafe: true
    }).maxUploadBytes,
    rootId: root.id,
    transport: root.transport ?? ctx.placement
})

const isUtf8RoundTrippable = (body: Buffer): boolean =>
    Buffer.compare(Buffer.from(body.toString('utf8'), 'utf8'), body) === 0

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

const POD_CACHE_TTL_MS = 60_000

interface CachedPodExec {
    exec: PodExec
    expiresAt: number
}

@Injectable()
export class FilesContextBuilder {
    private readonly log = new Logger(FilesContextBuilder.name)
    private readonly podCache = new Map<string, CachedPodExec>()

    constructor(
        private readonly runtimeContext: RuntimeContextService,
        private readonly hostClients: HostProviderClients,
        private readonly daemonRegistry: DaemonRegistryService,
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

    // The pod of a hosted k8s machine, cached by host: every framework
    // runtime and agent on the host resolves to this one pod (ADR-0035).
    private async podExecCached(host: RuntimeHostRow): Promise<PodExec> {
        const cached = this.podCache.get(host.id)
        const now = Date.now()
        if (cached && cached.expiresAt > now) return cached.exec
        const exec = await this.hostClients.podExecForHost(host)
        this.podCache.set(host.id, { exec, expiresAt: now + POD_CACHE_TTL_MS })
        return exec
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

    private daemonBinaryWriteSafe(ctx: AgentContext): boolean {
        return (ctx.daemon?.clientFeatures ?? []).includes(
            DAEMON_FEATURE_FS_WRITE_BINARY
        )
    }

    // binarySafe depends on the host daemon's CLI version, so capabilities
    // cannot be a static per-runtime table — they are resolved per request
    // alongside roots
    async resolveRootsForSdk(agent: Agent): Promise<FileRootSdk[]> {
        const ctx = await this.contextOf(agent)
        const roots = await this.resolveRootsFor(ctx)
        const binaryWriteSafe =
            ctx.placement === 'daemon' ? this.daemonBinaryWriteSafe(ctx) : true
        return roots.map((root) =>
            toSdkRoot(
                root,
                rootCapabilities({
                    framework: agent.framework,
                    placement: ctx.placement,
                    root,
                    binaryWriteSafe
                })
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
        if (ctx.placement === 'k8s')
            return buildFileRoots({
                framework: agent.framework,
                runtime: 'k8s',
                mountPath: agent.mountPath,
                ...(isCustomWorkspace(agent)
                    ? { workspaceTransport: 'pod-exec' as const }
                    : {})
            })
        if (ctx.placement === 'daemon')
            return buildFileRoots({
                framework: agent.framework,
                runtime: 'daemon',
                mountPath: agent.mountPath,
                homeDir: host?.homeDir ?? deriveHomeFromStored(stored)
            })
        // The host declared its home at daemon registration (ADR-0014); a
        // sandbox whose daemon has not registered yet is asked directly.
        const probedHome =
            host?.homeDir ??
            (host
                ? await this.probeSpriteHome(host).catch(() => undefined)
                : undefined)
        const homeDir = probedHome ?? deriveHomeFromStored(stored)
        return buildFileRoots({
            framework: agent.framework,
            runtime: 'sprites',
            mountPath: agent.mountPath,
            homeDir
        })
    }

    private async probeSpriteHome(
        host: RuntimeHostRow
    ): Promise<string | undefined> {
        const exec = await this.hostClients.spriteExecForHost(host)
        const result = await exec({
            cmd: ['bash', '-lc', `printf 'MF_HOME=%s\\n' "$HOME"`],
            stdin: '',
            timeoutMs: 10_000
        })
        if (result.exitCode !== 0) return undefined
        return extractHomeDir(result.stdout)
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
                (await this.runtimeCtx(hosted, root))
            return withImageContentTypeFallback(filesCtx)
        }
        const roots = await this.resolveRootsFor(ctx)
        const root = pickRoot(roots, rootId)
        const filesCtx = await this.runtimeCtx(hosted, root)
        await this.ensureRootExists(agent, root, filesCtx)
        return withImageContentTypeFallback(filesCtx)
    }

    // Where a terminal opens when the caller names no directory.
    defaultTerminalCwd(agent: Agent, placement: AgentRuntime): string {
        const fromProvider = this.extensions
            .get(agent.framework)
            ?.files?.defaultTerminalCwd?.(agent)
        if (fromProvider) return fromProvider
        if (placement === 'daemon' && agent.workspacePath)
            return agent.workspacePath
        return agent.mountPath
    }

    private runtimeCtx(
        ctx: HostedAgentContext,
        root: FileRoot
    ): Promise<FilesContext> {
        return ctx.placement === 'sprites'
            ? this.spriteCtx(ctx, root)
            : ctx.placement === 'daemon'
              ? this.daemonCtx(ctx, root)
              : this.k8sCtx(ctx, root)
    }

    private async daemonCtx(
        ctx: HostedAgentContext,
        root: FileRoot
    ): Promise<FilesContext> {
        const { agent } = ctx
        const daemonId = ctx.host.id
        // Every call runs under the machine's hold and survives a reconnect
        // (ADR-0038); a self-owned computer the API holds no socket to reads
        // as offline.
        const rpc = (
            method: import('@manyfold/shared').DaemonRpcMethod,
            payload: Record<string, unknown>
        ) =>
            this.hostAccess.withHost(
                {
                    host: ctx.host,
                    daemon: ctx.daemon,
                    placement: ctx.placement,
                    agentId: agent.id,
                    reason: 'files'
                },
                (session) => session.rpc({ method, payload, timeoutMs: 30_000 })
            )
        const binaryWriteSafe = this.daemonBinaryWriteSafe(ctx)
        return {
            agent,
            placement: ctx.placement,
            root,
            mountPath: root.path,
            binaryWriteSafe,
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
                })) as FsEntry[]
            },
            stat: async (abs) => {
                try {
                    const res = await rpc('fs.stat', { path: abs })
                    if (!res) return null
                    const entry: FsEntry = {
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
            read: async (abs) => {
                // fs.read reports size only in its final result frame, after every
                // fs.chunk event, so waiting for it would stall the download while
                // racing it against the first chunk yields size 0 for anything
                // larger than one chunk — and 0 became the Content-Length. Stat
                // first: the daemon derives that same size from stat anyway.
                const statRes = await rpc('fs.stat', { path: abs })
                if (!statRes || statRes.isDir) return null
                const size = Number(statRes.size ?? 0)
                type Chunk = Buffer | null
                const queue: Chunk[] = []
                const waiters: Array<(v: IteratorResult<Buffer>) => void> = []
                let done = false
                const enqueue = (chunk: Chunk): void => {
                    if (waiters.length > 0)
                        waiters.shift()!(
                            chunk
                                ? { value: chunk, done: false }
                                : { value: undefined, done: true }
                        )
                    else queue.push(chunk)
                }
                const stream = this.daemonRegistry.streamRpc({
                    daemonId,
                    method: 'fs.read',
                    payload: { path: abs, chunked: true },
                    timeoutMs: 5 * 60_000,
                    onEvent: (kind, data) => {
                        if (kind !== 'fs.chunk') return
                        enqueue(Buffer.from(data, 'base64'))
                    }
                })
                const resultMeta = stream.result
                    .then((payload) => {
                        enqueue(null)
                        return payload ?? {}
                    })
                    .catch((err) => {
                        done = true
                        enqueue(null)
                        throw err
                    })
                const iter: AsyncIterable<Buffer> = {
                    [Symbol.asyncIterator]: () => ({
                        next: () =>
                            new Promise<IteratorResult<Buffer>>((resolve) => {
                                if (queue.length > 0) {
                                    const next = queue.shift()!
                                    return resolve(
                                        next
                                            ? { value: next, done: false }
                                            : { value: undefined, done: true }
                                    )
                                }
                                if (done)
                                    return resolve({
                                        value: undefined,
                                        done: true
                                    })
                                waiters.push(resolve)
                            })
                    })
                }
                return {
                    stream: iter,
                    size,
                    contentType: 'application/octet-stream',
                    done: resultMeta.then(() => undefined)
                }
            },
            write: async (rawAbs, rawBody) => {
                const abs = rawAbs
                const body = await collectBounded(
                    rawBody,
                    uploadBound(ctx, root)
                )
                if (!binaryWriteSafe) {
                    // the legacy fs.write takes a UTF-8 string, which silently
                    // mangles any byte sequence that is not valid UTF-8; refuse
                    // instead of writing a corrupt file
                    if (!isUtf8RoundTrippable(body))
                        throw new BadRequestException(
                            `binary writes are not supported on this self-owned computer until the daemon CLI is upgraded (needs ${DAEMON_FEATURE_FS_WRITE_BINARY})`
                        )
                    await rpc('fs.write', {
                        path: abs,
                        content: body.toString('utf8')
                    })
                    return
                }
                await rpc('fs.write', {
                    path: abs,
                    content: body.toString('base64'),
                    encoding: 'base64'
                })
            },
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

    private async spriteCtx(
        ctx: HostedAgentContext,
        root: FileRoot
    ): Promise<FilesContext> {
        const { agent } = ctx
        const { client, spriteName } =
            await this.hostClients.spritesClientForHost(ctx.host)
        const mountPath = root.path
        // Every op here reaches the sprite over the exec WSS, whose failures are
        // SpritesError (not HttpException) — unguarded they fall through to a
        // 500 internal_error. Map at the boundary so both FilesController and
        // AdminFilesController surface a typed runtime error (#264).
        const guard =
            <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
            (...a: A): Promise<R> =>
                fn(...a).catch(spritesHttpError)
        return {
            agent,
            placement: ctx.placement,
            root,
            mountPath,
            list: guard((abs: string) =>
                spriteListDir(client, spriteName, abs, undefined, mountPath)
            ),
            stat: guard(async (abs: string) => {
                const s = await spriteStatFile(
                    client,
                    spriteName,
                    abs,
                    undefined,
                    mountPath
                )
                if (!s) return null
                const entries = await spriteListDir(
                    client,
                    spriteName,
                    posix.dirname(abs),
                    undefined,
                    mountPath
                ).catch(() => [] as FsEntry[])
                const name = posix.basename(abs)
                const entry =
                    entries.find((e) => e.name === name) ??
                    ({
                        name,
                        type: 'file',
                        size: s.size,
                        mtime: Math.floor(Date.now() / 1_000),
                        mode: '644'
                    } as FsEntry)
                return { entry, contentType: s.contentType }
            }),
            read: guard(async (abs: string) => {
                const r = await spriteReadFile(
                    client,
                    spriteName,
                    abs,
                    undefined,
                    undefined,
                    mountPath
                )
                if (!r) return null
                return {
                    stream: r.stream,
                    size: r.size,
                    contentType: r.contentType,
                    done: r.done
                }
            }),
            write: guard((abs: string, body: FileWriteBody) =>
                spriteWriteFile(client, spriteName, {
                    absPath: abs,
                    body: boundedChunks(body, uploadBound(ctx, root)),
                    containRoot: mountPath
                })
            ),
            mkdir: guard((abs: string) =>
                spriteMkdir(client, spriteName, abs, undefined, mountPath)
            ),
            mv: guard((src: string, dst: string) =>
                spriteMv(client, spriteName, src, dst, undefined, mountPath)
            ),
            rm: guard((abs: string, recursive: boolean) =>
                spriteRm(client, spriteName, abs, {
                    recursive,
                    containRoot: mountPath
                })
            )
        }
    }

    private async k8sCtx(
        ctx: HostedAgentContext,
        root: FileRoot
    ): Promise<FilesContext> {
        const { agent } = ctx
        const podExec = await this.podExecCached(ctx.host)
        const client = new K8sPodFilesClient(podExec, root.path)
        return {
            agent,
            placement: ctx.placement,
            root,
            mountPath: root.path,
            list: (abs) => client.list(abs),
            stat: (abs) => client.stat(abs),
            read: async (abs) => {
                const r = await client.read(abs)
                if (!r) return null
                return r
            },
            write: async (abs, body) =>
                client.write(
                    abs,
                    await collectBounded(body, uploadBound(ctx, root))
                ),
            mkdir: (abs) => client.mkdir(abs),
            mv: (src, dst) => client.mv(src, dst),
            rm: (abs, recursive) => client.rm(abs, recursive)
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

export const toSdkEntry = (e: FsEntry): FsEntrySdk => ({
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

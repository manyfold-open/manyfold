import {
    DAEMON_FEATURE_FS_WRITE_BINARY,
    SPRITE_HOME_BASE
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
    ServiceUnavailableException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agents,
    runtimeHosts,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type FileRoot
} from '@manyfold/db'
import {
    createClient,
    execSprite,
    spriteListDir,
    spriteMkdir,
    spriteMv,
    spriteReadFile,
    spriteRm,
    spriteStatFile,
    spriteWriteFile,
    type FsEntry,
    type SpritesClient
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import { loadNarraNexusGatewayToken } from '@/modules/narranexus/narranexus-http'
import {
    narraNexusListDir,
    narraNexusListRoots,
    narraNexusRead,
    narraNexusStat,
    narraNexusWrite
} from '@/modules/narranexus/narranexus-files-client'
import {
    HOME_ROOT_ID,
    buildFileRoots,
    defaultFileRoot,
    expectedRootIds
} from '@/modules/agents/bootstrap/file-roots'
import { extractHomeDir } from '@/modules/agents/bootstrap/home-probe'
import {
    k8sListDir,
    k8sMkdir,
    k8sMv,
    k8sReadFile,
    k8sRm,
    k8sStatFile,
    k8sWriteFile,
    k8sDufsPathMappingForRoot,
    type K8sFilesTarget
} from '@/modules/agents/files/k8s-files-client'
import { K8sPodFilesClient } from '@/modules/agents/files/k8s-pod-files-client'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
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

export interface FilesContext {
    agent: Agent
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
const uploadBound = (agent: Agent, root: FileRoot): UploadBound => ({
    maxBytes: rootCapabilities({ agent, root, binaryWriteSafe: true })
        .maxUploadBytes,
    rootId: root.id,
    transport: root.transport ?? agent.runtime
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

const storedRootPath = (agent: Agent, rootId: string): string | null => {
    const stored = Array.isArray(agent.fileRoots) ? agent.fileRoots : []
    return stored.find((r) => r.id === rootId)?.path || null
}

// Only the workspace path comes from NarraNexus. The two sprite-side roots are
// Manyfold's own knowledge of the sandbox image, and every root stays
// writable: false — the gateway's write endpoint is reachable from chat
// attachment ingest only, never from the file controllers.
const narraNexusRootShape = (agent: Agent, workspacePath: string): FileRoot[] => {
    const workspace: FileRoot = {
        id: 'workspace',
        label: 'Workspace',
        path: workspacePath,
        writable: false
    }
    if (agent.runtime !== 'sprites') return [workspace]
    return [
        workspace,
        {
            id: 'narranexus-home',
            label: 'NarraNexus config',
            path: `${SPRITE_HOME_BASE}/.narranexus`,
            writable: false
        },
        {
            id: HOME_ROOT_ID,
            label: 'Home',
            path: SPRITE_HOME_BASE,
            writable: false
        }
    ]
}

const POD_CACHE_TTL_MS = 60_000

interface CachedPod {
    pod: Awaited<ReturnType<typeof resolveAgentPod>>
    expiresAt: number
}

// Long enough that a Files-page session costs one lookup, short enough that a
// workspace layout change on the NarraNexus side heals without a restart.
const NARRANEXUS_ROOTS_TTL_MS = 5 * 60_000

interface CachedNarraNexusRoots {
    roots: FileRoot[]
    expiresAt: number
}

@Injectable()
export class FilesContextBuilder {
    private readonly log = new Logger(FilesContextBuilder.name)
    private readonly podCache = new Map<string, CachedPod>()
    private readonly narraNexusRootsCache = new Map<
        string,
        CachedNarraNexusRoots
    >()

    constructor(
        private readonly accounts: SpritesAccountsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly k8s: KubernetesService,
        private readonly podExecFactory: PodExecFactory,
        private readonly daemonRegistry: DaemonRegistryService,
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    private async resolvePodCached(
        runtime: AgentRuntimeRow
    ): Promise<Awaited<ReturnType<typeof resolveAgentPod>>> {
        const key = `${runtime.id}:${runtime.primaryAgentId ?? ''}`
        const cached = this.podCache.get(key)
        const now = Date.now()
        if (cached && cached.expiresAt > now) return cached.pod
        const pod = await resolveAgentPod(
            this.k8s,
            runtime,
            runtime.primaryAgentId
        )
        this.podCache.set(key, { pod, expiresAt: now + POD_CACHE_TTL_MS })
        return pod
    }

    async resolveRoots(agent: Agent): Promise<FileRoot[]> {
        // NarraNexus's gateway file API serves only the per-agent workspace
        // (read-only); ~/.narranexus and the sprite home sit outside that lock,
        // so on sprites we add them as read-only roots browsed via direct
        // sprite access instead of the gateway
        if (agent.framework === 'narranexus')
            return await this.narraNexusRoots(agent)
        const stored = Array.isArray(agent.fileRoots) ? agent.fileRoots : []
        if (stored.length > 0 && this.storedShapeIsCurrent(agent, stored))
            return stored
        const computed = await this.computeDefaults(agent, stored)
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

    private async daemonBinaryWriteSafe(daemonId: string): Promise<boolean> {
        const [hostRow] = await this.db
            .select({ clientFeatures: runtimeHosts.clientFeatures })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, daemonId))
            .limit(1)
        return ((hostRow?.clientFeatures as string[] | null) ?? []).includes(
            DAEMON_FEATURE_FS_WRITE_BINARY
        )
    }

    // binarySafe depends on the host's CLI version, so capabilities cannot be a
    // static per-runtime table — they are resolved per request alongside roots
    async resolveRootsForSdk(agent: Agent): Promise<FileRootSdk[]> {
        const roots = await this.resolveRoots(agent)
        const binaryWriteSafe =
            agent.runtime === 'daemon' && agent.daemonId
                ? await this.daemonBinaryWriteSafe(agent.daemonId)
                : true
        return roots.map((root) =>
            toSdkRoot(root, rootCapabilities({ agent, root, binaryWriteSafe }))
        )
    }

    private storedShapeIsCurrent(agent: Agent, stored: FileRoot[]): boolean {
        const homeKnown =
            agent.runtime === 'k8s' ||
            agent.runtime === 'daemon' ||
            stored.some((r) => r.id !== 'workspace' && !!r.path)
        const expected = expectedRootIds({
            framework: agent.framework,
            runtime: agent.runtime,
            homeKnown
        })
        const have = new Set(stored.map((r) => r.id))
        return expected.every((id) => have.has(id))
    }

    private async computeDefaults(
        agent: Agent,
        stored: FileRoot[] = []
    ): Promise<FileRoot[]> {
        if (agent.runtime === 'k8s')
            return buildFileRoots({
                framework: agent.framework,
                runtime: 'k8s',
                mountPath: agent.mountPath,
                ...(isCustomWorkspace(agent)
                    ? { workspaceTransport: 'pod-exec' as const }
                    : {})
            })
        if (agent.runtime === 'daemon') {
            const runtime = agent.runtimeId
                ? await this.runtimes.findById(agent.runtimeId)
                : null
            return buildFileRoots({
                framework: agent.framework,
                runtime: 'daemon',
                mountPath: agent.mountPath,
                homeDir: runtime?.homeDir ?? deriveHomeFromStored(stored)
            })
        }
        const probedHome = await this.probeSpriteHome(agent).catch(
            () => undefined
        )
        const homeDir = probedHome ?? deriveHomeFromStored(stored)
        return buildFileRoots({
            framework: agent.framework,
            runtime: 'sprites',
            mountPath: agent.mountPath,
            homeDir
        })
    }

    private async probeSpriteHome(agent: Agent): Promise<string | undefined> {
        const client = await this.spriteClientFor(agent)
        const result = await execSprite(client, agent.spriteName!, {
            cmd: ['bash', '-lc', `printf 'MF_HOME=%s\\n' "$HOME"`],
            stdin: '',
            timeoutMs: 10_000
        })
        if (result.exitCode !== 0) return undefined
        return extractHomeDir(result.stdout)
    }

    private async spriteClientFor(agent: Agent): Promise<SpritesClient> {
        const account = await this.accounts.getById(agent.accountId!)
        if (!account)
            throw new NotFoundException(
                `sprites account ${agent.accountId} not found`
            )
        const token = this.accounts.decryptToken(account)
        return createClient({ token, accountSlug: account.slug })
    }

    async build(agent: Agent, rootId?: string | null): Promise<FilesContext> {
        if (agent.runtime === 'external')
            throw new NotFoundException(
                `external-runtime agents have no filesystem`
            )
        if (agent.framework === 'narranexus') {
            const root = pickRoot(await this.resolveRoots(agent), rootId)
            const ctx =
                root.id === 'workspace'
                    ? await this.narraNexusCtx(agent, root)
                    : await this.spriteCtx(agent, root)
            return withImageContentTypeFallback(ctx)
        }
        const roots = await this.resolveRoots(agent)
        const root = pickRoot(roots, rootId)
        const ctx =
            agent.runtime === 'sprites'
                ? await this.spriteCtx(agent, root)
                : agent.runtime === 'daemon'
                  ? await this.daemonCtx(agent, root)
                  : await this.k8sCtx(agent, root)
        await this.ensureRootExists(agent, root, ctx)
        return withImageContentTypeFallback(ctx)
    }

    // The workspace layout is NarraNexus's to define and it has changed at
    // least once. Asking the gateway is the only way to stay correct across
    // that: a locally derived path silently addresses the wrong directory, and
    // every file call then fails the far side's containment check with 403
    // "path escapes workspace" rather than anything that reads as a layout
    // problem. The seed we compute at provisioning time is a bootstrap value,
    // never an answer — see narraNexusSeedWorkspacePath.
    private async narraNexusRoots(agent: Agent): Promise<FileRoot[]> {
        const cached = this.narraNexusRootsCache.get(agent.id)
        if (cached && cached.expiresAt > Date.now()) return cached.roots
        const fetched = await this.narraNexusWorkspaceFromGateway(agent)
        if (fetched === null) {
            // Last known good beats a fresh guess: the guess is what this whole
            // path exists to stop trusting.
            const stored = storedRootPath(agent, 'workspace')
            if (!stored)
                throw new ServiceUnavailableException(
                    `narranexus workspace layout for agent ${agent.id} is unknown — the gateway did not answer /files/roots`
                )
            return narraNexusRootShape(agent, stored)
        }
        const roots = narraNexusRootShape(agent, fetched)
        this.narraNexusRootsCache.set(agent.id, {
            roots,
            expiresAt: Date.now() + NARRANEXUS_ROOTS_TTL_MS
        })
        await this.persistNarraNexusWorkspace(agent, roots, fetched)
        return roots
    }

    private async narraNexusWorkspaceFromGateway(
        agent: Agent
    ): Promise<string | null> {
        try {
            const roots = await narraNexusListRoots(
                await this.narraNexusTarget(agent)
            )
            const workspace =
                roots.find((r) => r.id === 'workspace') ?? roots[0]
            const path = workspace?.path?.trim()
            return path && path.startsWith('/') ? path : null
        } catch (err) {
            this.log.warn(
                `narranexus files/roots failed for agent ${agent.id}: ${(err as Error).message}`
            )
            return null
        }
    }

    // agent.fileRoots doubles as the offline fallback above, and workspacePath
    // is what agent diagnostics measures storage against — both keep pointing
    // at the stale layout until something writes the resolved one back.
    private async persistNarraNexusWorkspace(
        agent: Agent,
        roots: FileRoot[],
        workspacePath: string
    ): Promise<void> {
        if (
            storedRootPath(agent, 'workspace') === workspacePath &&
            agent.workspacePath === workspacePath
        )
            return
        try {
            await this.db
                .update(agents)
                .set({ fileRoots: roots, workspacePath, updatedAt: new Date() })
                .where(eq(agents.id, agent.id))
        } catch (err) {
            this.log.warn(
                `failed to persist narranexus workspace for agent ${agent.id}: ${(err as Error).message}`
            )
        }
    }

    private async narraNexusTarget(
        agent: Agent
    ): Promise<{
        ingressHost: string
        gatewayToken: string
        agentId: string
    }> {
        const runtime = agent.runtimeId
            ? await this.runtimes.findById(agent.runtimeId)
            : null
        if (!runtime || !runtime.ingressHost)
            throw new NotFoundException(
                `narranexus runtime for agent ${agent.id} missing ingress host`
            )
        const token = await loadNarraNexusGatewayToken(
            this.db,
            this.crypto,
            runtime.id
        )
        if (!token)
            throw new NotFoundException(
                `narranexus runtime ${runtime.id} missing gateway token`
            )
        return {
            ingressHost: runtime.ingressHost,
            gatewayToken: token,
            agentId: agent.internalId
        }
    }

    private async narraNexusCtx(
        agent: Agent,
        root: FileRoot
    ): Promise<FilesContext> {
        const workspace = root.path
        const target = await this.narraNexusTarget(agent)
        const readOnly = (op: string): never => {
            throw new ForbiddenException(
                `narranexus workspace is read-only (${op})`
            )
        }
        return {
            agent,
            root,
            mountPath: workspace,
            list: (abs) => narraNexusListDir(target, abs || workspace),
            stat: (abs) => narraNexusStat(target, abs),
            read: (abs) => narraNexusRead(target, abs),
            // The one write path NarraNexus exposes, and it stays reachable only
            // from chat attachment ingest: the user- and admin-facing file
            // controllers gate on root.writable (false for every NarraNexus
            // root) and on a zero maxUploadBytes, both left untouched.
            write: (abs, body) =>
                narraNexusWrite(target, abs, body, { overwrite: true }),
            // The write endpoint creates parent directories itself, so ingest's
            // mkdir has nothing to do rather than being forbidden — throwing
            // here would fail the turn one call before the write it precedes.
            mkdir: async () => {},
            mv: async () => readOnly('mv'),
            rm: async () => readOnly('rm')
        }
    }

    private async daemonCtx(
        agent: Agent,
        root: FileRoot
    ): Promise<FilesContext> {
        if (!agent.daemonId)
            throw new NotFoundException(
                `daemon agent ${agent.id} missing daemonId`
            )
        const daemonId = agent.daemonId
        const rpc = (
            method: import('@manyfold/shared').DaemonRpcMethod,
            payload: Record<string, unknown>
        ) => {
            return this.daemonRegistry.rpc({
                daemonId,
                method,
                payload,
                timeoutMs: 30_000
            })
        }
        const binaryWriteSafe = await this.daemonBinaryWriteSafe(daemonId)
        return {
            agent,
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
                    uploadBound(agent, root)
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
        agent: Agent,
        root: FileRoot
    ): Promise<FilesContext> {
        const account = await this.accounts.getById(agent.accountId!)
        if (!account)
            throw new NotFoundException(
                `sprites account ${agent.accountId} not found`
            )
        const token = this.accounts.decryptToken(account)
        const client = createClient({ token, accountSlug: account.slug })
        const spriteName = agent.spriteName!
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
                    body: boundedChunks(body, uploadBound(agent, root)),
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

    private async k8sCtx(agent: Agent, root: FileRoot): Promise<FilesContext> {
        const runtime = await this.runtimes.findById(agent.runtimeId)
        if (!runtime)
            throw new NotFoundException(
                `runtime ${agent.runtimeId} not found for agent ${agent.id}`
            )
        if (root.transport === 'pod-exec')
            return this.k8sPodExecCtx(agent, root, runtime)
        if (!runtime.ingressHost)
            throw new NotFoundException(
                `runtime ${runtime.id} missing ingressHost; files unavailable`
            )
        if (!runtime.primaryAgentId)
            throw new NotFoundException(
                `runtime ${runtime.id} has no primaryAgentId; files unavailable`
            )
        const target: K8sFilesTarget = {
            runtimeId: runtime.id,
            primaryAgentId: runtime.primaryAgentId,
            ingressHost: runtime.ingressHost,
            pathMapping: k8sDufsPathMappingForRoot(agent, root)
        }
        return {
            agent,
            root,
            mountPath: root.path,
            list: (abs) => k8sListDir(agent, target, abs),
            stat: (abs) => k8sStatFile(target, abs),
            read: async (abs) => {
                const r = await k8sReadFile(target, abs)
                if (!r) return null
                return r
            },
            write: (abs, body) =>
                k8sWriteFile(
                    target,
                    abs,
                    boundedChunks(body, uploadBound(agent, root))
                ),
            mkdir: (abs) => k8sMkdir(target, abs),
            mv: (src, dst) => k8sMv(target, src, dst),
            rm: (abs) => k8sRm(target, abs)
        }
    }

    private async k8sPodExecCtx(
        agent: Agent,
        root: FileRoot,
        runtime: AgentRuntimeRow
    ): Promise<FilesContext> {
        if (!runtime.primaryAgentId)
            throw new NotFoundException(
                `runtime ${runtime.id} has no primaryAgentId; files unavailable`
            )
        const pod = await this.resolvePodCached(runtime)
        const podExec = this.podExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const client = new K8sPodFilesClient(podExec, root.path)
        return {
            agent,
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
                    await collectBounded(body, uploadBound(agent, root))
                ),
            mkdir: (abs) => client.mkdir(abs),
            mv: (src, dst) => client.mv(src, dst),
            rm: (abs, recursive) => client.rm(abs, recursive)
        }
    }
}

export const assertAgentReady = (agent: Agent): void => {
    if (agent.runtime === 'external')
        throw new NotFoundException(
            `external-runtime agents have no filesystem`
        )
    if (agent.status !== 'running')
        throw new NotFoundException(
            `agent is ${agent.status}; files available only when running`
        )
    if (agent.framework === 'narranexus') return
    if (agent.runtime === 'sprites') {
        if (!agent.spriteName || !agent.accountId)
            throw new NotFoundException(
                'sprite agent missing spriteName or accountId'
            )
        return
    }
    if (agent.runtime === 'daemon') {
        if (!agent.daemonId)
            throw new NotFoundException('daemon agent missing daemonId')
        return
    }
    if (agent.runtime === 'k8s') {
        if (!agent.namespace)
            throw new NotFoundException('k8s agent missing namespace')
        return
    }
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

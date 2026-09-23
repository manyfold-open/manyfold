import { SPRITE_HOME_BASE, narraNexusBaseWorkingPath } from '@manyfold/shared'
import {
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Agent, type Database, type FileRoot } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { HOME_ROOT_ID } from '@/modules/agents/bootstrap/file-roots'
import type { FilesContext } from '@/modules/agents/files/files-context'
import type { FrameworkFilesProvider } from '@/modules/frameworks/framework-extension'
import { loadNarraNexusGatewayToken } from '../narranexus-http'
import {
    narraNexusListDir,
    narraNexusListRoots,
    narraNexusRead,
    narraNexusStat,
    narraNexusWrite
} from './narranexus-files-client'

// Long enough that a Files-page session costs one lookup, short enough that a
// workspace layout change on the NarraNexus side heals without a restart.
const ROOTS_TTL_MS = 5 * 60_000

interface CachedRoots {
    roots: FileRoot[]
    expiresAt: number
}

const storedRootPath = (agent: Agent, rootId: string): string | null => {
    const stored = Array.isArray(agent.fileRoots) ? agent.fileRoots : []
    return stored.find((r) => r.id === rootId)?.path || null
}

// Only the workspace path comes from NarraNexus. The two sprite-side roots are
// Manyfold's own knowledge of the sandbox image, and every root stays
// writable: false — the gateway's write endpoint is reachable from chat
// attachment ingest only, never from the file controllers.
const rootShape = (agent: Agent, workspacePath: string): FileRoot[] => {
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

// NarraNexus's gateway file API serves only the per-agent workspace
// (read-only); ~/.narranexus and the sprite home sit outside that lock, so on
// sprites they are read-only roots browsed via direct sprite access instead of
// the gateway (buildContext answers null for them).
@Injectable()
export class NarraNexusFilesProvider implements FrameworkFilesProvider {
    private readonly log = new Logger(NarraNexusFilesProvider.name)
    private readonly rootsCache = new Map<string, CachedRoots>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly runtimes: AgentRuntimesService
    ) {}

    // The workspace layout is NarraNexus's to define and it has changed at
    // least once. Asking the gateway is the only way to stay correct across
    // that: a locally derived path silently addresses the wrong directory, and
    // every file call then fails the far side's containment check with 403
    // "path escapes workspace" rather than anything that reads as a layout
    // problem. The seed we compute at provisioning time is a bootstrap value,
    // never an answer — see narraNexusSeedWorkspacePath.
    async resolveRoots(agent: Agent): Promise<FileRoot[]> {
        const cached = this.rootsCache.get(agent.id)
        if (cached && cached.expiresAt > Date.now()) return cached.roots
        const fetched = await this.workspaceFromGateway(agent)
        if (fetched === null) {
            // Last known good beats a fresh guess: the guess is what this whole
            // path exists to stop trusting.
            const stored = storedRootPath(agent, 'workspace')
            if (!stored)
                throw new ServiceUnavailableException(
                    `narranexus workspace layout for agent ${agent.id} is unknown — the gateway did not answer /files/roots`
                )
            return rootShape(agent, stored)
        }
        const roots = rootShape(agent, fetched)
        this.rootsCache.set(agent.id, {
            roots,
            expiresAt: Date.now() + ROOTS_TTL_MS
        })
        await this.persistWorkspace(agent, roots, fetched)
        return roots
    }

    async buildContext(
        agent: Agent,
        root: FileRoot
    ): Promise<FilesContext | null> {
        if (root.id !== 'workspace') return null
        const workspace = root.path
        const target = await this.target(agent)
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

    // The home root, not the workspace: NarraNexus creates the workspace
    // lazily, so it may not exist when a terminal opens.
    defaultTerminalCwd(agent: Agent): string {
        const homeRoot = Array.isArray(agent.fileRoots)
            ? agent.fileRoots.find((root) => root.id === HOME_ROOT_ID)
            : null
        if (homeRoot?.path) return homeRoot.path
        return narraNexusBaseWorkingPath(agent.runtime).replace(
            /\/workspaces$/,
            ''
        )
    }

    private async workspaceFromGateway(agent: Agent): Promise<string | null> {
        try {
            const roots = await narraNexusListRoots(await this.target(agent))
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
    private async persistWorkspace(
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

    private async target(agent: Agent): Promise<{
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
}

import {
    defaultFrameworkRepo,
    frameworkRepoCloneUrl,
    registerFramework,
    type ChatCapabilities,
    type FrameworkDefinition
} from '@manyfold/shared'
import type { Agent, FileRoot } from '@manyfold/db'
import { execSprite } from '@manyfold/sprites'
import {
    BootstrapError,
    type BootstrapContext
} from '../../src/modules/agents/bootstrap/framework-bootstrap'
import type {
    SpriteServiceBootstrap,
    SpriteServiceBootstrapResult
} from '../../src/modules/agents/bootstrap/sprite-framework-bootstrap'
import type { FilesContext } from '../../src/modules/agents/files/files-context'
import { GatewayHttpChatAdapter } from '../../src/modules/chat/adapters/gateway-http-chat.adapter'
import {
    githubSource,
    registerFrameworkVersionDescriptor
} from '../../src/modules/framework-versions/framework-version-registry'
import type {
    FrameworkChannels,
    FrameworkControlUi,
    FrameworkFilesProvider,
    FrameworkVersionExtension
} from '../../src/modules/frameworks/framework-extension'

// A framework an edition registers (ADR-0034), standing in for the ones the
// core does not ship: a service on sprites and k8s whose clone follows the
// repository an admin picks from its two, that serves its own files, and that
// brings an agent-scoped control UI, a managed-reply policy and a Matrix
// dialect. Importing this file registers its definition and its version
// descriptor, as its module would at boot; each test file runs in its own
// process, so nothing leaks into another.
export const FIXTURE = 'fixture-gateway'
export const FIXTURE_UPSTREAM = 'example-org/fixture-gateway'
export const FIXTURE_FORK = 'fork-org/fixture-gateway'
const HOME = '/home/sprite/.fixture-gateway'
export const FIXTURE_WORKSPACE = `${HOME}/workspaces/agent-1`

export const fixtureDefinition: FrameworkDefinition = {
    id: FIXTURE,
    displayName: 'Fixture Gateway',
    kind: 'service',
    runtimes: ['sprites', 'k8s'],
    chat: {
        streaming: true,
        toolCalls: true,
        thinking: false,
        attachments: true,
        multiTurn: true
    },
    version: {
        upgradeMode: 'rebuild',
        repoCandidates: [
            { repo: FIXTURE_UPSTREAM, label: 'example-org' },
            { repo: FIXTURE_FORK, label: 'fork-org' }
        ]
    },
    reservedEnvPrefixes: ['FIXTUREGW_'],
    defaultRuntime: 'sprites',
    credentials: 'runtime-ui',
    files: { servedBy: 'framework', maxDownloadBytes: 8 * 1024 * 1024 },
    nativeUi: 'always',
    schedules: 'mirrored'
}
registerFramework(fixtureDefinition)

const cloneShell = (version: string, repo: string): string =>
    `git clone --depth 1 --branch "${version}" "${frameworkRepoCloneUrl(repo)}" "${HOME}/app"`

export const FIXTURE_RESTORE_SHELL = `mv "${HOME}/app.bak" "${HOME}/app"`

export const fixtureVersion: FrameworkVersionExtension = {
    descriptor: {
        framework: FIXTURE,
        runtimeKind: 'daemon',
        source: githubSource(FIXTURE),
        binName: FIXTURE,
        probeShell: `git -C "${HOME}/app" describe --tags 2>/dev/null || true`,
        serviceName: FIXTURE
    },
    rebuildShells: ({ version, repo }) => ({
        rebuild: cloneShell(version, repo),
        restore: FIXTURE_RESTORE_SHELL
    })
}
registerFrameworkVersionDescriptor(fixtureVersion.descriptor)

// Installs by cloning the admitted tag from the admitted repository: the one
// install step the version-source tests read.
export class FixtureSpriteBootstrap implements SpriteServiceBootstrap {
    readonly framework = FIXTURE

    async run(
        ctx: BootstrapContext,
        _credentials: unknown
    ): Promise<SpriteServiceBootstrapResult> {
        const version = ctx.frameworkVersion ?? 'v1.0.0'
        const repo =
            ctx.frameworkRepo ??
            defaultFrameworkRepo(FIXTURE) ??
            FIXTURE_UPSTREAM
        const install = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['bash', '-lc', cloneShell(version, repo)],
                stdin: '',
                timeoutMs: 60_000
            },
            ctx.logger
        )
        if (install.exitCode !== 0)
            throw new BootstrapError(
                'fixture-install',
                `fixture install exited ${install.exitCode}`
            )
        return { serviceName: FIXTURE }
    }

    async restart(): Promise<void> {}
}

// The gateway HTTP transport with nothing of its own: the base class's turn,
// resume and error paths, reached through a concrete framework.
export class FixtureChatAdapter extends GatewayHttpChatAdapter {
    readonly framework = FIXTURE

    getCapabilities(): ChatCapabilities {
        return { ...fixtureDefinition.chat }
    }
}

const readOnly = async (): Promise<never> => {
    throw new Error('fixture workspace is read-only')
}

// Serves its workspace itself; its home root stays on the runtime's own
// transport. `files` is the workspace's content, keyed by absolute path.
export const fixtureFiles = (
    files: Record<string, Uint8Array> = {}
): FrameworkFilesProvider => ({
    resolveRoots: async () => [
        {
            id: 'workspace',
            label: 'Workspace',
            path: FIXTURE_WORKSPACE,
            writable: false
        },
        { id: 'home', label: 'Home', path: '/home/sprite', writable: false }
    ],
    buildContext: async (agent: Agent, root: FileRoot) => {
        if (root.id !== 'workspace') return null
        const context: FilesContext = {
            agent,
            root,
            mountPath: root.path,
            list: async () => [],
            // Octet-stream, as a gateway that only knows bytes would answer.
            stat: async (absPath) => {
                const body = files[absPath]
                if (!body) return null
                return {
                    entry: {
                        name: absPath.split('/').pop() ?? absPath,
                        type: 'file',
                        size: body.byteLength,
                        mtime: 1,
                        mode: '644'
                    },
                    contentType: 'application/octet-stream'
                }
            },
            read: async (absPath) => {
                const body = files[absPath]
                if (!body) return null
                return {
                    stream: (async function* () {
                        yield body
                    })(),
                    size: body.byteLength,
                    contentType: 'application/octet-stream'
                }
            },
            write: readOnly,
            mkdir: readOnly,
            mv: readOnly,
            rm: readOnly
        }
        return context
    }
})

export const fixtureControlUi: FrameworkControlUi = {
    agentScoped: true,
    mint: ({ runtime, agentInternalId }) =>
        `https://${runtime.ingressHost}/ui?agent=${agentInternalId ?? ''}`
}

export const FIXTURE_MSGTYPE = 'org.example.fixture'
export const FIXTURE_PLACEHOLDER = '[fixture] open the app to see this message'

// Delivers its own replies on telegram and lark anywhere, and on matrix only
// in rooms that mirror its own bindings; speaks a Matrix msgtype of its own
// there, announced by a plain-text placeholder.
export const fixtureChannels: FrameworkChannels = {
    managedReply: {
        supportsProvider: (provider, { mirrored }) =>
            provider === 'telegram' ||
            provider === 'lark' ||
            (provider === 'matrix' && mirrored)
    },
    matrixDialect: {
        isPlaceholder: (body) => body === FIXTURE_PLACEHOLDER,
        parse: (msgtype, content) => {
            if (msgtype !== FIXTURE_MSGTYPE) return undefined
            const text = typeof content.text === 'string' ? content.text : ''
            const url = typeof content.url === 'string' ? content.url : null
            if (!text.trim() && !url) return null
            return {
                text,
                attachments: url ? [{ url, name: 'attachment' }] : []
            }
        }
    }
}

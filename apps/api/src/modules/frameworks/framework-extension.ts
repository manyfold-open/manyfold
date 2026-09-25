import type { AgentFramework, ChannelProviderName } from '@manyfold/shared'
import type { Agent, AgentRuntimeRow, FileRoot } from '@manyfold/db'
import type { AgentAdapter } from '@/modules/agents/adapters/agent-adapter'
import type { SpriteServiceBootstrap } from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import type { FilesContext } from '@/modules/agents/files/files-context'
import type { NormalizedInboundAttachment } from '@/modules/channels/channel-provider'
import type { ApiChatAdapter } from '@/modules/chat/chat-adapter'
import type { FrameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'

// A framework's long-lived service on a sprite: how it is installed, where it
// lives, and what the keep-alive lease needs to supervise it.
export interface FrameworkSpriteService {
    bootstrap: SpriteServiceBootstrap
    // Where the service's runtime lives on the sprite.
    mountPath: string
    // The workspace a new agent is created with. When the framework owns its
    // workspace layout (runner.lazyWorkspace) this is only a seed: nothing
    // may address a file through it before the files provider resolves it.
    workspaceSeed(agentId: string, userId: string): string
    supervision: {
        // Used when the runtime row carries no home dir of its own.
        homeDir: string
        // Probed, unauthenticated, by the sprite's start reporter.
        healthUrl: string
        // The service command when no start script was installed.
        fallbackExec(homeDir: string): string[]
    }
}

export interface FrameworkVersionExtension {
    descriptor: FrameworkVersionDescriptor
    // Shells for an upgradeMode 'rebuild' framework: rebuild installs
    // `version` from `repo`, restore puts the previous install back.
    rebuildShells?(input: { version: string; repo: string }): {
        rebuild: string
        restore: string
    }
}

// Files the framework serves itself (FrameworkDefinition.files).
export interface FrameworkFilesProvider {
    resolveRoots(agent: Agent): Promise<FileRoot[]>
    // null: the root is served by the runtime's own filesystem transport.
    buildContext(agent: Agent, root: FileRoot): Promise<FilesContext | null>
    // Where a terminal opens when the caller names no directory.
    defaultTerminalCwd?(agent: Agent): string
}

// The runtime's own UI, opened through a link Manyfold mints.
export interface FrameworkControlUi {
    // The link names one agent (the caller's, else the runtime's primary).
    agentScoped: boolean
    mint(input: {
        runtime: AgentRuntimeRow & { ingressHost: string }
        credentials: Record<string, unknown>
        agentInternalId: string | null
    }): string
}

// How a framework takes part in channels whose rows mirror its own bindings
// (MirrorOrigin.kind is the framework id).
export interface FrameworkChannels {
    // config.agentManagedReply hands delivery to the agent itself; only
    // providers the framework can deliver on may take it.
    managedReply?: {
        supportsProvider(
            provider: ChannelProviderName,
            options: { mirrored: boolean }
        ): boolean
    }
    // A Matrix message dialect the framework's own client speaks on mirrored
    // rooms.
    matrixDialect?: {
        // A client-side placeholder that must not reach the agent.
        isPlaceholder(body: string): boolean
        // undefined: not this dialect's msgtype. null: this dialect's
        // msgtype, carrying nothing.
        parse(
            msgtype: string,
            content: Record<string, unknown>
        ):
            | { text: string; attachments: NormalizedInboundAttachment[] }
            | null
            | undefined
    }
}

// Everything the API needs to run a framework the core does not ship
// (ADR-0034). The owning module registers one of these in its constructor;
// its static facts are the shared FrameworkDefinition registered under the
// same id.
export interface FrameworkExtension {
    framework: AgentFramework
    agentAdapter: AgentAdapter
    chatAdapter: ApiChatAdapter
    // The framework keeps its own agent list: the primary agent is pushed
    // into it right after provisioning, so the first reconcile finds it.
    pushPrimaryAgent?: boolean
    spriteService?: FrameworkSpriteService
    version?: FrameworkVersionExtension
    files?: FrameworkFilesProvider
    controlUi?: FrameworkControlUi
    channels?: FrameworkChannels
}

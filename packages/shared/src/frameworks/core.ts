import {
    DAEMON_FEATURE_TURN_HERMES,
    DAEMON_FEATURE_TURN_OPENCLAW_ACP
} from '../daemon'
import type { FrameworkDefinition } from './definition'

// Coding CLIs first, then the service frameworks, then the external APIs: the
// order every framework list and picker shows.
export const coreFrameworks = [
    'claude-code',
    'codex',
    'gemini-cli',
    'pi',
    'openclaw',
    'hermes',
    'dify',
    'langflow',
    'a2a'
] as const

export type CoreFramework = (typeof coreFrameworks)[number]

// Open on purpose (ADR-0034): a row can carry a framework id that an edition
// registers at startup, so nothing may assume every id is a core one. Tables
// keyed by framework are `Record<CoreFramework, …>` plus a registry lookup.
export type AgentFramework = CoreFramework | (string & {})

const FULL_CHAT = {
    streaming: true,
    toolCalls: true,
    thinking: true,
    attachments: true,
    multiTurn: true
} as const

export const coreFrameworkDefinitions = {
    'claude-code': {
        id: 'claude-code',
        displayName: 'Claude Code',
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: {
            rootId: 'claude-home',
            label: 'Claude config',
            subdir: '.claude'
        },
        mcp: {
            format: 'json',
            scopes: [
                { id: 'user', label: 'User', path: '~/.claude.json' },
                {
                    id: 'project',
                    label: 'Project',
                    path: '<workspace>/.mcp.json'
                }
            ]
        },
        chat: FULL_CHAT,
        version: { upgradeMode: 'npm' },
        defaultRuntime: 'sprites'
    },
    codex: {
        id: 'codex',
        displayName: 'Codex',
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: {
            rootId: 'codex-home',
            label: 'Codex config',
            subdir: '.codex'
        },
        mcp: {
            format: 'toml',
            scopes: [
                {
                    id: 'global',
                    label: 'Global',
                    path: '~/.codex/config.toml'
                }
            ]
        },
        chat: FULL_CHAT,
        version: { upgradeMode: 'npm' },
        defaultRuntime: 'sprites'
    },
    'gemini-cli': {
        id: 'gemini-cli',
        displayName: 'Gemini CLI',
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: {
            rootId: 'gemini-home',
            label: 'Gemini config',
            subdir: '.gemini'
        },
        mcp: {
            format: 'json',
            scopes: [
                {
                    id: 'user',
                    label: 'User',
                    path: '~/.gemini/settings.json'
                }
            ]
        },
        chat: FULL_CHAT,
        version: { upgradeMode: 'npm' },
        defaultRuntime: 'sprites'
    },
    // pi reads MCP servers only through extensions (no config file), so it
    // carries no `mcp` entry; the config home is the parent of ~/.pi/agent so
    // the file root shows sessions and settings alike.
    pi: {
        id: 'pi',
        displayName: 'Pi',
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: { rootId: 'pi-home', label: 'Pi config', subdir: '.pi' },
        chat: FULL_CHAT,
        version: { upgradeMode: 'npm' },
        defaultRuntime: 'sprites'
    },
    openclaw: {
        id: 'openclaw',
        displayName: 'OpenClaw',
        kind: 'service',
        runtimes: ['sprites', 'k8s', 'daemon'],
        chat: { ...FULL_CHAT, thinking: false },
        version: { upgradeMode: 'npm' },
        reservedEnvPrefixes: ['OPENCLAW_'],
        runner: {
            requiredFeatures: [DAEMON_FEATURE_TURN_OPENCLAW_ACP],
            lazyWorkspace: true
        }
    },
    hermes: {
        id: 'hermes',
        displayName: 'Hermes Agent',
        kind: 'service',
        runtimes: ['sprites', 'k8s', 'daemon'],
        chat: FULL_CHAT,
        // hermes re-runs NousResearch's install.sh pinned to a CalVer tag
        // (`--branch v2026.x.y`); the catalog tag is the version of record,
        // not the decoupled pyproject version `hermes --version` prints.
        version: {
            upgradeMode: 'rebuild',
            // Exactly one candidate: its bootstrap pipes NousResearch's own
            // install.sh, which clones a repository hardcoded inside that
            // script, so the clone path is not driven by this slug.
            repoCandidates: [
                {
                    repo: 'NousResearch/hermes-agent',
                    label: 'NousResearch (upstream)'
                }
            ]
        },
        reservedEnvPrefixes: ['HERMES_'],
        runner: { requiredFeatures: [DAEMON_FEATURE_TURN_HERMES] }
    },
    dify: {
        id: 'dify',
        displayName: 'Dify',
        kind: 'external',
        runtimes: ['external'],
        chat: { ...FULL_CHAT, toolCalls: false }
    },
    langflow: {
        id: 'langflow',
        displayName: 'Langflow',
        kind: 'external',
        runtimes: ['external'],
        chat: {
            ...FULL_CHAT,
            toolCalls: false,
            thinking: false,
            attachments: false
        }
    },
    a2a: {
        id: 'a2a',
        displayName: 'A2A',
        kind: 'external',
        runtimes: ['external'],
        chat: {
            ...FULL_CHAT,
            toolCalls: false,
            thinking: false,
            attachments: false
        }
    }
} satisfies { [K in CoreFramework]: FrameworkDefinition & { id: K } }

export type CoreVersionedFramework = {
    [K in CoreFramework]: (typeof coreFrameworkDefinitions)[K] extends {
        version: object
    }
        ? K
        : never
}[CoreFramework]

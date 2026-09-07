import type {
    AgentFramework,
    ClaudeCodePermissionMode,
    CodexPermissionMode,
    CreateMessageRequest,
    HermesPermissionMode,
    OpenclawPermissionMode
} from '@manyfold/shared'
import {
    DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    DEFAULT_CODEX_PERMISSION_MODE,
    DEFAULT_HERMES_PERMISSION_MODE,
    DEFAULT_OPENCLAW_PERMISSION_MODE,
    isClaudeCodePermissionMode,
    isCodexPermissionMode,
    isHermesPermissionMode,
    isOpenclawPermissionMode
} from '@manyfold/shared'
import {
    EditIcon,
    HandIcon,
    ShieldAlertIcon,
    ShieldCheckIcon,
    TasksIcon,
    ZapIcon,
    type LucideIcon
} from '@/components/icons'

// The permission-mode selector is one shape across every framework that has
// one, so the per-framework arrays + the parallel canChoose/options/active
// ternary chains in the composer collapse to this single table. Adding a
// framework is one entry here plus its i18n keys — and there is no
// silent-wrong-dispatch arm to forget. The i18n keys are LITERALS so the
// superproject orphan ratchet counts them as used.
export interface PermissionOption {
    value: string
    labelKey: string
    titleKey: string
    descriptionKey: string
    icon: LucideIcon
    dangerous?: boolean
}

// A mode value the composer selector can carry, across every framework that has
// one. The table erases the per-framework link (an option's value is a plain
// string), so this union is the composer's boundary type; the runtime guard is
// each entry's isMode, and the API DTO validates the field on arrival.
export type ComposerPermissionMode =
    | ClaudeCodePermissionMode
    | CodexPermissionMode
    | HermesPermissionMode
    | OpenclawPermissionMode

// Which CreateMessageRequest field the picked mode rides on.
export type PermissionRequestField =
    | 'claudeCodePermissionMode'
    | 'codexPermissionMode'
    | 'hermesPermissionMode'
    | 'openclawPermissionMode'

export interface PermissionModeEntry {
    options: PermissionOption[]
    defaultMode: string
    requestField: PermissionRequestField
    // The localStorage key prefix `<prefix><agentId>` the pick persists under.
    storagePrefix: string
    // Narrows a stored raw value back to a valid mode for this framework.
    isMode: (value: unknown) => boolean
}

export const permissionModesByFramework: Partial<
    Record<AgentFramework, PermissionModeEntry>
> = {
    'claude-code': {
        defaultMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
        requestField: 'claudeCodePermissionMode',
        storagePrefix: 'nca.chat.claudeCodePermissionMode.',
        isMode: isClaudeCodePermissionMode,
        options: [
            {
                value: 'default',
                labelKey: 'web.composer.permission.claude.ask',
                titleKey: 'web.composer.permission.claude.askTitle',
                descriptionKey: 'web.composer.permission.claude.askDescription',
                icon: HandIcon
            },
            {
                value: 'acceptEdits',
                labelKey: 'web.composer.permission.claude.acceptEdits',
                titleKey: 'web.composer.permission.claude.acceptEditsTitle',
                descriptionKey:
                    'web.composer.permission.claude.acceptEditsDescription',
                icon: EditIcon
            },
            {
                value: 'plan',
                labelKey: 'web.composer.permission.claude.plan',
                titleKey: 'web.composer.permission.claude.planTitle',
                descriptionKey: 'web.composer.permission.claude.planDescription',
                icon: TasksIcon
            },
            {
                value: 'auto',
                labelKey: 'web.composer.permission.claude.auto',
                titleKey: 'web.composer.permission.claude.autoTitle',
                descriptionKey: 'web.composer.permission.claude.autoDescription',
                icon: ZapIcon
            },
            {
                value: 'dontAsk',
                labelKey: 'web.composer.permission.claude.dontAsk',
                titleKey: 'web.composer.permission.claude.dontAskTitle',
                descriptionKey:
                    'web.composer.permission.claude.dontAskDescription',
                icon: ShieldCheckIcon
            },
            {
                value: 'bypassPermissions',
                labelKey: 'web.composer.permission.claude.bypass',
                titleKey: 'web.composer.permission.claude.bypassTitle',
                descriptionKey:
                    'web.composer.permission.claude.bypassDescription',
                icon: ShieldAlertIcon,
                dangerous: true
            }
        ]
    },
    codex: {
        defaultMode: DEFAULT_CODEX_PERMISSION_MODE,
        requestField: 'codexPermissionMode',
        storagePrefix: 'nca.chat.codexPermissionMode.',
        isMode: isCodexPermissionMode,
        options: [
            {
                value: 'default',
                labelKey: 'web.composer.permission.codex.ask',
                titleKey: 'web.composer.permission.codex.askTitle',
                descriptionKey: 'web.composer.permission.codex.askDescription',
                icon: HandIcon
            },
            {
                value: 'auto-review',
                labelKey: 'web.composer.permission.codex.approve',
                titleKey: 'web.composer.permission.codex.approveTitle',
                descriptionKey:
                    'web.composer.permission.codex.approveDescription',
                icon: ShieldCheckIcon
            },
            {
                value: 'full-access',
                labelKey: 'web.composer.permission.codex.full',
                titleKey: 'web.composer.permission.codex.fullTitle',
                descriptionKey: 'web.composer.permission.codex.fullDescription',
                icon: ShieldAlertIcon,
                dangerous: true
            }
        ]
    },
    hermes: {
        defaultMode: DEFAULT_HERMES_PERMISSION_MODE,
        requestField: 'hermesPermissionMode',
        storagePrefix: 'nca.chat.hermesPermissionMode.',
        isMode: isHermesPermissionMode,
        options: [
            {
                value: 'default',
                labelKey: 'web.composer.permission.hermes.ask',
                titleKey: 'web.composer.permission.hermes.askTitle',
                descriptionKey: 'web.composer.permission.hermes.askDescription',
                icon: HandIcon
            },
            {
                value: 'acceptEdits',
                labelKey: 'web.composer.permission.hermes.acceptEdits',
                titleKey: 'web.composer.permission.hermes.acceptEditsTitle',
                descriptionKey:
                    'web.composer.permission.hermes.acceptEditsDescription',
                icon: EditIcon
            },
            {
                value: 'dontAsk',
                labelKey: 'web.composer.permission.hermes.dontAsk',
                titleKey: 'web.composer.permission.hermes.dontAskTitle',
                descriptionKey:
                    'web.composer.permission.hermes.dontAskDescription',
                icon: ShieldAlertIcon,
                dangerous: true
            }
        ]
    },
    openclaw: {
        defaultMode: DEFAULT_OPENCLAW_PERMISSION_MODE,
        requestField: 'openclawPermissionMode',
        storagePrefix: 'nca.chat.openclawPermissionMode.',
        isMode: isOpenclawPermissionMode,
        options: [
            {
                value: 'default',
                labelKey: 'web.composer.permission.openclaw.ask',
                titleKey: 'web.composer.permission.openclaw.askTitle',
                descriptionKey:
                    'web.composer.permission.openclaw.askDescription',
                icon: HandIcon
            },
            {
                value: 'dontAsk',
                labelKey: 'web.composer.permission.openclaw.dontAsk',
                titleKey: 'web.composer.permission.openclaw.dontAskTitle',
                descriptionKey:
                    'web.composer.permission.openclaw.dontAskDescription',
                icon: ShieldAlertIcon,
                dangerous: true
            }
        ]
    }
}

// The framework has a permission-mode selector.
export const permissionModeEntryFor = (
    framework: AgentFramework | null | undefined
): PermissionModeEntry | null =>
    (framework && permissionModesByFramework[framework]) || null

// Read the stored mode for an agent, falling back to the framework default.
export const readStoredPermissionMode = (
    entry: PermissionModeEntry,
    agentId: string
): string => {
    try {
        const raw = window.localStorage.getItem(
            `${entry.storagePrefix}${agentId}`
        )
        return entry.isMode(raw) ? (raw as string) : entry.defaultMode
    } catch {
        return entry.defaultMode
    }
}

export const writeStoredPermissionMode = (
    entry: PermissionModeEntry,
    agentId: string,
    mode: string
): void => {
    try {
        window.localStorage.setItem(`${entry.storagePrefix}${agentId}`, mode)
    } catch {
        /* ignore local storage failures */
    }
}

// The CreateMessageRequest fragment carrying the active mode on the field this
// framework reads — {} for a framework without a selector, or a null/undefined
// mode. The single cast is sound: a mode only reaches state through this table's
// isMode guard, so it always matches the field named by requestField.
export const permissionModeSendFields = (
    framework: AgentFramework | null | undefined,
    mode: ComposerPermissionMode | null | undefined
): Partial<Pick<CreateMessageRequest, PermissionRequestField>> => {
    const entry = permissionModeEntryFor(framework)
    if (!entry || !mode) return {}
    return { [entry.requestField]: mode } as Partial<
        Pick<CreateMessageRequest, PermissionRequestField>
    >
}

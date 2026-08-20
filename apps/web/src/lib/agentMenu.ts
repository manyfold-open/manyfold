import type { SdkAgent } from '@manyfold/sdk'
import type { TFn } from '@/lib/i18n'

// The agent `…` menu, which lives on the workspace sidebar row — the one place
// an agent's verbs are far enough away to be worth collapsing into a menu.
// (Inside the agent settings area every one of them already has a home on
// screen, so no menu is offered there.) Its job is to say what a click will
// *do* before it happens: an in-place dialog, entering this agent's own area,
// or leaving for somewhere else. That promise is encoded in the item's kind and
// rendered mechanically — callers never hand-write a label suffix.
export type AgentMenuItemKind =
    | 'dialog'
    | 'navigate'
    | 'navigate-away'
    | 'external'
    | 'danger'

export type AgentMenuSection = 'quick' | 'nav' | 'danger'

export type AgentMenuItemId =
    | 'rename'
    | 'model-provider'
    | 'agent-settings'
    | 'open-dashboard'
    | 'runtime'
    | 'delete'

export type AgentMenuTrailing = '→' | '↗'

export interface AgentMenuItem {
    id: AgentMenuItemId
    label: string
    trailing: AgentMenuTrailing | null
    kind: AgentMenuItemKind
    section: AgentMenuSection
    danger: boolean
    onSelect: () => void
    disabled: boolean
    disabledReason: string | null
}

export interface AgentMenuHandlers {
    onRename: () => void
    onModelProvider: () => void
    onAgentSettings: () => void
    // Null when this agent's framework has no dashboard to open — build it with
    // `agentDashboardOpener`, which owns that test.
    onOpenDashboard: (() => void) | null
    onOpenRuntime: (runtimeId: string) => void
    onDelete: () => void
}

export interface AgentMenuOptions {
    deleting?: boolean
    deletingLabel?: string
}

const sectionForKind = (kind: AgentMenuItemKind): AgentMenuSection => {
    if (kind === 'danger') return 'danger'
    if (kind === 'dialog') return 'quick'
    return 'nav'
}

// A dialog still needs input or a confirmation, so its label promises a second
// step. Arrows are a separate trailing glyph the menu right-aligns.
const decorate = (
    kind: AgentMenuItemKind,
    label: string
): { label: string; trailing: AgentMenuTrailing | null } => {
    if (kind === 'dialog' || kind === 'danger')
        return { label: `${label}…`, trailing: null }
    if (kind === 'navigate-away') return { label, trailing: '→' }
    if (kind === 'external') return { label, trailing: '↗' }
    return { label, trailing: null }
}

interface ItemSpec {
    id: AgentMenuItemId
    kind: AgentMenuItemKind
    label: string
    onSelect: () => void
    disabled?: boolean
    disabledReason?: string | null
}

const toItem = (spec: ItemSpec): AgentMenuItem => {
    const { label, trailing } = decorate(spec.kind, spec.label)
    return {
        id: spec.id,
        label,
        trailing,
        kind: spec.kind,
        section: sectionForKind(spec.kind),
        danger: spec.kind === 'danger',
        onSelect: spec.onSelect,
        disabled: spec.disabled ?? false,
        disabledReason: spec.disabledReason ?? null
    }
}

export const buildAgentMenuItems = (
    agent: SdkAgent,
    t: TFn,
    handlers: AgentMenuHandlers,
    options: AgentMenuOptions = {}
): AgentMenuItem[] => {
    const deleting = options.deleting ?? false
    const specs: Array<ItemSpec | null> = [
        {
            id: 'rename',
            kind: 'dialog',
            label: t('web.shell.rename'),
            onSelect: handlers.onRename
        },
        {
            id: 'model-provider',
            kind: 'dialog',
            label: t('web.shell.modelProvider'),
            onSelect: handlers.onModelProvider
        },
        {
            id: 'agent-settings',
            kind: 'navigate',
            label: t('web.shell.agentSettings'),
            onSelect: handlers.onAgentSettings
        },
        handlers.onOpenDashboard
            ? {
                  id: 'open-dashboard',
                  kind: 'external',
                  label: t('web.shell.openDashboard'),
                  onSelect: handlers.onOpenDashboard
              }
            : null,
        agent.runtimeId
            ? {
                  id: 'runtime',
                  kind: 'navigate-away',
                  label: t('web.shell.runtime'),
                  onSelect: () => handlers.onOpenRuntime(agent.runtimeId!)
              }
            : null,
        {
            id: 'delete',
            kind: 'danger',
            label: deleting
                ? (options.deletingLabel ??
                  t('web.agents.detail.delete.deleting'))
                : t('web.agents.detail.delete.agentAction'),
            onSelect: handlers.onDelete,
            disabled: deleting
        }
    ]
    return specs.filter((spec): spec is ItemSpec => spec !== null).map(toItem)
}

// Renderers walk the items once and insert a separator whenever the section
// changes, so grouping follows from the item list instead of being repeated at
// each call site.
export const isSectionBoundary = (
    items: AgentMenuItem[],
    index: number
): boolean => index > 0 && items[index - 1]!.section !== items[index]!.section

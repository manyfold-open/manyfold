import type { TFn } from '@/lib/i18n'

export type ToolInputDisplay =
    | 'one-line'
    | 'collapsible'
    | 'hidden'
    | 'todo-list'

export type ToolResultContent =
    | 'diff'
    | 'file-list'
    | 'todo-list'
    | 'text'
    | 'markdown'
    | 'terminal'
    | 'json'

export type ToolAction = 'open-file' | 'copy' | 'none'

export interface ToolDisplayConfig {
    icon: ToolIcon
    family?: 'claude-code' | 'codex' | 'gemini-cli' | 'shared'
    diff?: 'edit-pair' | 'multi-edit' | 'write-only' | 'unified-patch'
    input: {
        type: ToolInputDisplay
        getSummary?: (args: unknown, t: TFn) => string
        getSecondary?: (args: unknown) => string | undefined
        action?: ToolAction
        getFilePath?: (args: unknown) => string | undefined
        defaultOpen?: boolean
    }
    result?: {
        type: 'collapsible' | 'one-line' | 'hidden'
        contentType?: ToolResultContent
        hideOnSuccess?: boolean
        defaultOpen?: boolean
    }
}

export type ToolIcon =
    | 'read'
    | 'write'
    | 'edit'
    | 'terminal'
    | 'search'
    | 'glob'
    | 'task'
    | 'todo'
    | 'web'
    | 'plan'
    | 'tool'

const asString = (v: unknown): string =>
    typeof v === 'string' ? v : v == null ? '' : String(v)

const asObject = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const truncate = (s: string, n: number): string =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s

const getCommand = (args: unknown): string => {
    const o = asObject(args)
    return asString(o.command ?? o.cmd ?? o.shell ?? o.input)
}

const getFile = (args: unknown): string => {
    const o = asObject(args)
    return asString(
        o.file_path ?? o.path ?? o.filePath ?? o.notebook_path ?? ''
    )
}

const getPattern = (args: unknown): string => {
    const o = asObject(args)
    return asString(o.pattern ?? o.query ?? o.regex)
}

const getGlob = (args: unknown): string => {
    const o = asObject(args)
    return asString(o.glob ?? o.path ?? o.include)
}

const getUrl = (args: unknown): string => {
    const o = asObject(args)
    return asString(o.url ?? o.uri)
}

const config = (c: ToolDisplayConfig): ToolDisplayConfig => c

const READ: ToolDisplayConfig = config({
    icon: 'read',
    input: {
        type: 'one-line',
        action: 'open-file',
        getSummary: (a, t) => getFile(a) || t('web.chat.tools.read'),
        getFilePath: (a) => getFile(a) || undefined
    },
    result: { type: 'collapsible', contentType: 'text', hideOnSuccess: true }
})

const WRITE: ToolDisplayConfig = config({
    icon: 'write',
    diff: 'write-only',
    input: {
        type: 'collapsible',
        action: 'open-file',
        getSummary: (a, t) => getFile(a) || t('web.chat.tools.write'),
        getFilePath: (a) => getFile(a) || undefined,
        defaultOpen: false
    },
    result: { type: 'hidden' }
})

const EDIT: ToolDisplayConfig = config({
    icon: 'edit',
    diff: 'edit-pair',
    input: {
        type: 'collapsible',
        action: 'open-file',
        getSummary: (a, t) => getFile(a) || t('web.chat.tools.edit'),
        getFilePath: (a) => getFile(a) || undefined,
        defaultOpen: false
    },
    result: { type: 'hidden' }
})

const MULTI_EDIT: ToolDisplayConfig = config({
    icon: 'edit',
    diff: 'multi-edit',
    input: {
        type: 'collapsible',
        action: 'open-file',
        getSummary: (a, t) => {
            const file = getFile(a)
            const o = asObject(a)
            const edits = Array.isArray(o.edits) ? o.edits.length : 0
            const countLabel = t(
                edits === 1
                    ? 'web.chat.tools.editCount'
                    : 'web.chat.tools.editsCount',
                { count: edits }
            )
            return file ? `${file} · ${countLabel}` : countLabel
        },
        getFilePath: (a) => getFile(a) || undefined
    },
    result: { type: 'hidden' }
})

const BASH: ToolDisplayConfig = config({
    icon: 'terminal',
    input: {
        type: 'one-line',
        action: 'copy',
        getSummary: (a, t) =>
            truncate(getCommand(a) || t('web.chat.tools.bash'), 200)
    },
    result: {
        type: 'collapsible',
        contentType: 'terminal',
        hideOnSuccess: false
    }
})

const GREP: ToolDisplayConfig = config({
    icon: 'search',
    input: {
        type: 'one-line',
        getSummary: (a, t) => {
            const p = getPattern(a)
            const path = asString(asObject(a).path ?? asObject(a).glob ?? '')
            return path
                ? t('web.chat.tools.inPath', { pattern: p, path })
                : p || t('web.chat.tools.grep')
        }
    },
    result: {
        type: 'collapsible',
        contentType: 'file-list',
        hideOnSuccess: false
    }
})

const GLOB: ToolDisplayConfig = config({
    icon: 'glob',
    input: {
        type: 'one-line',
        getSummary: (a, t) => getGlob(a) || t('web.chat.tools.glob')
    },
    result: {
        type: 'collapsible',
        contentType: 'file-list',
        hideOnSuccess: false
    }
})

const TASK: ToolDisplayConfig = config({
    icon: 'task',
    input: {
        type: 'collapsible',
        getSummary: (a, t) => {
            const o = asObject(a)
            const summary = asString(o.description ?? o.task)
            if (summary) return summary
            const subagentType = asString(o.subagent_type)
            const prompt = asString(o.prompt)
            if (subagentType && prompt)
                return `${subagentType}: ${truncate(prompt, 160)}`
            return (
                subagentType ||
                truncate(prompt, 160) ||
                t('web.chat.tools.task')
            )
        }
    },
    result: {
        type: 'collapsible',
        contentType: 'markdown',
        hideOnSuccess: false
    }
})

const TODO_WRITE: ToolDisplayConfig = config({
    icon: 'todo',
    input: {
        type: 'todo-list',
        getSummary: (_, t) => t('web.chat.tools.todos')
    },
    result: { type: 'hidden' }
})

const WEB_FETCH: ToolDisplayConfig = config({
    icon: 'web',
    input: {
        type: 'one-line',
        getSummary: (a, t) => getUrl(a) || t('web.chat.tools.webFetch')
    },
    result: {
        type: 'collapsible',
        contentType: 'markdown',
        hideOnSuccess: false
    }
})

const WEB_SEARCH: ToolDisplayConfig = config({
    icon: 'web',
    input: {
        type: 'one-line',
        getSummary: (a, t) =>
            asString(asObject(a).query) || t('web.chat.tools.webSearch')
    },
    result: { type: 'collapsible', contentType: 'markdown' }
})

const NOTEBOOK_EDIT: ToolDisplayConfig = config({
    icon: 'edit',
    input: {
        type: 'collapsible',
        action: 'open-file',
        getSummary: (a, t) => getFile(a) || t('web.chat.tools.notebookEdit'),
        getFilePath: (a) => getFile(a) || undefined
    },
    result: { type: 'hidden' }
})

const APPLY_PATCH: ToolDisplayConfig = config({
    icon: 'edit',
    diff: 'unified-patch',
    family: 'codex',
    input: {
        type: 'collapsible',
        getSummary: (a, t) => {
            const o = asObject(a)
            const patch = asString(o.input ?? o.patch ?? '')
            const m = patch.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/m)
            return m
                ? `${m[1].toLowerCase()} ${m[2]}`
                : t('web.chat.tools.applyPatch')
        },
        defaultOpen: false
    },
    result: { type: 'hidden' }
})

const UPDATE_PLAN: ToolDisplayConfig = config({
    icon: 'plan',
    family: 'codex',
    input: {
        type: 'collapsible',
        getSummary: (_, t) => t('web.chat.tools.updatePlan')
    },
    result: { type: 'hidden' }
})

const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
    Read: READ,
    Write: WRITE,
    Edit: EDIT,
    MultiEdit: MULTI_EDIT,
    Bash: BASH,
    Grep: GREP,
    Glob: GLOB,
    Task: TASK,
    Agent: TASK,
    TodoWrite: TODO_WRITE,
    WebFetch: WEB_FETCH,
    WebSearch: WEB_SEARCH,
    NotebookEdit: NOTEBOOK_EDIT,

    shell: BASH,
    command_execution: BASH,
    apply_patch: APPLY_PATCH,
    update_plan: UPDATE_PLAN,

    read_file: READ,
    write_file: WRITE,
    edit: EDIT,
    replace: EDIT,
    run_shell_command: BASH,
    glob: GLOB,
    search_file_content: GREP
}

const FALLBACK: ToolDisplayConfig = {
    icon: 'tool',
    input: {
        type: 'collapsible',
        getSummary: (_, t) => t('web.chat.tools.toolCall')
    },
    result: { type: 'collapsible', contentType: 'json' }
}

export const getToolConfig = (toolName: string): ToolDisplayConfig =>
    TOOL_CONFIGS[toolName] ?? FALLBACK

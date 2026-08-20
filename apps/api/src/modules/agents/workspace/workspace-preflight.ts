import * as posix from 'node:path/posix'
import { BadRequestException } from '@nestjs/common'
import {
    execSprite,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import type { Agent } from '@manyfold/db'
import type { PodExec } from '@/modules/k8s/pod-exec'

const MAX_WORKSPACE_PATH_LENGTH = 1024

export interface WorkspaceSelection {
    path: string
    managed: boolean
}

export const normalizeWorkspacePathInput = (
    value: string | null | undefined
): string | null => {
    if (value === undefined || value === null) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    if (trimmed.includes('\0'))
        throw new BadRequestException('workspace path must not contain NUL')
    if (trimmed.length > MAX_WORKSPACE_PATH_LENGTH)
        throw new BadRequestException(
            `workspace path must be at most ${MAX_WORKSPACE_PATH_LENGTH} characters`
        )
    if (!trimmed.startsWith('/'))
        throw new BadRequestException('workspace path must be an absolute path')
    const normalized = posix.normalize(trimmed)
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

export const resolveWorkspaceSelection = (
    customWorkspace: string | null | undefined,
    defaultWorkspace: string
): WorkspaceSelection => {
    const normalized = normalizeWorkspacePathInput(customWorkspace)
    return normalized
        ? { path: normalized, managed: false }
        : { path: defaultWorkspace, managed: true }
}

export const workspaceExtras = (
    managed: boolean,
    extras: Record<string, unknown> = {}
): Record<string, unknown> => ({
    ...extras,
    workspaceManaged: managed
})

export const isAgentWorkspaceManaged = (
    agent: Pick<Agent, 'extras'>
): boolean => {
    const extras = agent.extras
    if (!extras || typeof extras !== 'object') return true
    return (extras as Record<string, unknown>).workspaceManaged !== false
}

export const isCustomWorkspace = (agent: Pick<Agent, 'extras'>): boolean =>
    !isAgentWorkspaceManaged(agent)

export const WORKSPACE_PREFLIGHT_USER_ERROR_PREFIXES = [
    'workspace directory does not exist:',
    'workspace path is not a directory:',
    'workspace directory is not readable:',
    'workspace directory is not writable:',
    'workspace directory is not enterable:'
] as const

export const isWorkspacePreflightUserError = (message: string): boolean =>
    WORKSPACE_PREFLIGHT_USER_ERROR_PREFIXES.some((prefix) =>
        message.includes(prefix)
    )

export const workspacePreflightScript = (workspacePath: string): string => {
    const q = shellQuote(workspacePath)
    return [
        'set -euo pipefail',
        `workspace=${q}`,
        'if [ ! -e "$workspace" ]; then echo "workspace directory does not exist: $workspace" >&2; exit 20; fi',
        'if [ ! -d "$workspace" ]; then echo "workspace path is not a directory: $workspace" >&2; exit 21; fi',
        'if [ ! -r "$workspace" ]; then echo "workspace directory is not readable: $workspace" >&2; exit 22; fi',
        'if [ ! -w "$workspace" ]; then echo "workspace directory is not writable: $workspace" >&2; exit 23; fi',
        'if [ ! -x "$workspace" ]; then echo "workspace directory is not enterable: $workspace" >&2; exit 24; fi',
        'cd "$workspace"',
        'tmp="$(mktemp "$workspace/.nca-workspace-check.XXXXXX")" || { echo "workspace directory is not writable: $workspace" >&2; exit 23; }',
        'rm -f "$tmp"',
        'printf "ok\\n"'
    ].join('\n')
}

export const assertWorkspaceProbeResult = (
    workspacePath: string,
    result: { exitCode: number; stdout?: string; stderr?: string }
): void => {
    if (result.exitCode === 0) return
    const message = (
        result.stderr ||
        result.stdout ||
        `workspace preflight failed with exit ${result.exitCode}`
    )
        .trim()
        .slice(0, 512)
    throw new BadRequestException(
        message || `workspace check failed: ${workspacePath}`
    )
}

export const assertWorkspaceUsableOnSprite = async (args: {
    client: SpritesClient
    spriteName: string
    workspacePath: string
    logger?: SpritesLogger
    timeoutMs?: number
}): Promise<void> => {
    const result = await execSprite(
        args.client,
        args.spriteName,
        {
            cmd: ['bash', '-lc', workspacePreflightScript(args.workspacePath)],
            stdin: '',
            timeoutMs: args.timeoutMs ?? 30_000
        },
        args.logger
    )
    assertWorkspaceProbeResult(args.workspacePath, result)
}

export const assertWorkspaceUsableWithPodExec = async (
    exec: PodExec,
    workspacePath: string,
    timeoutMs = 30_000
): Promise<void> => {
    const result = await exec.run({
        cmd: ['bash', '-lc', workspacePreflightScript(workspacePath)],
        timeoutMs
    })
    assertWorkspaceProbeResult(workspacePath, result)
}

interface WorkspaceProbeExec {
    run(args: {
        cmd: string[]
        timeoutMs: number
    }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export const assertWorkspaceUsableWithFrameworkExec = async (
    exec: WorkspaceProbeExec,
    workspacePath: string,
    timeoutMs = 30_000
): Promise<void> => {
    const result = await exec.run({
        cmd: ['bash', '-lc', workspacePreflightScript(workspacePath)],
        timeoutMs
    })
    assertWorkspaceProbeResult(workspacePath, result)
}

export const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

import type { AgentFramework } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import { sanitizeMessage } from '@/modules/agents/agents.controller'
import { openclawDefaultWorkspace } from '@/modules/agents/bootstrap/openclaw'
import {
    assertWorkspaceUsableWithFrameworkExec,
    normalizeWorkspacePathInput
} from '@/modules/agents/workspace/workspace-preflight'
import { FrameworkExecResolver } from './framework-exec'
import type {
    AddAgentContext,
    AddAgentResult,
    AgentAdapter,
    AgentAdapterContext,
    AgentAdapterCreateResult,
    AgentAdapterListContext,
    FrameworkAgent,
    RemoveAgentContext
} from './agent-adapter'

const OPENCLAW_PRIMARY_INTERNAL_ID = 'main'

const EXEC_TIMEOUT_MS = 30_000

interface RawOpenclawAgent {
    id?: string
    workspace?: string | null
    model?: string | null
    identity?: {
        name?: string | null
        emoji?: string | null
        theme?: string | null
        avatar?: string | null
    } | null
    skills?: unknown
    bindings?: unknown
}

@Injectable()
export class OpenclawAgentAdapter implements AgentAdapter {
    readonly framework: AgentFramework = 'openclaw'
    private readonly log = new Logger(OpenclawAgentAdapter.name)

    constructor(private readonly execResolver: FrameworkExecResolver) {}

    async createAgent(
        ctx: AgentAdapterContext
    ): Promise<AgentAdapterCreateResult> {
        return {
            workspacePath: `${ctx.runtime.mountPath}/${ctx.agentId}`
        }
    }

    async deleteAgent(): Promise<void> {}

    async listAgents(ctx: AgentAdapterListContext): Promise<FrameworkAgent[]> {
        const { runtime, primaryAgentId } = ctx
        const exec = await this.execResolver.forRuntime(
            runtime,
            primaryAgentId,
            this.log
        )
        const res = await exec.run({
            cmd: ['openclaw', 'agents', 'list', '--json'],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        if (res.exitCode !== 0)
            throw new Error(
                `openclaw agents list failed (exit ${res.exitCode}) for runtime ${runtime.id}: ${sanitizeMessage(new Error(res.stderr || res.stdout))}`
            )
        return parseOpenclawAgents(res.stdout, runtime.mountPath)
    }

    async addAgent(ctx: AddAgentContext): Promise<AddAgentResult> {
        const { runtime, primaryAgentId, internalId, workspace, model } = ctx
        const exec = await this.execResolver.forRuntime(
            runtime,
            primaryAgentId,
            this.log
        )
        const normalizedWorkspace = normalizeWorkspacePathInput(workspace)
        if (normalizedWorkspace)
            await assertWorkspaceUsableWithFrameworkExec(
                exec,
                normalizedWorkspace
            )
        // Seen on a daemon runtime [2026-08-20]: openclaw 2026.7.x `agents add`
        // prompts for the workspace when the flag is absent (exit 13 on a
        // non-TTY exec) and rejects a directory that does not exist. The add
        // therefore always carries --workspace; when the caller picked none, a
        // managed default in the framework's own workspace-<id> shape is
        // created first. A caller-chosen path is only asserted usable, never
        // created — a typo must fail loudly, not manufacture a directory.
        const agentWorkspace =
            normalizedWorkspace ??
            openclawDefaultWorkspace(runtime.mountPath, internalId)
        if (!normalizedWorkspace) {
            const mkdir = await exec.run({
                cmd: ['mkdir', '-p', agentWorkspace],
                timeoutMs: EXEC_TIMEOUT_MS
            })
            if (mkdir.exitCode !== 0)
                throw new Error(
                    `openclaw agents add: creating default workspace ${agentWorkspace} failed (exit ${mkdir.exitCode}): ${sanitizeMessage(new Error(mkdir.stderr || mkdir.stdout))}`
                )
        }
        const cmd = [
            'openclaw',
            'agents',
            'add',
            internalId,
            '--workspace',
            agentWorkspace
        ]
        if (model) cmd.push('--model', model)
        cmd.push('--json')
        const add = await exec.run({ cmd, timeoutMs: EXEC_TIMEOUT_MS })
        if (add.exitCode !== 0)
            throw new Error(
                `openclaw agents add failed (exit ${add.exitCode}): ${sanitizeMessage(new Error(add.stderr || add.stdout))}`
            )

        const parsedAdd = tryParseSingleOpenclawAgent(add.stdout)
        if (parsedAdd) return toAddAgentResult(parsedAdd, internalId)

        const list = await exec.run({
            cmd: ['openclaw', 'agents', 'list', '--json'],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        if (list.exitCode !== 0)
            throw new Error(
                `openclaw agents list (post-add) failed (exit ${list.exitCode}): ${sanitizeMessage(new Error(list.stderr || list.stdout))}`
            )
        const all = parseOpenclawAgents(list.stdout, runtime.mountPath)
        const found = all.find((a) => a.id === internalId)
        if (!found)
            throw new Error(
                `openclaw agents add: new agent '${internalId}' not present in subsequent list`
            )
        return {
            internalId: found.id,
            workspace: found.workspace,
            model: found.model,
            extras: found.extras
        }
    }

    async removeAgent(ctx: RemoveAgentContext): Promise<void> {
        const { runtime, agent, primaryAgentId } = ctx
        const exec = await this.execResolver.forRuntime(
            runtime,
            primaryAgentId,
            this.log
        )
        const res = await exec.run({
            cmd: [
                'openclaw',
                'agents',
                'delete',
                agent.internalId,
                '--force'
            ],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        if (res.exitCode === 0) return
        const msg = (res.stderr || res.stdout).toLowerCase()
        if (msg.includes('not found') || msg.includes('no such')) return
        throw new Error(
            `openclaw agents delete failed (exit ${res.exitCode}): ${sanitizeMessage(new Error(res.stderr || res.stdout))}`
        )
    }
}

const tryParseSingleOpenclawAgent = (
    stdout: string
): RawOpenclawAgent | null => {
    const trimmed = stdout.trim()
    if (!trimmed) return null
    try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) return null
        if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>
            if (typeof obj.id === 'string') return obj as RawOpenclawAgent
            const inner = obj.agent
            if (inner && typeof inner === 'object')
                return inner as RawOpenclawAgent
        }
    } catch {
        return null
    }
    return null
}

const toAddAgentResult = (
    raw: RawOpenclawAgent,
    fallbackId: string
): AddAgentResult => ({
    internalId: raw.id ?? fallbackId,
    workspace: raw.workspace ?? null,
    model: raw.model ?? null,
    extras: {
        identity: raw.identity ?? null,
        skills: raw.skills ?? null,
        bindings: raw.bindings ?? null
    }
})

const parseOpenclawAgents = (
    stdout: string,
    mountPath: string
): FrameworkAgent[] => {
    const trimmed = stdout.trim()
    if (!trimmed) throw new Error('openclaw agents list: empty output')
    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch (err) {
        throw new Error(
            `openclaw agents list: invalid JSON (${(err as Error).message})`
        )
    }
    const raw = extractOpenclawList(parsed)
    return raw.map((r) => toFrameworkAgent(r, mountPath))
}

const extractOpenclawList = (parsed: unknown): RawOpenclawAgent[] => {
    if (Array.isArray(parsed)) return parsed as RawOpenclawAgent[]
    if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        if (Array.isArray(obj.agents)) return obj.agents as RawOpenclawAgent[]
        const nestedList = (obj.agents as Record<string, unknown> | undefined)
            ?.list
        if (Array.isArray(nestedList)) return nestedList as RawOpenclawAgent[]
    }
    throw new Error('openclaw agents list: unexpected JSON shape')
}

const toFrameworkAgent = (
    r: RawOpenclawAgent,
    mountPath: string
): FrameworkAgent => {
    const id = r.id ?? ''
    const displayName = r.identity?.name ?? id
    const workspace =
        r.workspace ??
        (id === OPENCLAW_PRIMARY_INTERNAL_ID
            ? openclawDefaultWorkspace(mountPath)
            : null)
    return {
        id,
        name: displayName,
        workspace,
        model: r.model ?? null,
        extras: {
            identity: r.identity ?? null,
            skills: r.skills ?? null,
            bindings: r.bindings ?? null
        }
    }
}

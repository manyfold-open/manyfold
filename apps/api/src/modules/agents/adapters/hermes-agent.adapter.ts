import {
    AgentFramework,
    K8S_HOME_BASE
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import { sanitizeMessage } from '@/modules/agents/agents.controller'
import {
    FrameworkExecResolver,
    type FrameworkExec
} from './framework-exec'
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

const EXEC_TIMEOUT_MS = 30_000
const DEFAULT_HERMES_HOME = `${K8S_HOME_BASE}/.hermes`
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const hermesHomeFor = (runtime: AgentRuntimeRow): string => {
    if (runtime.kind === 'daemon' && runtime.homeDir)
        return `${runtime.homeDir}/.hermes`
    // Sprite bootstraps persist the full HERMES_HOME as homeDir; mountPath is
    // the workspace and diverges from it on custom-workspace runtimes.
    if (runtime.kind === 'sprites' && runtime.homeDir) return runtime.homeDir
    return runtime.mountPath || DEFAULT_HERMES_HOME
}

const PROFILE_LIST_PY = `import json
from hermes_cli.profiles import list_profiles, get_active_profile_name
active = get_active_profile_name()
print(json.dumps([{
    "name": p.name,
    "path": str(p.path),
    "is_default": p.is_default,
    "gateway_running": p.gateway_running,
    "model": p.model,
    "provider": p.provider,
    "has_env": p.has_env,
    "skill_count": p.skill_count,
    "alias_path": str(p.alias_path) if p.alias_path else None,
    "active": p.name == active,
} for p in list_profiles()]))
`

interface PythonProfile {
    name: string
    path: string
    is_default: boolean
    gateway_running: boolean
    model: string | null
    provider: string | null
    has_env: boolean
    skill_count: number
    alias_path: string | null
    active: boolean
}

@Injectable()
export class HermesAgentAdapter implements AgentAdapter {
    readonly framework: AgentFramework = 'hermes'
    private readonly log = new Logger(HermesAgentAdapter.name)

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
        const profiles = await tryPythonList(exec, hermesHomeFor(runtime))
        if (!profiles)
            throw new Error(
                `hermes profile discovery failed for runtime ${runtime.id}; filesystem fallback is not trustworthy for reconcile`
            )
        return profiles
    }

    async addAgent(ctx: AddAgentContext): Promise<AddAgentResult> {
        const { runtime, primaryAgentId, internalId, cloneFrom } = ctx
        const exec = await this.execResolver.forRuntime(
            runtime,
            primaryAgentId,
            this.log
        )
        const cmd = ['hermes', 'profile', 'create', internalId]
        if (cloneFrom) cmd.push('--clone', '--clone-from', cloneFrom)
        const create = await exec.run({ cmd, timeoutMs: EXEC_TIMEOUT_MS })
        if (create.exitCode !== 0)
            throw new Error(
                `hermes profile create failed (exit ${create.exitCode}): ${sanitizeMessage(new Error(create.stderr || create.stdout))}`
            )

        const home = hermesHomeFor(runtime)
        const all = await this.discoverProfiles(exec, home)
        const found = all.find((a) => a.id === internalId)
        return {
            internalId,
            workspace:
                found?.workspace ?? `${home}/profiles/${internalId}`,
            model: found?.model ?? null,
            extras: found?.extras ?? {}
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
            cmd: ['hermes', 'profile', 'delete', agent.internalId, '-y'],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        if (res.exitCode === 0) return
        const msg = (res.stderr || res.stdout).toLowerCase()
        if (msg.includes('not found') || msg.includes('no such')) return
        throw new Error(
            `hermes profile delete failed (exit ${res.exitCode}): ${sanitizeMessage(new Error(res.stderr || res.stdout))}`
        )
    }

    private async discoverProfiles(
        exec: FrameworkExec,
        hermesHome: string
    ): Promise<FrameworkAgent[]> {
        const python = await tryPythonList(exec, hermesHome)
        if (python) return python
        this.log.warn(
            'hermes python profile discovery failed, falling back to filesystem scan'
        )
        return tryFilesystemList(exec, hermesHome || DEFAULT_HERMES_HOME)
    }
}

const hermesPythonCandidates = (hermesHome: string): string[] => {
    const base = hermesHome.replace(/\/+$/, '')
    return [
        `${base}/hermes-agent/venv/bin/python3`,
        `${base}/hermes-agent/venv/bin/python`,
        '/opt/hermes/hermes-agent/.venv/bin/python3',
        '/opt/hermes/hermes-agent/.venv/bin/python',
        'python3',
        'python'
    ]
}

const tryPythonList = async (
    exec: FrameworkExec,
    hermesHome: string
): Promise<FrameworkAgent[] | null> => {
    for (const binary of hermesPythonCandidates(hermesHome)) {
        let res
        try {
            res = await exec.run({
                cmd: [binary, '-c', PROFILE_LIST_PY],
                timeoutMs: EXEC_TIMEOUT_MS
            })
        } catch {
            continue
        }
        if (res.exitCode !== 0) continue
        const trimmed = res.stdout.trim()
        // the discovery script always prints a JSON array, so empty stdout means output was swallowed, not zero profiles
        if (!trimmed) continue
        try {
            const parsed: unknown = JSON.parse(trimmed)
            if (!Array.isArray(parsed)) return null
            return parsed.map(pythonProfileToFrameworkAgent)
        } catch {
            return null
        }
    }
    return null
}

const pythonProfileToFrameworkAgent = (raw: unknown): FrameworkAgent => {
    const p = raw as Partial<PythonProfile>
    const name = p.name ?? ''
    return {
        id: name,
        name,
        workspace: p.path ?? null,
        model: p.model ?? null,
        extras: {
            provider: p.provider ?? null,
            gatewayRunning: p.gateway_running ?? null,
            hasEnv: p.has_env ?? null,
            skillCount: p.skill_count ?? null,
            isDefault: p.is_default ?? null,
            aliasPath: p.alias_path ?? null,
            active: p.active ?? null
        }
    }
}

const tryFilesystemList = async (
    exec: FrameworkExec,
    mountPath: string
): Promise<FrameworkAgent[]> => {
    const res = await exec.run({
        cmd: ['sh', '-c', `ls -1 "${mountPath}/profiles" 2>/dev/null || true`],
        timeoutMs: EXEC_TIMEOUT_MS
    })
    const named = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((n) => PROFILE_ID_RE.test(n))
    const out: FrameworkAgent[] = [
        {
            id: 'default',
            name: 'default',
            workspace: mountPath,
            model: null,
            extras: {
                provider: null,
                gatewayRunning: null,
                hasEnv: null,
                skillCount: null,
                isDefault: true,
                aliasPath: null,
                active: null
            }
        }
    ]
    for (const n of named) {
        out.push({
            id: n,
            name: n,
            workspace: `${mountPath}/profiles/${n}`,
            model: null,
            extras: {
                provider: null,
                gatewayRunning: null,
                hasEnv: null,
                skillCount: null,
                isDefault: false,
                aliasPath: null,
                active: null
            }
        })
    }
    return out
}

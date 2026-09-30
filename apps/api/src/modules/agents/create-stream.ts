import {
    AGENT_CREATE_REQUEST_HEADER,
    runtimePlacements,
    stepsFor,
    type AgentCreateEvent,
    type AgentCreateStep,
    type AgentSummary,
    type RuntimePlacement
} from '@manyfold/shared'
import type { Logger } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import type { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import {
    classifyError,
    errorEventFields,
    sanitizeMessage
} from '@/modules/agents/failure-report'
import {
    resolveRuntime,
    type AgentProgressEmitter
} from '@/modules/agents/orchestration/agent-orchestrator.service'
import type { UsersService } from '@/modules/users/users.service'

// The NDJSON variant of agent create, shared by /agents and /admin/agents:
// 201 up front, then `step` events, then one `complete` or `error`.

export interface CreateStreamPlan {
    runtime: RuntimePlacement
    steps: AgentCreateStep[]
}

// Where the create will run and which steps it reports, worked out before the
// reply is hijacked: anything thrown here still reaches the exception filter
// as an ordinary HTTP error, where after hijack() it would get no response at
// all. Same routing as AgentOrchestratorService.create.
export const resolveCreateStreamPlan = async (
    deps: { adminSettings: AdminSettingsService; users: UsersService },
    ownerUserId: string,
    dto: CreateAgentDto
): Promise<CreateStreamPlan> => {
    if (dto.runtimeId)
        return {
            runtime: runtimePlacements.K8S,
            steps: stepsFor(dto.framework, runtimePlacements.K8S)
        }
    const [defaults, userOverrides] = await Promise.all([
        deps.adminSettings.getCachedFrameworkRuntimeDefaults(),
        deps.users.getFrameworkRuntimeOverrides(ownerUserId)
    ])
    const runtime = resolveRuntime(
        dto.framework,
        dto.runtime,
        defaults,
        userOverrides
    )
    return { runtime, steps: stepsFor(dto.framework, runtime) }
}

// The request id a client sends back to resume a create; a header repeated
// with several values names no one request.
export const headerValue = (
    value: string | string[] | undefined
): string | undefined =>
    typeof value === 'string' && value ? value : undefined

// Long steps (a VM boot, a framework install) send nothing for a minute or
// more; a blank line keeps proxies and client idle timers from cutting the
// stream. NDJSON readers skip it.
const KEEPALIVE_MS = 15_000

export const streamAgentCreate = async (args: {
    res: FastifyReply
    framework: string
    plan: CreateStreamPlan
    log: Logger
    requestId?: string
    resumed?: boolean
    run: (emitter: AgentProgressEmitter) => Promise<AgentSummary>
}): Promise<void> => {
    const { res, plan, log } = args
    res.hijack()
    // Fail loud: if the orchestrator emits a step that stepsFor() doesn't
    // cover (e.g. a new framework added without updating spritesServiceSteps),
    // raw indexOf returns -1 and the UI treats it as "before any step" — wipes
    // the progress bar. Log it and fall back to `lastIndex` so the UI keeps
    // its last position instead of resetting.
    let lastIndex = -1
    const indexOf = (s: AgentCreateStep): number => {
        const idx = plan.steps.indexOf(s)
        if (idx === -1) {
            log.warn(
                `progress step "${s}" not in stepsFor(${args.framework}, ${plan.runtime}); UI progress would reset — using fallback index ${lastIndex}`
            )
            return Math.max(lastIndex, 0)
        }
        lastIndex = idx
        return idx
    }
    res.raw.writeHead(201, {
        ...corsHeadersForOrigin(res.request.headers),
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        ...(args.requestId
            ? { [AGENT_CREATE_REQUEST_HEADER]: args.requestId }
            : {})
    })
    const write = (ev: AgentCreateEvent): void => {
        res.raw.write(JSON.stringify(ev) + '\n')
    }
    const keepalive = setInterval(() => res.raw.write('\n'), KEEPALIVE_MS)
    keepalive.unref?.()

    let lastStep: AgentCreateStep | null = null
    const emitter: AgentProgressEmitter = {
        step: (s): void => {
            lastStep = s
            write({
                type: 'step',
                step: s,
                index: indexOf(s),
                total: plan.steps.length,
                startedAt: new Date().toISOString()
            })
        }
    }

    try {
        const agent = await args.run(emitter)
        write(
            args.resumed
                ? { type: 'complete', agent, resumed: true }
                : { type: 'complete', agent }
        )
    } catch (err) {
        write({
            type: 'error',
            step: lastStep,
            errorClass: classifyError(err),
            message: sanitizeMessage(err),
            ...errorEventFields(err)
        })
    } finally {
        clearInterval(keepalive)
        res.raw.end()
    }
}

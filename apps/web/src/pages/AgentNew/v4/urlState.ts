import type { AgentFramework } from '@manyfold/shared'
import { CREATE_STEP_ORDER } from '@/pages/AgentNew/v4/flowState'
import type { CreateStepId } from '@/pages/AgentNew/v4/flowState'

// The flow's place and answers, kept in the address bar. This is not a draft
// (decision D still keeps none): it is what lets the browser's Back go to the
// previous step instead of out of the flow, lets a reload land where the user
// was, and lets a link open the flow with a type or a machine already chosen.
// Seen on staging [2026-10-08]: Back left /agents/new altogether, a reload
// started again at step ①, and "+ Create agent" next to a connected computer
// (`?hostId=`) opened the flow with nothing chosen although the docs promise
// that computer preselected.
//
// Only answers that can be checked against what exists are kept: the type,
// the machine (by its host id) or the connected service, and Langflow's flow.
// The payer and the name are asked again; they take a click each.
export interface UrlAnswers {
    step: CreateStepId
    framework: AgentFramework | null
    host: string | null
    service: string | null
    ref: string
}

const isStep = (value: string | null): value is CreateStepId =>
    value !== null && (CREATE_STEP_ORDER as readonly string[]).includes(value)

export const readUrl = (
    params: URLSearchParams,
    isKnownFramework: (value: string) => boolean
): UrlAnswers => {
    const framework = params.get('framework')
    const step = params.get('step')
    return {
        step: isStep(step) ? step : 'type',
        framework:
            framework !== null && isKnownFramework(framework)
                ? framework
                : null,
        // `hostId` is what "+ Create agent" on a connected computer sends.
        host: params.get('host') ?? params.get('hostId'),
        service: params.get('service'),
        ref: params.get('ref') ?? ''
    }
}

export const writeUrl = (answers: UrlAnswers): URLSearchParams => {
    const params = new URLSearchParams()
    if (answers.step !== 'type') params.set('step', answers.step)
    if (answers.framework !== null) params.set('framework', answers.framework)
    if (answers.host !== null) params.set('host', answers.host)
    if (answers.service !== null) params.set('service', answers.service)
    if (answers.ref !== '') params.set('ref', answers.ref)
    return params
}

// Where the flow can stand given the answers it holds: a step whose
// predecessors are all answered. Back and Forward land only on those.
export const furthestStep = (answered: ReadonlySet<CreateStepId>): CreateStepId => {
    let furthest: CreateStepId = 'type'
    for (const step of CREATE_STEP_ORDER) {
        furthest = step
        if (!answered.has(step)) break
    }
    return furthest
}

export const canStandOn = (
    step: CreateStepId,
    answered: ReadonlySet<CreateStepId>
): boolean =>
    CREATE_STEP_ORDER.indexOf(step) <=
    CREATE_STEP_ORDER.indexOf(furthestStep(answered))

const HOST_KEY_PREFIX = 'host:'

// Machine rows are keyed `host:<id>` (ADR-0037); the address bar carries the
// bare id, which is what other pages link with.
export const hostIdOfRow = (rowId: string | null): string | null =>
    rowId !== null && rowId.startsWith(HOST_KEY_PREFIX)
        ? rowId.slice(HOST_KEY_PREFIX.length)
        : null

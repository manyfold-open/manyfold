import type { AgentFramework, AgentRuntime } from '@manyfold/shared'
import { workspaceValidationMessage } from '@/lib/agentCreateDraft'

export const CREATE_STEP_ORDER = ['type', 'runtime', 'cost', 'name'] as const

export type CreateStepId = (typeof CREATE_STEP_ORDER)[number]

// Where the agent will run. By the time step ② is left this is always a
// resource that EXISTS — a runtime row, or a connected service plus the app on
// it. Nothing is held as an intent to be executed later: building the sandbox,
// installing the CLI and signing in all happen inside the step that offers
// them (decision E), which is what lets the flow keep no progress at all
// (decision D) — leave halfway and the machine, the CLI and the sign-in are
// all still there next time, as ordinary options in these same lists.
//
// One named exception: a service framework such as OpenClaw or Hermes is
// not installed at step ② but at step ④, together with the agent — see
// `installsAtCreate`. Then `runtimeId` is null and `sandboxId` says where the
// install will land. The machine itself still exists; only the CLI waits.
export type RuntimeChoice =
    | {
          kind: 'runtime'
          runtimeId: string | null
          sandboxId: string | null
          hostKind: AgentRuntime
          hostLabel: string
          // Only a daemon host makes the workspace a real question, so only it
          // turns step ④'s workspace line into an input.
          ownComputer: boolean
      }
    | {
          kind: 'external'
          providerId: string
          providerLabel: string
          remoteRef: string
          remoteLabel: string
      }

// Who pays for the model. The three groups in step ③ differ by SCOPE, which is
// why they are grouped rather than listed flat: a vendor sign-in is written to
// one machine's disk, an account-level balance follows the user everywhere.
//
// For a service framework installed at create time, `platform` and `provider`
// also carry WHICH provider row and WHICH model the install will be given:
// the managed family is several channels, the API needs a concrete one plus
// a model name, and both are decided by the same rules the API applies
// (`serviceModel.ts`) so what step ④ shows is what the request sends.
export type CostChoice =
    | { kind: 'runtime-local'; profileId: string; label: string }
    | { kind: 'platform'; providerId?: string; model?: string }
    | { kind: 'provider'; providerId: string; label: string; model?: string }
    // Dify / Langflow / A2A call and bill the model on the user's own service.
    // The step still appears with nothing to pick, so the flow is identical
    // for all nine types and nobody has to learn "this kind has three steps".
    | { kind: 'external' }

export interface CreateFlowState {
    step: CreateStepId
    framework: AgentFramework | null
    runtime: RuntimeChoice | null
    cost: CostChoice | null
    name: string
    workspace: string
}

// Nothing is preselected, ever — not the type, not the machine, not the
// billing. A preselected row reads as a decision already made, so the user
// clicks past it and never sees the group below it ("New machine"). It also
// keeps every run of the flow identical: being a returning user earns you
// shorter lists, not fewer steps.
export const initialFlowState = (): CreateFlowState => ({
    step: 'type',
    framework: null,
    runtime: null,
    cost: null,
    name: '',
    workspace: ''
})

export const stepIndex = (step: CreateStepId): number =>
    CREATE_STEP_ORDER.indexOf(step)

export const nextStep = (step: CreateStepId): CreateStepId =>
    CREATE_STEP_ORDER[Math.min(stepIndex(step) + 1, CREATE_STEP_ORDER.length - 1)]

export const previousStep = (step: CreateStepId): CreateStepId =>
    CREATE_STEP_ORDER[Math.max(stepIndex(step) - 1, 0)]

// The i18n key naming what the step is still waiting for, or null when it can
// be left. Shown beside the disabled Next button: a control that refuses to
// move should say what it wants.
export const advanceBlockedKey = (state: CreateFlowState): string | null => {
    if (state.step === 'type')
        return state.framework === null
            ? 'web.agentNewV4.blocked.type'
            : null
    if (state.step === 'runtime')
        return state.runtime === null
            ? 'web.agentNewV4.blocked.runtime'
            : null
    if (state.step === 'cost')
        return state.cost === null ? 'web.agentNewV4.blocked.cost' : null
    if (state.name.trim() === '') return 'web.agentNewV4.blocked.name'
    // Absolute or empty. The API rejects anything else, and this is the last
    // step, so without the check the rejection lands after the agent already
    // has a name — a format error reported as a failed creation.
    return workspaceValidationMessage(state.workspace) === null
        ? null
        : 'web.agentNewV4.blocked.workspace'
}

// Changing the type invalidates everything downstream, because step ② asks a
// different question for a connected service than for a machine, and step ③'s
// groups depend on the machine chosen in ②. Resources already created are NOT
// undone — they stay as options in the lists.
export const withFramework = (
    state: CreateFlowState,
    framework: AgentFramework
): CreateFlowState =>
    state.framework === framework
        ? state
        : { ...state, framework, runtime: null, cost: null }

export const withRuntime = (
    state: CreateFlowState,
    runtime: RuntimeChoice
): CreateFlowState => ({ ...state, runtime, cost: null })

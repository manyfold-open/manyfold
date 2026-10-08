import type { AgentFramework, RuntimePlacement } from '@manyfold/shared'
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
          // A cloud computer a service framework installs onto at create.
          podHostId?: string
          hostKind: RuntimePlacement
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
    | { kind: 'external' }
    // Whatever the machine already pays with, kept as it is. An agent joining
    // a runtime shares that runtime's credential, so for a coding CLI this is
    // the one account-level answer that leaves the agents already there
    // alone; for a service framework joining an instance it is the only
    // answer there is. `label` names the payer once it has been read.
    | { kind: 'inherited'; label: string | null; machine: string }
    // A framework that is given its models in its own settings, after it
    // exists, and takes none from us at create.
    | { kind: 'runtime-ui' }

export interface CreateFlowState {
    step: CreateStepId
    framework: AgentFramework | null
    runtime: RuntimeChoice | null
    cost: CostChoice | null
    name: string
    // Whether `name` is one the flow made up rather than one the user typed.
    // A made-up name is a suggestion for the agent these answers describe;
    // once those answers are gone it goes too, and a fresh one is offered
    // when step ④ is reached again. A typed name is never discarded.
    nameAuto: boolean
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
    nameAuto: false,
    workspace: ''
})

export const stepIndex = (step: CreateStepId): number =>
    CREATE_STEP_ORDER.indexOf(step)

export const nextStep = (step: CreateStepId): CreateStepId =>
    CREATE_STEP_ORDER[Math.min(stepIndex(step) + 1, CREATE_STEP_ORDER.length - 1)]

export const previousStep = (step: CreateStepId): CreateStepId =>
    CREATE_STEP_ORDER[Math.max(stepIndex(step) - 1, 0)]

// The steps that are answered, counting a step only while every step before
// it is answered too. This is what the bar may offer as a way back: an answer
// that outlived the one it depended on — a cost kept after the type changed —
// is not one. Derived rather than remembered, because a remembered "visited"
// set kept step ④ pressable after a type change emptied ② and ③.
// Seen on staging [2026-10-08]: Claude Code to step ④, back to ①, Hermes,
// then the bar's "Name" — a Create button over an empty summary, and pressing
// it did nothing at all.
export const answeredSteps = (state: CreateFlowState): Set<CreateStepId> => {
    const answered = new Set<CreateStepId>()
    if (state.framework === null) return answered
    answered.add('type')
    if (state.runtime === null) return answered
    answered.add('runtime')
    if (state.cost === null) return answered
    answered.add('cost')
    if (state.name.trim() !== '') answered.add('name')
    return answered
}

const firstUnansweredKey = (state: CreateFlowState): string | null =>
    state.framework === null
        ? 'web.agentNewV4.blocked.type'
        : state.runtime === null
          ? 'web.agentNewV4.blocked.runtime'
          : state.cost === null
            ? 'web.agentNewV4.blocked.cost'
            : null

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
    // The last step creates, so everything before it has to hold, not only
    // its own two fields.
    const earlier = firstUnansweredKey(state)
    if (earlier !== null) return earlier
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
// A made-up name outlives nothing it was made up for: when the answers that
// lead to step ④ are no longer all there, it is dropped.
const dropStaleAutoName = (state: CreateFlowState): CreateFlowState =>
    state.nameAuto && state.cost === null
        ? { ...state, name: '', nameAuto: false }
        : state

export const withFramework = (
    state: CreateFlowState,
    framework: AgentFramework
): CreateFlowState =>
    state.framework === framework
        ? state
        : dropStaleAutoName({ ...state, framework, runtime: null, cost: null })

// Step ④ is being reached: suggest a name if there is none.
export const withSuggestedName = (
    state: CreateFlowState,
    suggest: () => string
): CreateFlowState =>
    state.name.trim() === ''
        ? { ...state, name: suggest(), nameAuto: true }
        : state

// What the user typed, which is theirs from then on — clearing the field
// included, so an emptied field is not refilled behind their back.
export const withTypedName = (
    state: CreateFlowState,
    name: string
): CreateFlowState => ({ ...state, name, nameAuto: false })

// The same machine (or the same app on the same service) picked again. Going
// back to step ② and leaving it on the row already chosen is not a change, and
// must not cost the answer step ③ already has.
export const sameRuntime = (
    a: RuntimeChoice | null,
    b: RuntimeChoice | null
): boolean => {
    if (a === null || b === null) return false
    if (a.kind === 'external' || b.kind === 'external')
        return (
            a.kind === 'external' &&
            b.kind === 'external' &&
            a.providerId === b.providerId &&
            a.remoteRef === b.remoteRef
        )
    return (
        a.runtimeId === b.runtimeId &&
        a.sandboxId === b.sandboxId &&
        a.podHostId === b.podHostId
    )
}

export const withRuntime = (
    state: CreateFlowState,
    runtime: RuntimeChoice
): CreateFlowState =>
    dropStaleAutoName({
        ...state,
        runtime,
        cost: sameRuntime(state.runtime, runtime) ? state.cost : null
    })

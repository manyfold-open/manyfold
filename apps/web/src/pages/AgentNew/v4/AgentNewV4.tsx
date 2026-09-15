import type { AgentFramework, UserExternalAgentProviderSummary } from '@manyfold/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FC, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { randomAgentName } from '@/lib/agentCreate/agentName'
import { useApiClient } from '@/lib/apiClient'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'
import { useAgentCreate } from '@/lib/agentCreate/useAgentCreate'
import { useManagedCreditGate } from '@/lib/managedCreditGate'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'
import { StepShell } from '@/pages/AgentNew/v4/components/StepShell'
import type { StepPrimary } from '@/pages/AgentNew/v4/components/StepShell'
import type { StepValues } from '@/pages/AgentNew/v4/components/StepBar'
import {
    advanceBlockedKey,
    initialFlowState,
    nextStep,
    previousStep,
    withFramework,
    withRuntime
} from '@/pages/AgentNew/v4/flowState'
import type {
    CostChoice,
    CreateFlowState,
    CreateStepId,
    RuntimeChoice
} from '@/pages/AgentNew/v4/flowState'
import { runsOnOurMachine } from '@/pages/AgentNew/v4/frameworkCatalog'
import { vendorLabel } from '@/pages/AgentNew/v4/vendorLabel'
import {
    buildMachineOptions,
    buildNewMachineOptions
} from '@/pages/AgentNew/v4/machineOptions'
import type {
    MachineOption,
    NewMachineOption,
    SignInCost
} from '@/pages/AgentNew/v4/machineOptions'

// Each step's standing explanation, shown from the info mark on its question
// rather than as a paragraph between the question and the first row.
const STEP_HINT_KEY: Record<CreateStepId, string> = {
    type: 'web.agentNewV4.help.type',
    runtime: 'web.agentNewV4.help.runtime',
    cost: 'web.agentNewV4.help.cost',
    name: 'web.agentNewV4.help.name'
}

// The chosen row's cost, restated beside the button so the two never drift.
const SIGN_IN_FINE_KEY: Record<SignInCost, string> = {
    none: 'web.agentNewV4.cost.noSignIn',
    'next-step': 'web.agentNewV4.cost.signInNextStep',
    after: 'web.agentNewV4.cost.signInAfter',
    'already-if-signed-in': 'web.agentNewV4.cost.signInOnThatComputer'
}
import {
    StepCost,
    StepCostExternal,
    costChoiceFor
} from '@/pages/AgentNew/v4/steps/StepCost'
import type { CostPick } from '@/pages/AgentNew/v4/steps/StepCost'
import { StepMachine } from '@/pages/AgentNew/v4/steps/StepMachine'
import { StepName } from '@/pages/AgentNew/v4/steps/StepName'
import { StepService } from '@/pages/AgentNew/v4/steps/StepService'
import { StepType } from '@/pages/AgentNew/v4/steps/StepType'

// Four steps, one screen at a time.
//
// The flow keeps NO progress of its own: no draft, no "resume where you left
// off". What it keeps instead is resources — each step commits its own the
// moment it is left, so a machine built here, a CLI installed here and an
// account signed in here all outlive an abandoned run and come back as
// ordinary rows in these same lists, with no "last time" badge on them. An
// agent is the exception: it is only born in step ④, so nothing half-made ever
// lands in the sidebar.
const AgentNewV4: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const navigate = useNavigate()
    const create = useAgentCreate()
    const managed = useManagedCreditGate()

    const [flow, setFlow] = useState<CreateFlowState>(initialFlowState)
    // Which row is highlighted in step ②. Held apart from `flow.runtime`
    // because a highlighted row is not yet a resource — the machine is only
    // built when the step is left.
    const [machinePick, setMachinePick] = useState<string | null>(null)
    const [preparing, setPreparing] = useState<string | null>(null)
    const [stepError, setStepError] = useState<string | null>(null)
    const [serviceProviderId, setServiceProviderId] = useState<string | null>(
        null
    )
    const [costPick, setCostPick] = useState<CostPick | null>(null)
    const [remoteRef, setRemoteRef] = useState('')
    const [reached, setReached] = useState<Set<CreateStepId>>(
        () => new Set<CreateStepId>(['type'])
    )

    const framework = flow.framework
    const onMachine = framework !== null && runsOnOurMachine(framework)

    const machines = useMemo(
        () =>
            framework === null || !onMachine
                ? []
                : buildMachineOptions({
                      framework,
                      runtimes: create.runtimes,
                      sandboxes: create.sandboxes,
                      daemonHosts: create.daemonHosts
                  }),
        [framework, onMachine, create.runtimes, create.sandboxes, create.daemonHosts]
    )
    const newMachines = useMemo(
        () =>
            framework === null || !onMachine
                ? []
                : buildNewMachineOptions({
                      framework,
                      access: create.runtimeAccess
                  }),
        [framework, onMachine, create.runtimeAccess]
    )

    const runtimeId =
        flow.runtime?.kind === 'runtime' ? flow.runtime.runtimeId : null
    const auth = useRuntimeAuthList(flow.step === 'cost' ? runtimeId : null)

    // Loading the external provider list is the one fetch that depends on the
    // type, so it waits until a type that needs it has been chosen.
    const { loadExternalProviders } = create
    useEffect(() => {
        if (framework === null || onMachine) return
        void loadExternalProviders(framework as 'dify' | 'langflow' | 'a2a')
    }, [framework, onMachine, loadExternalProviders])

    const goTo = useCallback((step: CreateStepId): void => {
        setStepError(null)
        setFlow((prev) => ({ ...prev, step }))
        setReached((prev) => new Set(prev).add(step))
    }, [])

    // Step ② commits the machine. Everything that has to happen for the chosen
    // row to become a real runtime happens HERE, with its progress on screen,
    // rather than being queued for a final submit.
    const commitMachine = useCallback(async (): Promise<RuntimeChoice | null> => {
        if (framework === null) return null
        const row = machines.find((m) => m.id === machinePick)
        if (row !== undefined && row.runtimeId !== null)
            return {
                kind: 'runtime',
                runtimeId: row.runtimeId,
                hostKind: row.hostKind,
                hostLabel: row.title,
                ownComputer: row.ownComputer
            }
        try {
            if (row !== undefined && row.sandboxId !== null) {
                setPreparing(row.title)
                const runtime = await client.sandboxes.prepareRuntime(
                    row.sandboxId,
                    framework
                )
                await create.refetchRuntimes()
                return {
                    kind: 'runtime',
                    runtimeId: runtime.id,
                    hostKind: 'sprites',
                    hostLabel: row.title,
                    ownComputer: false
                }
            }
            if (machinePick === 'new:sandbox') {
                setPreparing(t('web.agentNewV4.preparing.newMachine'))
                const sandbox = await client.sandboxes.create({})
                setPreparing(sandbox.name)
                const runtime = await client.sandboxes.prepareRuntime(
                    sandbox.id,
                    framework
                )
                await create.refetchSandboxes()
                await create.refetchRuntimes()
                return {
                    kind: 'runtime',
                    runtimeId: runtime.id,
                    hostKind: 'sprites',
                    hostLabel: sandbox.name,
                    ownComputer: false
                }
            }
        } catch (err) {
            setStepError((err as Error).message)
            return null
        } finally {
            setPreparing(null)
        }
        return null
    }, [client, create, framework, machinePick, machines, t])

    const commitService = useCallback((): RuntimeChoice | null => {
        const provider = create.externalProviders.find(
            (p: UserExternalAgentProviderSummary) => p.id === serviceProviderId
        )
        if (provider === undefined || remoteRef.trim() === '') return null
        return {
            kind: 'external',
            providerId: provider.id,
            providerLabel: provider.label,
            remoteRef: remoteRef.trim(),
            remoteLabel: remoteRef.trim()
        }
    }, [create.externalProviders, remoteRef, serviceProviderId])

    const submit = useCallback(async (): Promise<void> => {
        if (flow.runtime === null || flow.framework === null) return
        if (flow.runtime.kind !== 'runtime') {
            setStepError(t('web.agentNewV4.error.externalNotSupportedYet'))
            return
        }
        const created = await create.submitAddToRuntime({
            runtimeId: flow.runtime.runtimeId,
            body: {
                name: flow.name.trim(),
                workspace:
                    flow.runtime.ownComputer && flow.workspace.trim() !== ''
                        ? flow.workspace.trim()
                        : undefined,
                modelConfigSource:
                    flow.cost?.kind === 'runtime-local'
                        ? 'runtime-local'
                        : flow.cost?.kind === 'platform' ||
                            flow.cost?.kind === 'provider'
                          ? 'platform'
                          : undefined,
                runtimeAuthProfileId:
                    flow.cost?.kind === 'runtime-local'
                        ? flow.cost.profileId
                        : undefined
            }
        })
        if (created !== null) navigate('/agents/' + created.id + '/chat')
    }, [create, flow, navigate, t])

    const advance = useCallback(async (): Promise<void> => {
        setStepError(null)
        if (flow.step === 'runtime' && machinePick === 'new:ownComputer') {
            navigate('/runtimes?connect=daemon')
            return
        }
        if (flow.step === 'runtime' && machinePick === 'new:cloudComputer') {
            navigate('/runtimes?buy=cloud-computer')
            return
        }
        if (flow.step === 'runtime') {
            const choice = onMachine ? await commitMachine() : commitService()
            if (choice === null) {
                if (stepError === null)
                    setStepError(t('web.agentNewV4.error.machineNotReady'))
                return
            }
            setFlow((prev) => withRuntime(prev, choice))
            // A connected service settles its own billing, so step ③ has
            // nothing to ask — but it still appears, so every run of the flow
            // is the same four steps.
            if (choice.kind === 'external')
                setFlow((prev) => ({ ...prev, cost: { kind: 'external' } }))
            goTo('cost')
            return
        }
        if (flow.step === 'name') {
            await submit()
            return
        }
        if (flow.step === 'cost' && onMachine) {
            if (costPick === null) return
            // The sign-in row is an action, not an answer: it leaves for the
            // machine's account page rather than moving the flow on. The row
            // is still picked the same way as any other, so the button can
            // say "Sign in to Claude" instead of a "Next" that would lie.
            if (
                costPick.kind === 'signin' ||
                (costPick.kind === 'profile' && costPick.needsReauth)
            ) {
                navigate('/runtimes/' + (runtimeId ?? '') + '?addAccount=1')
                return
            }
            const choice = costChoiceFor(costPick)
            if (choice === null) return
            setFlow((prev) => ({ ...prev, cost: choice }))
        }
        if (flow.step === 'cost' && flow.name.trim() === '')
            setFlow((prev) => ({ ...prev, name: randomAgentName() }))
        goTo(nextStep(flow.step))
    }, [
        flow.step,
        flow.name,
        onMachine,
        machinePick,
        costPick,
        runtimeId,
        navigate,
        commitMachine,
        commitService,
        submit,
        goTo,
        stepError,
        t
    ])

    const busy = preparing !== null || create.busy

    // What the bar shows under each step name. These are the labels the flow
    // already carries, not second copies written for display — a value that
    // has to be composed twice is a value that will drift. User-named data
    // (a provider's own name) can be long; the cell truncates rather than
    // having us rewrite what they called it.
    const stepValues = useMemo((): StepValues => {
        const out: StepValues = {}
        if (flow.framework !== null) out.type = frameworkLabel(flow.framework)
        if (flow.runtime?.kind === 'runtime')
            out.runtime = flow.runtime.hostLabel
        else if (flow.runtime?.kind === 'external')
            out.runtime = flow.runtime.providerLabel
        if (flow.cost !== null) out.cost = costLabel(flow.cost, t)
        if (flow.name.trim() !== '') out.name = flow.name.trim()
        return out
    }, [flow.framework, flow.runtime, flow.cost, flow.name, t])

    // What the primary button will do from here. Because the bar never leaves
    // the screen, this is the one place that can state the consequence before
    // it is paid: picking a machine that already runs agents costs a click,
    // picking "New sandbox" costs two minutes and one of five — and the label
    // says which, instead of a uniform "Next" that hides the difference.
    const primary = useMemo((): StepPrimary => {
        const cli = framework !== null ? frameworkLabel(framework) : ''
        const next = t('web.agentNewV4.next')
        const blockedKey = advanceBlockedKey(flow)
        if (flow.step === 'type')
            return blockedKey !== null
                ? { label: next, blockedReason: t(blockedKey) }
                : { label: next }
        if (flow.step === 'runtime' && onMachine) {
            if (machinePick === null)
                return {
                    label: next,
                    blockedReason: t('web.agentNewV4.blocked.runtime')
                }
            if (machinePick === 'new:ownComputer')
                return {
                    label: t('web.agentNewV4.primary.goToSettings'),
                    fine: t('web.agentNewV4.primary.leavesFlow')
                }
            if (machinePick === 'new:cloudComputer')
                return {
                    label: t('web.agentNewV4.primary.goToSettings'),
                    fine: t('web.agentNewV4.primary.leavesFlow')
                }
            if (machinePick === 'new:sandbox') {
                const quota = newMachines.find((o) => o.kind === 'sandbox')
                return {
                    label: t('web.agentNewV4.primary.buildAndInstall', { cli }),
                    fine: t('web.agentNewV4.primary.buildFine', {
                        used: String(quota?.used ?? 0),
                        limit: String(quota?.limit ?? 0)
                    })
                }
            }
            const row = machines.find((m) => m.id === machinePick)
            if (row !== undefined && row.runtimeId === null)
                return {
                    label: t('web.agentNewV4.primary.installOn', {
                        cli,
                        machine: row.title
                    }),
                    fine: t('web.agentNewV4.primary.installFine')
                }
            return {
                label: next,
                fine:
                    row !== undefined
                        ? t(SIGN_IN_FINE_KEY[row.signInCost])
                        : undefined
            }
        }
        if (flow.step === 'runtime')
            return serviceProviderId === null || remoteRef.trim() === ''
                ? {
                      label: next,
                      blockedReason: t('web.agentNewV4.blocked.runtime')
                  }
                : { label: next }
        if (flow.step === 'cost' && onMachine) {
            if (costPick === null)
                return {
                    label: next,
                    blockedReason: t('web.agentNewV4.blocked.cost')
                }
            // A credential that needs re-authorising costs exactly what a new
            // sign-in costs, so it gets the same button rather than a "Next"
            // that would drop the user into a broken agent.
            if (
                costPick.kind === 'signin' ||
                (costPick.kind === 'profile' && costPick.needsReauth)
            )
                return {
                    label: t('web.agentNewV4.primary.signIn', {
                        vendor:
                            framework !== null ? vendorLabel(framework) : ''
                    }),
                    fine: t('web.agentNewV4.primary.opensAuthPage')
                }
            return { label: next }
        }
        if (flow.step === 'cost') return { label: next }
        return blockedKey !== null
            ? {
                  label: t('web.agentNewV4.createAgent'),
                  blockedReason: t(blockedKey)
              }
            : {
                  label: t('web.agentNewV4.createAgent'),
                  fine: t('web.agentNewV4.primary.createFine')
              }
    }, [
        flow,
        framework,
        onMachine,
        machinePick,
        machines,
        newMachines,
        costPick,
        serviceProviderId,
        remoteRef,
        t
    ])

    const question = useMemo((): string => {
        if (flow.step === 'type') return t('web.agentNewV4.question.type')
        const cli = framework !== null ? frameworkLabel(framework) : ''
        // Every step restates the previous answer in its own question, so the
        // path bar never has to carry the chosen values.
        if (flow.step === 'runtime')
            return onMachine
                ? t('web.agentNewV4.question.machine', { cli })
                : t('web.agentNewV4.question.service', { cli })
        if (flow.step === 'cost')
            return onMachine
                ? t('web.agentNewV4.question.cost', {
                      machine: flow.runtime?.kind === 'runtime'
                          ? flow.runtime.hostLabel
                          : ''
                  })
                : t('web.agentNewV4.question.costExternal')
        return t('web.agentNewV4.question.name')
    }, [flow.step, flow.runtime, framework, onMachine, t])

    return (
        <StepShell
            current={flow.step}
            reached={reached}
            values={stepValues}
            question={question}
            hint={t(STEP_HINT_KEY[flow.step])}
            notice={
                preparing !== null
                    ? t('web.agentNewV4.preparing.note', {
                          machine: preparing
                      })
                    : undefined
            }
            onBack={
                flow.step === 'type' ? undefined : () => goTo(previousStep(flow.step))
            }
            onJump={goTo}
            onNext={() => void advance()}
            primary={primary}
            busy={busy}
        >
            {flow.step === 'type' && (
                <StepType
                    value={flow.framework}
                    onChange={(next: AgentFramework) => {
                        setMachinePick(null)
                        setFlow((prev) => withFramework(prev, next))
                    }}
                />
            )}
            {flow.step === 'runtime' && framework !== null && onMachine && (
                <StepMachine
                    framework={framework}
                    machines={machines}
                    newMachines={newMachines}
                    selectedId={machinePick}
                    onSelectMachine={(row: MachineOption) =>
                        setMachinePick(row.id)
                    }
                    onSelectNew={(option: NewMachineOption) =>
                        setMachinePick('new:' + option.kind)
                    }
                    quotaWarning={
                        stepError !== null ? (
                            <p className='workbench-alert-error mt-4'>
                                {stepError}
                            </p>
                        ) : null
                    }
                />
            )}
            {flow.step === 'runtime' && framework !== null && !onMachine && (
                <StepService
                    framework={framework}
                    providers={create.externalProviders}
                    loading={false}
                    error={create.externalProvidersError}
                    selectedProviderId={serviceProviderId}
                    remoteRef={remoteRef}
                    onSelectProvider={(p: UserExternalAgentProviderSummary) =>
                        setServiceProviderId(p.id)
                    }
                    onChangeRemoteRef={setRemoteRef}
                    onConnectNew={() => navigate('/settings/providers')}
                />
            )}
            {flow.step === 'cost' && framework !== null && onMachine && (
                <StepCost
                    framework={framework}
                    authList={auth.list}
                    authLoading={auth.loading}
                    providers={create.providers}
                    managedAvailable={managed.managedAvailable}
                    managedUnavailableReason={t(
                        'web.agentNewV4.cost.managedUnavailable'
                    )}
                    value={costPick}
                    onChange={setCostPick}
                    onBackToType={() => goTo('type')}
                />
            )}
            {flow.step === 'cost' && framework !== null && !onMachine && (
                <StepCostExternal framework={framework} />
            )}
            {flow.step === 'name' && (
                <StepName
                    typeLabel={
                        framework !== null ? frameworkLabel(framework) : ''
                    }
                    whereLabel={
                        flow.runtime?.kind === 'runtime'
                            ? flow.runtime.hostLabel
                            : (flow.runtime?.providerLabel ?? '')
                    }
                    costLabel={costLabel(flow.cost, t)}
                    name={flow.name}
                    onChangeName={(value: string) =>
                        setFlow((prev) => ({ ...prev, name: value }))
                    }
                    ownComputer={
                        flow.runtime?.kind === 'runtime' &&
                        flow.runtime.ownComputer
                    }
                    workspace={flow.workspace}
                    onChangeWorkspace={(value: string) =>
                        setFlow((prev) => ({ ...prev, workspace: value }))
                    }
                    onJump={goTo}
                />
            )}
            {create.error !== null && (
                <p className='workbench-alert-error mt-4'>{create.error}</p>
            )}
        </StepShell>
    )
}

const costLabel = (
    cost: CostChoice | null,
    t: (key: string) => string
): string => {
    if (cost === null) return ''
    if (cost.kind === 'runtime-local') return cost.label
    if (cost.kind === 'provider') return cost.label
    if (cost.kind === 'platform') return t('web.agentNewV4.cost.managed')
    return t('web.agentNewV4.cost.externalShort')
}

export default AgentNewV4

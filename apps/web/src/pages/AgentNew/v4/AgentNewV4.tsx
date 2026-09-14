import type { AgentFramework, UserExternalAgentProviderSummary } from '@manyfold/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FC, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { randomAgentName } from '@/lib/agentCreate/agentName'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import { useAgentCreate } from '@/lib/agentCreate/useAgentCreate'
import { useManagedCreditGate } from '@/lib/managedCreditGate'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'
import { StepShell } from '@/pages/AgentNew/v4/components/StepShell'
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
import {
    frameworkLabel,
    runsOnOurMachine
} from '@/pages/AgentNew/v4/frameworkCatalog'
import {
    buildMachineOptions,
    buildNewMachineOptions
} from '@/pages/AgentNew/v4/machineOptions'
import type {
    MachineOption,
    NewMachineOption
} from '@/pages/AgentNew/v4/machineOptions'
import { StepCost, StepCostExternal } from '@/pages/AgentNew/v4/steps/StepCost'
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
        if (flow.step === 'cost' && flow.name.trim() === '')
            setFlow((prev) => ({ ...prev, name: randomAgentName() }))
        goTo(nextStep(flow.step))
    }, [
        flow.step,
        flow.name,
        onMachine,
        commitMachine,
        commitService,
        submit,
        goTo,
        stepError,
        t
    ])

    const blockedKey = advanceBlockedKey(flow)
    const busy = preparing !== null || create.busy

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
            question={question}
            help={<StepHelp step={flow.step} preparing={preparing} />}
            onBack={
                flow.step === 'type' ? undefined : () => goTo(previousStep(flow.step))
            }
            onNext={() => void advance()}
            nextLabel={
                flow.step === 'name'
                    ? t('web.agentNewV4.createAgent')
                    : t('web.agentNewV4.next')
            }
            nextBlockedReason={
                blockedKey !== null && flow.step !== 'runtime'
                    ? t(blockedKey)
                    : blockedKey !== null && machinePick === null
                      ? t(blockedKey)
                      : undefined
            }
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
                    onSelectNew={(option: NewMachineOption) => {
                        // These two leave the flow: a daemon is installed on
                        // the user's own computer, a cloud computer is bought.
                        // Neither can happen inside this step, so the row is a
                        // door rather than a choice.
                        if (option.kind === 'ownComputer')
                            navigate('/runtimes?connect=daemon')
                        else if (option.kind === 'cloudComputer')
                            navigate('/runtimes?buy=cloud-computer')
                        else setMachinePick('new:' + option.kind)
                    }}
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
                    machineLabel={
                        flow.runtime?.kind === 'runtime'
                            ? flow.runtime.hostLabel
                            : ''
                    }
                    authList={auth.list}
                    authLoading={auth.loading}
                    providers={create.providers}
                    managedAvailable={managed.managedAvailable}
                    managedUnavailableReason={t(
                        'web.agentNewV4.cost.managedUnavailable'
                    )}
                    value={flow.cost}
                    onChange={(choice: CostChoice) =>
                        setFlow((prev) => ({ ...prev, cost: choice }))
                    }
                    onAddAccount={() =>
                        navigate(
                            '/runtimes/' + (runtimeId ?? '') + '?addAccount=1'
                        )
                    }
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

const StepHelp: FC<{ step: CreateStepId; preparing: string | null }> = ({
    step,
    preparing
}): ReactNode => {
    const { t } = useI18n()
    // While a machine is being built the help line carries the interruption
    // promise, because this is the one moment the user might walk away
    // mid-work — and what it promises is precise: the machine and the CLI
    // survive, the position in the flow does not.
    if (preparing !== null)
        return <>{t('web.agentNewV4.preparing.note', { machine: preparing })}</>
    if (step === 'type') return <>{t('web.agentNewV4.help.type')}</>
    if (step === 'runtime') return <>{t('web.agentNewV4.help.runtime')}</>
    if (step === 'cost') return <>{t('web.agentNewV4.help.cost')}</>
    return <>{t('web.agentNewV4.help.name')}</>
}

export default AgentNewV4

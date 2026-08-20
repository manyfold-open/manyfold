import type { AgentCreateStep } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { Spinner } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'

export interface CreateProgressProps {
    steps: AgentCreateStep[]
    currentIndex: number
    failedStep: AgentCreateStep | null
    errorMessage: string | null
}

type StepState = 'pending' | 'active' | 'done' | 'failed'

const stepState = (
    step: AgentCreateStep,
    index: number,
    currentIndex: number,
    failedStep: AgentCreateStep | null
): StepState => {
    if (failedStep && failedStep === step) return 'failed'
    if (failedStep) {
        if (index < currentIndex) return 'done'
        return 'pending'
    }
    if (index < currentIndex) return 'done'
    if (index === currentIndex) return 'active'
    return 'pending'
}

const Marker: FC<{ state: StepState }> = ({ state }): ReactNode => {
    if (state === 'done')
        return (
            <span className='text-link shadow-ring-light flex h-6 w-6 items-center justify-center rounded-full bg-[#eef6ff]'>
                ✓
            </span>
        )
    if (state === 'failed')
        return (
            <span className='text-workflow-ship shadow-ring-light flex h-6 w-6 items-center justify-center rounded-full bg-[#fff1ef]'>
                ✕
            </span>
        )
    if (state === 'active')
        return (
            <span className='bg-strong text-strong-fg flex h-6 w-6 items-center justify-center rounded-full'>
                <Spinner size={12} />
            </span>
        )
    return (
        <span className='shadow-ring-light flex h-6 w-6 items-center justify-center rounded-full bg-white' />
    )
}

const labelTone: Record<StepState, string> = {
    pending: 'text-muted',
    active: 'text-fg font-medium',
    done: 'text-link',
    failed: 'text-workflow-ship font-medium'
}

export const CreateProgress: FC<CreateProgressProps> = ({
    steps,
    currentIndex,
    failedStep,
    errorMessage
}): ReactNode => {
    const { t } = useI18n()
    const stepLabel: Record<AgentCreateStep, string> = {
        validating: t('web.agentNew.progress.validating'),
        selecting_account: t('web.agentNew.progress.selectingAccount'),
        inserting_agent: t('web.agentNew.progress.insertingAgent'),
        creating_sprite: t('web.agentNew.progress.creatingWorkspace'),
        applying_network_policy: t('web.agentNew.progress.configuringNetwork'),
        bootstrapping: t('web.agentNew.progress.bootstrappingFramework'),
        installing_framework: t('web.agentNew.progress.installingFramework'),
        starting_service: t('web.agentNew.progress.startingService'),
        checking_quota: t('web.agentNew.progress.checkingQuota'),
        preparing_namespace: t('web.agentNew.progress.preparingWorkspace'),
        creating_secret: t('web.agentNew.progress.securingCredentials'),
        creating_storage: t('web.agentNew.progress.creatingStorage'),
        creating_deployment: t('web.agentNew.progress.startingRuntime'),
        creating_service: t('web.agentNew.progress.connectingRuntime'),
        creating_ingress: t('web.agentNew.progress.publishingRuntime'),
        waiting_for_ready: t('web.agentNew.progress.waitingForReadiness'),
        storing_credentials: t('web.agentNew.progress.storingCredentials'),
        restoring_backup: t('web.agentNew.progress.restoringBackup'),
        finalizing: t('web.agentNew.progress.finalizing')
    }
    // Fail loud: if the API reports a failedStep that isn't in our step list
    // (framework added without bumping progressStepsForCreate, etc.), the
    // inline `state === 'failed'` branch never fires and the error vanishes.
    // Render an orphan banner so the user always sees what went wrong.
    const failedStepInList =
        !!failedStep && steps.includes(failedStep as AgentCreateStep)
    const showOrphanError = !!errorMessage && !failedStepInList
    return (
        <ol className='space-y-3'>
            {steps.map((step, index) => {
                const state = stepState(step, index, currentIndex, failedStep)
                return (
                    <li
                        key={step}
                        className='flex items-start gap-3'
                        aria-current={state === 'active' ? 'step' : undefined}
                    >
                        <Marker state={state} />
                        <div className='flex-1 pt-0.5'>
                            <div
                                className={[
                                    'text-caption',
                                    labelTone[state]
                                ].join(' ')}
                            >
                                {stepLabel[step]}
                            </div>
                            {state === 'failed' && errorMessage && (
                                <pre className='text-workflow-ship shadow-ring-light mt-2 whitespace-pre-wrap rounded-md bg-[#fff1ef] px-3 py-2 font-mono text-[12px]'>
                                    {errorMessage}
                                </pre>
                            )}
                        </div>
                    </li>
                )
            })}
            {showOrphanError && (
                <li className='flex items-start gap-3'>
                    <Marker state='failed' />
                    <div className='flex-1 pt-0.5'>
                        <div className='text-caption text-workflow-ship font-medium'>
                            {failedStep
                                ? t('web.agentNew.progress.failedAt', {
                                      step: failedStep
                                  })
                                : t('web.agentNew.progress.createFailed')}
                        </div>
                        <pre className='text-workflow-ship shadow-ring-light mt-2 whitespace-pre-wrap rounded-md bg-[#fff1ef] px-3 py-2 font-mono text-[12px]'>
                            {errorMessage}
                        </pre>
                    </div>
                </li>
            )}
        </ol>
    )
}

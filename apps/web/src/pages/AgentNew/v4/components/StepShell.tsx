import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import type { CreateStepId } from '@/pages/AgentNew/v4/flowState'
import { CREATE_STEP_ORDER } from '@/pages/AgentNew/v4/flowState'

const STEP_TITLE_KEY: Record<CreateStepId, string> = {
    type: 'web.agentNewV4.step.type',
    runtime: 'web.agentNewV4.step.runtime',
    cost: 'web.agentNewV4.step.cost',
    name: 'web.agentNewV4.step.name'
}

// The path bar carries PROGRESS and nothing else: four fixed names, never the
// chosen option. Letting it echo choices makes its width jump with every pick,
// and it has no room to be read carefully anyway. The full record of what was
// chosen lives in step ④, one line each with its own Change link, where it can
// be read at leisure — and each step's own question restates the previous
// answer ("Where does Claude Code run?"), so context is never lost in between.
const PathBar: FC<{ current: CreateStepId; reached: Set<CreateStepId> }> = ({
    current,
    reached
}): ReactNode => {
    const { t } = useI18n()
    return (
        <ol className='text-caption mb-7 flex flex-wrap items-center gap-x-2 gap-y-1'>
            {CREATE_STEP_ORDER.map((step, index) => {
                const isCurrent = step === current
                const done = reached.has(step) && !isCurrent
                return (
                    <li key={step} className='flex items-center gap-2'>
                        {index > 0 && (
                            <span className='text-placeholder' aria-hidden='true'>
                                ·
                            </span>
                        )}
                        <span
                            aria-current={isCurrent ? 'step' : undefined}
                            className={
                                isCurrent
                                    ? 'text-fg inline-flex items-center gap-1.5 font-medium'
                                    : 'text-placeholder inline-flex items-center gap-1.5'
                            }
                        >
                            <span
                                className={
                                    isCurrent
                                        ? 'bg-strong text-strong-fg inline-flex h-4 w-4 items-center justify-center rounded-pill text-[10px] font-medium'
                                        : 'shadow-ring-light inline-flex h-4 w-4 items-center justify-center rounded-pill text-[10px]'
                                }
                                aria-hidden='true'
                            >
                                {done ? '✓' : index + 1}
                            </span>
                            {t(STEP_TITLE_KEY[step])}
                        </span>
                    </li>
                )
            })}
        </ol>
    )
}

// One step = one question and one column of rows. The question restates the
// previous answer so the user never has to look back up at the path bar.
export const StepShell: FC<{
    current: CreateStepId
    reached: Set<CreateStepId>
    question: string
    help?: ReactNode
    children: ReactNode
    onBack?: () => void
    onNext?: () => void
    nextLabel: string
    // Why Next is unavailable — shown beside the disabled button rather than
    // left for the user to guess.
    nextBlockedReason?: string
    busy?: boolean
}> = ({
    current,
    reached,
    question,
    help,
    children,
    onBack,
    onNext,
    nextLabel,
    nextBlockedReason,
    busy = false
}): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='workbench-page-narrow'>
            <h1 className='text-h2 text-fg mb-5 font-medium'>
                {t('web.agentNewV4.title')}
            </h1>
            <PathBar current={current} reached={reached} />
            <h2 className='text-h3 text-fg font-medium'>{question}</h2>
            {help !== undefined && help !== null && (
                <p className='text-body text-muted mt-1.5'>{help}</p>
            )}
            <div className='mt-5'>{children}</div>
            <div className='mt-7 flex flex-wrap items-center gap-3'>
                {onBack !== undefined && (
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        onClick={onBack}
                        disabled={busy}
                    >
                        {t('web.agentNewV4.back')}
                    </button>
                )}
                {onNext !== undefined && (
                    <button
                        type='button'
                        className='workbench-button-primary'
                        onClick={onNext}
                        disabled={busy || nextBlockedReason !== undefined}
                    >
                        {nextLabel}
                    </button>
                )}
                {nextBlockedReason !== undefined && (
                    <span className='text-caption text-placeholder'>
                        {nextBlockedReason}
                    </span>
                )}
            </div>
        </div>
    )
}

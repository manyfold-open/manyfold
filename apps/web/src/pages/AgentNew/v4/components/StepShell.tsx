import type {
    FC,
    KeyboardEvent as ReactKeyboardEvent,
    ReactNode
} from 'react'
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
// A step already answered is also the way back to it. The bar had to exist
// anyway, and turning its finished entries into links saves walking back one
// step at a time from ③ to ① — the same move as the Change links on step ④'s
// summary, not a second way of going back.
const PathBar: FC<{
    current: CreateStepId
    reached: Set<CreateStepId>
    onJump: (step: CreateStepId) => void
}> = ({ current, reached, onJump }): ReactNode => {
    const { t } = useI18n()
    return (
        <ol className='text-caption mb-7 flex flex-wrap items-center gap-x-2 gap-y-1'>
            {CREATE_STEP_ORDER.map((step, index) => {
                const isCurrent = step === current
                const done = reached.has(step) && !isCurrent
                const label = (
                    <>
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
                    </>
                )
                return (
                    <li key={step} className='flex items-center gap-2'>
                        {index > 0 && (
                            <span className='text-placeholder' aria-hidden='true'>
                                ·
                            </span>
                        )}
                        {done ? (
                            <button
                                type='button'
                                onClick={() => onJump(step)}
                                className='text-fg inline-flex items-center gap-1.5 underline-offset-4 hover:underline'
                            >
                                {label}
                            </button>
                        ) : (
                            <span
                                aria-current={isCurrent ? 'step' : undefined}
                                className={
                                    isCurrent
                                        ? 'text-fg inline-flex items-center gap-1.5 font-medium'
                                        : 'text-placeholder inline-flex items-center gap-1.5'
                                }
                            >
                                {label}
                            </span>
                        )}
                    </li>
                )
            })}
        </ol>
    )
}

// What the primary button will DO from where the user currently stands. The
// bar is always on screen, so the button is the one place that can state the
// consequence before it is paid — "Build one and install Claude Code · about
// 2 minutes" rather than a uniform "Next" that hides which rows are cheap and
// which spend two minutes and a sandbox out of five.
export interface StepPrimary {
    label: string
    // The cost of the selected row, restated beside the button.
    fine?: string
    // Set when the step is not answered yet: the button is disabled and this
    // says what it is waiting for. A control that refuses to move should not
    // make the user guess why.
    blockedReason?: string
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
    onJump: (step: CreateStepId) => void
    onNext: () => void
    primary: StepPrimary
    busy?: boolean
}> = ({
    current,
    reached,
    question,
    help,
    children,
    onBack,
    onJump,
    onNext,
    primary,
    busy = false
}): ReactNode => {
    const { t } = useI18n()
    const blocked = primary.blockedReason !== undefined
    // Enter advances from anywhere in the step. Picking a row focuses it, so
    // the whole flow is arrow keys and Enter — which is where the speed of
    // "one click per step" belongs, rather than in making some rows advance
    // themselves and others not.
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'Enter' || busy || blocked) return
        const target = event.target as HTMLElement
        if (target.tagName === 'TEXTAREA') return
        event.preventDefault()
        onNext()
    }
    return (
        <div className='workbench-page-narrow pb-0' onKeyDown={onKeyDown}>
            <h1 className='text-h2 text-fg mb-5 font-medium'>
                {t('web.agentNewV4.title')}
            </h1>
            <PathBar current={current} reached={reached} onJump={onJump} />
            <h2 className='text-h3 text-fg font-medium'>{question}</h2>
            {help !== undefined && help !== null && (
                <p className='text-body text-muted mt-1.5'>{help}</p>
            )}
            <div className='mt-5'>{children}</div>
            <div className='create-step-actions'>
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
                <button
                    type='button'
                    className='workbench-button-primary'
                    onClick={onNext}
                    disabled={busy || blocked}
                >
                    {primary.label}
                </button>
                {(primary.blockedReason ?? primary.fine) !== undefined && (
                    <span className='text-caption text-placeholder'>
                        {primary.blockedReason ?? primary.fine}
                    </span>
                )}
            </div>
        </div>
    )
}

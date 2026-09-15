import type {
    FC,
    KeyboardEvent as ReactKeyboardEvent,
    ReactNode
} from 'react'
import { InfoIcon } from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useI18n } from '@/lib/i18n'
import { StepBar } from '@/pages/AgentNew/v4/components/StepBar'
import type { StepValues } from '@/pages/AgentNew/v4/components/StepBar'
import type { CreateStepId } from '@/pages/AgentNew/v4/flowState'

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
    // What each step settled on, shown in the bar so an earlier answer can be
    // read without walking back to it.
    values: StepValues
    question: string
    // The step's standing explanation. It orients rather than instructs — the
    // rows carry every operative fact — so it lives behind an info mark on the
    // question instead of as a paragraph the eye has to cross on the way to
    // the first choice.
    hint?: string
    // A live message about what is happening right now, which is not the same
    // thing and stays on the page: the one shown while a machine is being
    // built promises that leaving is safe, and a promise nobody sees is not
    // one.
    notice?: ReactNode
    children: ReactNode
    onBack?: () => void
    onJump: (step: CreateStepId) => void
    onNext: () => void
    primary: StepPrimary
    busy?: boolean
}> = ({
    current,
    reached,
    values,
    question,
    hint,
    notice,
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
        <div className='create-page' onKeyDown={onKeyDown}>
            <h1 className='text-h2 text-fg mb-5 font-medium'>
                {t('web.agentNewV4.title')}
            </h1>
            <StepBar
                current={current}
                reached={reached}
                values={values}
                onJump={onJump}
            />
            <h2 className='text-h3 text-fg flex items-center gap-1.5 font-medium'>
                {question}
                {hint !== undefined && (
                    <ShortcutTooltip label={hint} multiline placement='bottom-start'>
                        <button
                            type='button'
                            aria-label={hint}
                            className='text-placeholder hover:text-muted inline-flex h-5 w-5 items-center justify-center rounded-pill transition-colors'
                        >
                            <InfoIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                )}
            </h2>
            {notice !== undefined && notice !== null && (
                <p className='text-body text-muted mt-1.5'>{notice}</p>
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

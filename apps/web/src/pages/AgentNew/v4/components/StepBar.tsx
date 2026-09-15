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

export type StepValues = Partial<Record<CreateStepId, string>>

interface StepBarProps {
    current: CreateStepId
    reached: Set<CreateStepId>
    // What was chosen, per step. Answers the question the flow could not
    // otherwise answer: standing on step ③ there was nowhere to see what step
    // ① picked, because each step only restates the IMMEDIATELY previous
    // answer inside its own question.
    values: StepValues
    onJump: (step: CreateStepId) => void
}

const marker = (index: number, isCurrent: boolean, done: boolean): ReactNode => (
    <span
        className={
            isCurrent
                ? 'bg-strong text-strong-fg inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-pill text-[10px] font-medium'
                : done
                  ? 'bg-fg/10 text-fg inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-pill text-[10px]'
                  : 'shadow-ring-light text-subtle inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-pill text-[10px]'
        }
        aria-hidden='true'
    >
        {done ? '✓' : index + 1}
    </span>
)

// The wide bar: step name over the value chosen for it. A finished cell is
// also the way back to its step — and carrying the value is what makes that
// readable as something to press, where a line of plain text with a check was
// not.
//
// Its height never changes: an unanswered step keeps an empty value line
// rather than collapsing, so the page does not jump a row taller each time a
// step is answered. Unanswered steps show no placeholder dash either — a dash
// reads as "none", not as "not yet".
const SummaryBar: FC<StepBarProps> = ({
    current,
    reached,
    values,
    onJump
}): ReactNode => {
    const { t } = useI18n()
    return (
        <ol className='create-step-bar'>
            {CREATE_STEP_ORDER.map((step, index) => {
                const isCurrent = step === current
                const done = reached.has(step) && !isCurrent
                const value = values[step]
                // Two rows, one text column: the pip sits in a gutter beside
                // both of them rather than inside the first, so the step name
                // and the value it settled on share a left edge. Hung the
                // other way the value starts 22px left of its own label, and
                // a cell with two left edges reads as two fragments instead
                // of one answer. The gutter is a grid track, not a padding
                // guess, so it follows the pip if the pip ever resizes.
                const body = (
                    <span className='grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-1.5'>
                        {marker(index, isCurrent, done)}
                        <span className='text-caption text-subtle truncate leading-tight'>
                            {t(STEP_TITLE_KEY[step])}
                        </span>
                        <span className='create-step-bar-value text-ui text-fg col-start-2 mt-1 h-5 truncate leading-5'>
                            {value ?? ''}
                        </span>
                    </span>
                )
                return (
                    <li key={step} className='min-w-0'>
                        {done ? (
                            <button
                                type='button'
                                onClick={() => onJump(step)}
                                className='create-step-bar-cell create-step-bar-cell-done'
                            >
                                {body}
                            </button>
                        ) : (
                            <div
                                className='create-step-bar-cell'
                                aria-current={isCurrent ? 'step' : undefined}
                            >
                                {body}
                            </div>
                        )}
                    </li>
                )
            })}
        </ol>
    )
}

// The narrow bar: four names on one wrapping line, no values. Four columns
// cannot honestly fit a phone, and folding them two-by-two would push the
// step's own question below the fold — the very thing pinning the action bar
// was meant to stop. Going back does not disappear with the breakpoint: a
// finished name stays a link here too.
const PathBar: FC<StepBarProps> = ({
    current,
    reached,
    onJump
}): ReactNode => {
    const { t } = useI18n()
    return (
        <ol className='text-caption mb-7 flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden'>
            {CREATE_STEP_ORDER.map((step, index) => {
                const isCurrent = step === current
                const done = reached.has(step) && !isCurrent
                const label = (
                    <>
                        {marker(index, isCurrent, done)}
                        {t(STEP_TITLE_KEY[step])}
                    </>
                )
                return (
                    <li key={step} className='flex items-center gap-2'>
                        {index > 0 && (
                            <span
                                className='text-placeholder'
                                aria-hidden='true'
                            >
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

export const StepBar: FC<StepBarProps> = (props): ReactNode => (
    <>
        <PathBar {...props} />
        <SummaryBar {...props} />
    </>
)

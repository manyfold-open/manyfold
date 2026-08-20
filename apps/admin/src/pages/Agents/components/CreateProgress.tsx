import type { AgentCreateStep } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'

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
        const failedIndex = currentIndex
        if (index < failedIndex) return 'done'
        return 'pending'
    }
    if (index < currentIndex) return 'done'
    if (index === currentIndex) return 'active'
    return 'pending'
}

const Marker: FC<{ state: StepState }> = ({ state }): ReactNode => {
    if (state === 'done')
        return (
            <span className='bg-success-bg text-success-text flex h-6 w-6 items-center justify-center rounded-full'>
                <svg
                    viewBox='0 0 16 16'
                    width='12'
                    height='12'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    aria-hidden='true'
                >
                    <path d='M3 8.5l3.2 3.2L13 5' />
                </svg>
            </span>
        )
    if (state === 'failed')
        return (
            <span className='bg-accent-ruby/15 text-accent-ruby flex h-6 w-6 items-center justify-center rounded-full'>
                <svg
                    viewBox='0 0 16 16'
                    width='12'
                    height='12'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    aria-hidden='true'
                >
                    <path d='M4 4l8 8M12 4l-8 8' />
                </svg>
            </span>
        )
    if (state === 'active')
        return (
            <span
                className='bg-brand flex h-6 w-6 items-center justify-center rounded-full text-white'
                aria-label='in progress'
            >
                <span className='h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white' />
            </span>
        )
    return (
        <span className='border-border text-body flex h-6 w-6 items-center justify-center rounded-full border bg-white' />
    )
}

const labelTone: Record<StepState, string> = {
    pending: 'text-body font-normal',
    active: 'text-heading font-normal',
    done: 'text-success-text font-normal',
    failed: 'text-accent-ruby font-normal'
}

export const CreateProgress: FC<CreateProgressProps> = ({
    steps,
    currentIndex,
    failedStep,
    errorMessage
}): ReactNode => (
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
                            className={['text-caption', labelTone[state]].join(
                                ' '
                            )}
                        >
                            {t(`admin.agents.new.step.${step}`)}
                        </div>
                        {state === 'failed' && errorMessage && (
                            <div className='mt-1 space-y-1'>
                                <div className='text-caption-sm text-accent-ruby'>
                                    {t('admin.agents.new.progress.failed')}
                                </div>
                                <pre className='border-accent-ruby/30 bg-accent-ruby/5 text-accent-ruby rounded border px-2 py-1 font-mono text-[12px] leading-relaxed whitespace-pre-wrap'>
                                    {errorMessage}
                                </pre>
                            </div>
                        )}
                    </div>
                </li>
            )
        })}
    </ol>
)

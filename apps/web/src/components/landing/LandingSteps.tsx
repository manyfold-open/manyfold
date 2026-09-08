import type { FC, ReactNode } from 'react'

export interface LandingStep {
    title: string
    body: string
    /* The command a terminal opens on, for the steps that have one. */
    code?: string
    /* An aside that qualifies the step without interrupting it. */
    note?: string
}

/* The three-steps block, shared by every acquisition page that has one. It
   was two blocks: a bordered card with full-height rules and a chevron on
   each divider, and a flat row with mono ordinals down the left. Two pages,
   two components, in two repositories, with nothing comparing them.

   Flat, because only a flat row absorbs the uneven columns these lists
   actually have. A step that carries a command and an aside runs a good deal
   taller than its neighbours, and inside a card divided by full-height rules
   that is the first thing you see. It is also a block you read once rather
   than one you scan, so a frame around three sentences buys nothing.

   The ordinal is the display numeral rather than a mono coordinate, because
   it is the only thing here that says these are ordered. Measured on Chrome
   148 [2026-09-08]: set as a 12.5px mono caption at --lp-faint it came to
   1.86:1 against the canvas, which is not a contrast so much as an absence —
   the three steps read as three parallel items. */
export const LandingSteps: FC<{ steps: LandingStep[] }> = ({
    steps
}): ReactNode => (
    <ol className='lp-steps'>
        {steps.map((step, index) => (
            <li className='lp-step' key={step.title}>
                {/* Left readable: `list-style: none` costs an ordered list its
                    semantics in some screen readers, and this is the fallback
                    that keeps the sequence recoverable when it does. */}
                <span className='lp-step-num'>{index + 1}</span>
                <h3 className='lp-step-title'>{step.title}</h3>
                <p className='lp-step-body'>{step.body}</p>
                {step.code ? (
                    <p className='lp-step-cmd'>
                        <code>{step.code}</code>
                    </p>
                ) : null}
                {step.note ? <p className='lp-step-note'>{step.note}</p> : null}
            </li>
        ))}
    </ol>
)

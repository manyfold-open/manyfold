import type { FC, ReactNode } from 'react'

// The two-pane settings shell: a fixed rail beside a scrolling content pane.
// Four areas render it, so it lives here rather than as a fourth copy of the
// same class strings.
//
// `hasSelection` is the whole mobile story. Below lg the two panes are one
// screen at a time: with nothing selected the rail owns it, and selecting
// something swaps to the pane. On lg and up both are always visible and the
// flag only decides what the pane shows.
export const CascadeShell: FC<{
    railLabel: string
    rail: ReactNode
    hasSelection: boolean
    children: ReactNode
}> = ({ railLabel, rail, hasSelection, children }): ReactNode => (
    <div className='flex h-full min-h-0 flex-col lg:flex-row'>
        <aside
            aria-label={railLabel}
            className={[
                'bg-rail border-divider/70 flex w-full flex-col lg:h-full lg:w-72 lg:shrink-0 lg:overflow-hidden lg:border-r',
                hasSelection ? 'hidden lg:flex' : 'flex'
            ].join(' ')}
        >
            {rail}
        </aside>
        <main
            className={[
                'min-w-0 lg:h-full lg:flex-1 lg:overflow-y-auto',
                hasSelection ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
            ].join(' ')}
        >
            {children}
        </main>
    </div>
)

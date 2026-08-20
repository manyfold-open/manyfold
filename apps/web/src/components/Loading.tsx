import type { FC, ReactNode } from 'react'
import { useLoadingGate } from '@/components/useLoadingGate'

// The sheen loading system (DESIGN.md §10.8). A Ghost mirrors the shape
// of the exact content it stands in for: the variant fixes height and
// radius to the text tier or object class it replaces, the call site
// supplies width. Ghosts are decorative — mark the *region* aria-busy.
const ghostVariantClass = {
    cap: 'h-[10px] rounded-xs',
    line: 'h-[13px] rounded-xs',
    title: 'h-[18px] rounded-xs',
    circle: 'rounded-pill',
    tile: 'rounded-sm',
    block: 'rounded-sm'
} as const

export type GhostVariant = keyof typeof ghostVariantClass

export const Ghost: FC<{
    variant?: GhostVariant
    className?: string
}> = ({ variant = 'line', className }): ReactNode => (
    <span
        aria-hidden='true'
        className={['ghost block', ghostVariantClass[variant], className]
            .filter(Boolean)
            .join(' ')}
    />
)

// Control-tier spinner: 22%-opacity track ring + 90° arc, 1.5px stroke,
// currentColor. 12 inline · 16 buttons (default) · 20 panel corners.
// Never in the middle of a content region — that is the Ghost's job.
export const Spinner: FC<{
    size?: 12 | 16 | 20
    className?: string
}> = ({ size = 16, className }): ReactNode => (
    <svg
        aria-hidden='true'
        width={size}
        height={size}
        viewBox='0 0 16 16'
        fill='none'
        className={['loading-spin shrink-0', className]
            .filter(Boolean)
            .join(' ')}
    >
        <circle
            cx='8'
            cy='8'
            r='6.5'
            stroke='currentColor'
            strokeOpacity='0.22'
            strokeWidth='1.5'
        />
        <path
            d='M8 1.5a6.5 6.5 0 0 1 6.5 6.5'
            stroke='currentColor'
            strokeWidth='1.5'
            strokeLinecap='round'
        />
    </svg>
)

// Line-tier loading verb ("Loading models…") for micro contexts:
// dropdown option areas, sidebar sub-lists, popovers.
export const SheenText: FC<{
    children: ReactNode
    className?: string
}> = ({ children, className }): ReactNode => (
    <span
        role='status'
        className={['sheen-text', className].filter(Boolean).join(' ')}
    >
        {children}
    </span>
)

// Ghost twin of `.settings-card-row` — the shared row anatomy behind
// every settings list (label + copy on the left, controls on the right).
// It lives here rather than per page because the class it mirrors is
// itself shared, so one twin keeps every settings surface in step.
const ghostRowLabel = ['w-40', 'w-28', 'w-48', 'w-36']
const ghostRowCopy = ['w-3/5', 'w-4/5', 'w-1/2', 'w-2/3']

export const GhostSettingsRows: FC<{
    rows?: number
    action?: boolean
}> = ({ rows = 3, action = true }): ReactNode => (
    <>
        {Array.from({ length: rows }, (_, row) => (
            <div key={row} className='settings-card-row'>
                <div className='min-w-0'>
                    <Ghost variant='line' className={ghostRowLabel[row % 4]} />
                    <Ghost
                        variant='cap'
                        className={['mt-2.5', ghostRowCopy[row % 4]].join(' ')}
                    />
                </div>
                {action && (
                    <div className='settings-card-side'>
                        <Ghost variant='block' className='h-9 w-20' />
                    </div>
                )}
            </div>
        ))}
    </>
)

// Rail list skeleton (§10.8): ghosts sit directly on the rail with no
// container — the rail is chrome, so wrapping pending rows in a card
// would invent a surface the loaded list does not have.
const ghostRailWidth = ['w-4/5', 'w-3/5', 'w-11/12', 'w-1/2', 'w-2/3']

export const GhostRailRows: FC<{
    rows?: number
    icon?: boolean
    className?: string
}> = ({ rows = 4, icon = false, className }): ReactNode => (
    <div aria-busy='true' className={className}>
        {Array.from({ length: rows }, (_, row) => (
            <div key={row} className='flex items-center gap-2.5 px-3 py-2.5'>
                {icon && <Ghost variant='tile' className='h-6 w-6 shrink-0' />}
                <Ghost variant='line' className={ghostRailWidth[row % 5]} />
            </div>
        ))}
    </div>
)

// Catalog detail-page skeleton — the shape every catalog detail surface
// shares (icon tile + title + tag row + a body panel). Pass `aside` for
// the layouts that carry an action rail on the right.
export const GhostCatalogDetail: FC<{ aside?: boolean }> = ({
    aside = false
}): ReactNode => {
    const body = (
        <div className='workbench-panel space-y-3 px-5 py-5'>
            <Ghost variant='line' className='w-1/4' />
            <Ghost variant='cap' className='w-full' />
            <Ghost variant='cap' className='w-11/12' />
            <Ghost variant='cap' className='w-4/5' />
            <Ghost variant='cap' className='w-2/3' />
        </div>
    )
    return (
        <div aria-busy='true'>
            <div className='mb-6 flex items-start gap-4'>
                <Ghost variant='tile' className='h-12 w-12 shrink-0' />
                <div className='min-w-0 flex-1'>
                    <Ghost variant='title' className='w-56 max-w-full' />
                    <Ghost variant='cap' className='mt-3 w-4/5' />
                    <div className='mt-3 flex gap-1.5'>
                        <Ghost variant='circle' className='h-5 w-16' />
                        <Ghost variant='circle' className='h-5 w-20' />
                    </div>
                </div>
            </div>
            {aside ? (
                <div className='grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'>
                    {body}
                    <div className='workbench-panel space-y-3 px-5 py-5'>
                        <Ghost variant='block' className='h-9 w-full' />
                        <Ghost variant='block' className='h-9 w-full' />
                        <Ghost variant='cap' className='w-3/4' />
                    </div>
                </div>
            ) : (
                body
            )}
        </div>
    )
}

// Route chunk fallback for a layout's own <Outlet> — the shared shape of
// a workbench page (title, subtitle, first panel). It stands in for the
// content area only: the surrounding chrome is already mounted and stays
// real, which is what keeps a session navigation from reading as an app
// restart. Generic on purpose, since a layout cannot know which of its
// pages is arriving. Carries its own gate because a Suspense fallback
// has no call site that could hold one.
export const GhostPageContent: FC = (): ReactNode => {
    const gate = useLoadingGate(true)
    if (!gate.showLoading) return null
    return (
        <div className='workbench-page' aria-busy='true'>
            <Ghost variant='title' className='w-52' />
            <Ghost variant='cap' className='mt-3 w-80 max-w-full' />
            <div className='workbench-panel mt-7 space-y-3 px-5 py-5'>
                <Ghost variant='line' className='w-1/3' />
                <Ghost variant='cap' className='w-4/5' />
                <Ghost variant='cap' className='w-3/5' />
            </div>
        </div>
    )
}

// Refresh signal over content that stays readable. Position it absolutely
// (or in reserved space) so its appearance never shifts layout.
export const HairlineProgress: FC<{ className?: string }> = ({
    className
}): ReactNode => (
    <div
        aria-hidden='true'
        className={['hairline-progress', className].filter(Boolean).join(' ')}
    />
)

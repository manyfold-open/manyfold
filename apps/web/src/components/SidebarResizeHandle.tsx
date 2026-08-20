import type { FC, PointerEvent as ReactPointerEvent } from 'react'

interface Props {
    direction: 'ltr' | 'rtl'
    resizing: boolean
    label: string
    onPointerDown: (event: ReactPointerEvent) => void
    onReset: () => void
}

const SidebarResizeHandle: FC<Props> = ({
    direction,
    resizing,
    label,
    onPointerDown,
    onReset
}) => (
    <div
        role='separator'
        aria-orientation='vertical'
        aria-label={label}
        onPointerDown={onPointerDown}
        onDoubleClick={onReset}
        className={[
            'group absolute inset-y-0 z-20 w-1.5 cursor-col-resize',
            direction === 'rtl' ? 'left-0' : 'right-0'
        ].join(' ')}
    >
        <div
            className={[
                'pointer-events-none absolute inset-y-0 w-px transition-colors',
                direction === 'rtl' ? 'left-0' : 'right-0',
                resizing ? 'bg-link' : 'bg-transparent group-hover:bg-link/60'
            ].join(' ')}
        />
    </div>
)

export default SidebarResizeHandle

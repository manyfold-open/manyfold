import type { MutableRefObject, ReactNode, RefObject } from 'react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'

/* Composer popovers portal to <body> per DESIGN.md §8.7. They used to be
   `absolute` panels anchored to their toolbar chip, which worked only as
   long as the chat column was tall: the column and the new-chat empty
   state are stacked overflow containers, so opening the terminal dock (a
   sibling of <main>, which is `overflow-hidden` on chat routes) shrinks
   the space above the composer and slices the top off the panel — with
   the empty state's flex centering, the cut-off part can't even be
   scrolled to. Fixed + portaled escapes every clipping ancestor, and the
   anchor hook caps the height to the space that actually exists and
   flips the panel below the chip when growing upward no longer fits. */
const ComposerMenu = ({
    align = 'start',
    anchorRef,
    children,
    className,
    open,
    panelRef
}: {
    align?: 'start' | 'end'
    anchorRef: RefObject<HTMLElement | null>
    children: ReactNode
    className: string
    open: boolean
    panelRef: MutableRefObject<HTMLDivElement | null>
}): ReactNode => {
    const [placement, setPlacement] = useState<'top' | 'bottom'>('top')
    const style = useAnchoredMenuPosition(open, anchorRef, panelRef, {
        align,
        matchAnchorWidth: false,
        onPlacement: setPlacement,
        placement: 'top'
    })

    if (!open) return null

    return createPortal(
        <div
            ref={panelRef}
            role='menu'
            data-placement={placement}
            className={[className, style ? '' : 'invisible'].join(' ')}
            style={style}
            onWheel={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
        >
            {children}
        </div>,
        document.body
    )
}

export default ComposerMenu

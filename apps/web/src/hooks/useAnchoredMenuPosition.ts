import type { CSSProperties, RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const menuGap = 6
const viewportPadding = 8
const menuMaxHeight = 288
const menuMinHeight = 96

interface AnchoredMenuPositionOptions {
    align?: 'start' | 'end'
    matchAnchorWidth?: boolean
    onPlacement?: (placement: 'top' | 'bottom') => void
    placement?: 'auto' | 'top' | 'bottom'
}

/* Fixed-position style for a dropdown menu portaled to <body> and
   anchored to a trigger element. Portaling is the only reliable way a
   menu escapes `overflow` containers (dialog bodies, scroll panels);
   this hook keeps the portaled menu glued to its trigger: optionally
   matches the trigger width, flips to the other side when the viewport
   runs out of room (`placement` is a preference, not a lock — 'top' still
   flips down when the space above is both too small and smaller than the
   space below), caps height to the available space, and stays glued to the
   anchor through scrolls, window resizes and any ancestor re-layout.
   `onPlacement` reports the side actually used, for surfaces whose
   interior has to follow the flip (a bottom-anchored submenu, an arrow).
   Returns undefined until measured — render the menu invisible until
   then so the first paint doesn't flash at (0, 0). */
export const useAnchoredMenuPosition = (
    open: boolean,
    anchorRef: RefObject<HTMLElement | null>,
    menuRef: RefObject<HTMLElement | null>,
    options: AnchoredMenuPositionOptions = {}
): CSSProperties | undefined => {
    const [style, setStyle] = useState<CSSProperties>()
    const lastAppliedRef = useRef('')
    const {
        align = 'start',
        matchAnchorWidth = true,
        onPlacement,
        placement = 'auto'
    } = options

    const update = useCallback((): void => {
        if (!anchorRef.current || !menuRef.current) return

        const anchorRect = anchorRef.current.getBoundingClientRect()
        const menuHeight = menuRef.current.scrollHeight
        const menuWidth = matchAnchorWidth
            ? anchorRect.width
            : menuRef.current.offsetWidth
        const spaceBelow =
            window.innerHeight - anchorRect.bottom - menuGap - viewportPadding
        const spaceAbove = anchorRect.top - menuGap - viewportPadding
        const openUp =
            placement === 'top'
                ? menuHeight <= spaceAbove || spaceAbove >= spaceBelow
                : placement === 'bottom'
                  ? false
                  : menuHeight > spaceBelow &&
                    spaceAbove > spaceBelow &&
                    spaceBelow < menuMaxHeight
        const maxHeight = Math.min(
            menuMaxHeight,
            Math.max(openUp ? spaceAbove : spaceBelow, menuMinHeight)
        )
        const height = Math.min(menuHeight, maxHeight)
        const alignedLeft =
            align === 'end' ? anchorRect.right - menuWidth : anchorRect.left
        const left = Math.min(
            Math.max(alignedLeft, viewportPadding),
            Math.max(
                viewportPadding,
                window.innerWidth - menuWidth - viewportPadding
            )
        )

        const top = openUp
            ? anchorRect.top - menuGap - height
            : anchorRect.bottom + menuGap
        /* update() runs on every observed layout change, so most calls resolve
           to the position already applied — bail before setState so tracking
           the anchor costs a measurement, not a re-render. */
        const applied = `${left}|${top}|${maxHeight}|${anchorRect.width}|${openUp}`
        if (applied === lastAppliedRef.current) return
        lastAppliedRef.current = applied

        setStyle({
            left,
            ...(matchAnchorWidth ? { width: anchorRect.width } : {}),
            top,
            maxHeight
        })
        onPlacement?.(openUp ? 'top' : 'bottom')
    }, [align, anchorRef, matchAnchorWidth, menuRef, onPlacement, placement])

    useLayoutEffect(() => {
        if (!open) {
            lastAppliedRef.current = ''
            setStyle(undefined)
            return
        }

        update()

        /* The anchor can move without a scroll or a window resize: dragging the
           terminal dock re-lays out the whole chat column, and a `fixed` panel
           measured at open time would visibly detach from its trigger. Nothing
           reports "an element moved", so watch the boxes the movement comes
           from — the anchor's ancestor chain. Whichever one the layout change
           flows through fires, and the panel re-measures (re-clamping its
           height and flipping side if the space above ran out mid-drag). */
        const observer = new ResizeObserver(update)
        for (
            let node: HTMLElement | null = anchorRef.current;
            node;
            node = node.parentElement
        ) {
            observer.observe(node)
        }

        window.addEventListener('resize', update)
        document.addEventListener('scroll', update, true)

        return () => {
            observer.disconnect()
            window.removeEventListener('resize', update)
            document.removeEventListener('scroll', update, true)
        }
    }, [anchorRef, open, update])

    return style
}

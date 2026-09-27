import type { FC, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react'
import { createPortal } from 'react-dom'
import { CopyButton } from '@/components/RuntimeDetailPanel'

// Opening waits as long as a tooltip does, so passing over the name on the way
// elsewhere opens nothing; closing waits long enough to cross into the panel.
const OPEN_DELAY_MS = 500
const CLOSE_DELAY_MS = 150
const GAP = 6
const MARGIN = 8

// Break opportunities after each separator that add nothing to the text: a
// zero-width space would ride along into a selection or a copy and break the
// path wherever it is pasted.
const withBreaks = (path: string): ReactNode[] =>
    path.split(/(?<=[\\/])/).map((part, index) => (
        <Fragment key={index}>
            {part}
            <wbr />
        </Fragment>
    ))

// A path named by its last folder, with the whole of it one hover or one tap
// away. A tooltip managed neither: it never opens on a touch screen, and its
// text cannot be selected because it is gone the moment the pointer leaves
// the name. This panel stays while the pointer is over the name or over
// itself, stays put once clicked or tapped, and holds the path as selectable
// text beside a copy button.
const PathPopover: FC<{
    path: string
    // What the path is, for the panel's accessible name.
    label: string
    copyLabel: string
    className?: string
    children: ReactNode
}> = ({ path, label, copyLabel, className, children }): ReactNode => {
    const [state, setState] = useState<'closed' | 'hover' | 'pinned'>('closed')
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const open = state !== 'closed'

    const clearTimer = (): void => {
        if (timer.current === null) return
        clearTimeout(timer.current)
        timer.current = null
    }
    useEffect(() => clearTimer, [])

    // Hover belongs to a mouse. A finger's pointerenter arrives with the tap,
    // and the click that follows is what answers it.
    const onEnter = (event: ReactPointerEvent): void => {
        if (event.pointerType !== 'mouse') return
        clearTimer()
        if (state === 'closed')
            timer.current = setTimeout(() => setState('hover'), OPEN_DELAY_MS)
    }
    const onLeave = (event: ReactPointerEvent): void => {
        if (event.pointerType !== 'mouse') return
        clearTimer()
        if (state === 'hover')
            timer.current = setTimeout(() => setState('closed'), CLOSE_DELAY_MS)
    }

    const place = useCallback((): void => {
        const trigger = triggerRef.current?.getBoundingClientRect()
        if (!trigger) return
        const width = panelRef.current?.getBoundingClientRect().width ?? 0
        setPos({
            left: Math.max(
                MARGIN,
                Math.min(trigger.left, window.innerWidth - MARGIN - width)
            ),
            top: trigger.bottom + GAP
        })
    }, [])

    useLayoutEffect(() => {
        if (!open) {
            setPos(null)
            return
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
            window.removeEventListener('resize', place)
            window.removeEventListener('scroll', place, true)
        }
    }, [open, place])

    useEffect(() => {
        if (!open) return
        const onDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                triggerRef.current?.contains(target) ||
                panelRef.current?.contains(target)
            )
                return
            setState('closed')
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            setState('closed')
            triggerRef.current?.focus()
        }
        document.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <>
            <button
                ref={triggerRef}
                type='button'
                aria-haspopup='dialog'
                aria-expanded={open}
                onClick={() => {
                    clearTimer()
                    setState((prev) => (prev === 'pinned' ? 'closed' : 'pinned'))
                }}
                onPointerEnter={onEnter}
                onPointerLeave={onLeave}
                className={className}
            >
                {children}
            </button>
            {open && typeof document !== 'undefined'
                ? createPortal(
                      // z-[110] with the menus, under the tooltip layer, so
                      // the copy button's own hint still shows above it.
                      <div
                          ref={panelRef}
                          role='dialog'
                          aria-label={label}
                          onPointerEnter={onEnter}
                          onPointerLeave={onLeave}
                          // Pressing inside pins it: a selection dragged past
                          // the edge must not close the panel under it.
                          onPointerDown={() => {
                              clearTimer()
                              setState('pinned')
                          }}
                          className='bg-surface-elevated shadow-elevated text-caption fixed z-[110] flex max-w-[min(24rem,calc(100vw-1rem))] items-start gap-2 rounded-md py-2 pl-3 pr-2'
                          style={
                              pos === null
                                  ? { left: 0, top: 0, visibility: 'hidden' }
                                  : { left: pos.left, top: pos.top }
                          }
                      >
                          <span className='text-fg min-w-0 select-text py-0.5 font-mono leading-5'>
                              {withBreaks(path)}
                          </span>
                          <CopyButton value={path} label={copyLabel} />
                      </div>,
                      document.body
                  )
                : null}
        </>
    )
}

export default PathPopover

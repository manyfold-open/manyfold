import type { FC, ReactNode } from 'react'
import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react'
import { createPortal } from 'react-dom'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { StatusTag } from '@/components/Tag'
import { HelpIcon } from '@/components/icons'
import { sandboxStatusLegend } from '@/lib/hostStatus'
import { useI18n } from '@/lib/i18n'

const GAP = 6
const MARGIN = 8

// The "?" beside a sandbox's badge: every badge it can show, with what each
// one means. It opens on a click rather than a hover so a phone can open it,
// and it holds more than a tooltip should.
const SandboxStatusHelp: FC = (): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{
        left: number
        top: number
        maxHeight: number
    } | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const title = t('web.hostStatus.sandboxLegend.title')

    // Below the button and never past the viewport: wider than a phone it
    // keeps its width and slides left; taller than the space below it scrolls.
    const place = useCallback((): void => {
        const trigger = triggerRef.current?.getBoundingClientRect()
        if (!trigger) return
        const width = panelRef.current?.getBoundingClientRect().width ?? 0
        const top = trigger.bottom + GAP
        setPos({
            left: Math.max(
                MARGIN,
                Math.min(trigger.left, window.innerWidth - MARGIN - width)
            ),
            top,
            maxHeight: window.innerHeight - top - MARGIN
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
            setOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            setOpen(false)
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
            <ShortcutTooltip
                label={t('web.hostStatus.sandboxLegend.button')}
                disabled={open}
                className='shrink-0'
            >
                <button
                    ref={triggerRef}
                    type='button'
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    aria-label={t('web.hostStatus.sandboxLegend.button')}
                    onClick={() => setOpen((prev) => !prev)}
                    className={[
                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
                        open
                            ? 'bg-surface-hover text-fg'
                            : 'text-subtle hover:bg-surface-hover'
                    ].join(' ')}
                >
                    <HelpIcon aria-hidden='true' className='h-3.5 w-3.5' />
                </button>
            </ShortcutTooltip>
            {open && typeof document !== 'undefined'
                ? createPortal(
                      // z-[110] with the menus and popovers, under tooltips.
                      <div
                          ref={panelRef}
                          role='dialog'
                          aria-label={title}
                          className='bg-surface-elevated shadow-elevated fixed z-[110] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md p-3.5'
                          style={
                              pos === null
                                  ? { left: 0, top: 0, visibility: 'hidden' }
                                  : {
                                        left: pos.left,
                                        top: pos.top,
                                        maxHeight: pos.maxHeight
                                    }
                          }
                      >
                          <p className='text-ui text-fg font-medium'>{title}</p>
                          <p className='text-caption text-muted mt-1 leading-relaxed'>
                              {t('web.hostStatus.sandboxLegend.intro')}
                          </p>
                          <dl className='mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-2.5'>
                              {sandboxStatusLegend().map((entry) => (
                                  <Fragment key={entry.label}>
                                      <dt>
                                          <StatusTag
                                              tone={entry.tone}
                                              label={entry.label}
                                          />
                                      </dt>
                                      <dd className='text-caption text-muted leading-relaxed'>
                                          {entry.meaning}
                                      </dd>
                                  </Fragment>
                              ))}
                          </dl>
                      </div>,
                      document.body
                  )
                : null}
        </>
    )
}

export default SandboxStatusHelp

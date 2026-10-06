import type { FC, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ClaudeCodeColor, CodexColor } from '@/lib/brandIcons'
import { useI18n } from '@/lib/i18n'
import { useAgentSetupPrompt } from '@/lib/useAgentSetupPrompt'

const PANEL_MAX_WIDTH = 452
// The open panel keeps ProductDialog's spacing (DESIGN.md §8.11): 20px on
// every side, 6px between the title and the line under it.
const PANEL_INSET = 20
const TITLE_GAP = 6
const VIEWPORT_GUTTER = 16
// The landing's phone breakpoint (styles.css). There the panel spans the
// screen between gutters, so it fully covers the buttons it rises over
// rather than sharing an edge with them.
const NARROW_QUERY = '(max-width: 720px)'

// The hero's second door: the same prompt the workspace's "Use Manyfold in
// your agent" dialog hands out. It opens in place: the button's own frame
// grows into the panel, so a button never sits under a popover with its
// corner showing. The label and marks stay where they were and become the
// panel's title.
const UseInAgentCta: FC = (): ReactNode => {
    const { t } = useI18n()
    const { prompt, guideUrl, promptRef, copied, copy } = useAgentSetupPrompt()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const headRef = useRef<HTMLButtonElement | null>(null)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const copyRef = useRef<HTMLButtonElement | null>(null)
    const openedByKeyboard = useRef(false)
    const bodyId = useId()

    // The frame animates to explicit sizes, so measure what it opens to. The
    // hero is a pinned scene that the next scroll replaces, so the whole panel
    // has to fit on screen as opened: when the room below the button runs
    // out, title and frame rise together, and on a very short screen the
    // body scrolls instead. The label slides from the button's inset to the
    // panel's, so the panel reads with the same padding on all four sides.
    useLayoutEffect(() => {
        const root = rootRef.current
        const head = headRef.current
        const body = bodyRef.current
        const label = head?.firstChild
        if (!open || !root || !head || !body || !label) return
        const rect = root.getBoundingClientRect()
        // Offsets within the head are differences of two boxes that share
        // the head's transform, so they hold even while it is mid-slide.
        const range = document.createRange()
        range.selectNodeContents(label)
        const labelBox = range.getBoundingClientRect()
        const headBox = head.getBoundingClientRect()
        // Inset to the line box, not the glyph box, the way CSS padding
        // measures every other side.
        const lineHeight =
            parseFloat(getComputedStyle(head).lineHeight) || labelBox.height
        const labelLeft = labelBox.left - headBox.left
        const labelTop =
            labelBox.top - headBox.top + (labelBox.height - lineHeight) / 2
        const bodyTop = PANEL_INSET + lineHeight + TITLE_GAP
        const narrow = window.matchMedia(NARROW_QUERY).matches
        const left = narrow ? VIEWPORT_GUTTER - rect.left : 0
        const width = narrow
            ? window.innerWidth - 2 * VIEWPORT_GUTTER
            : Math.max(
                  head.offsetWidth,
                  Math.min(
                      PANEL_MAX_WIDTH,
                      window.innerWidth - rect.left - VIEWPORT_GUTTER
                  )
              )
        // Width first: the body wraps to it, and its height is read next.
        root.style.setProperty('--lp-agent-left', `${left}px`)
        root.style.setProperty('--lp-agent-open-w', `${width}px`)
        // Read the body's natural height with its cap lifted: capped from a
        // previous opening, it would scroll, and the scrollbar would narrow
        // the text and make it taller than it is.
        body.style.maxHeight = 'none'
        const bodyHeight = body.scrollHeight
        body.style.maxHeight = ''
        const height = Math.min(
            bodyTop + bodyHeight,
            window.innerHeight - 2 * VIEWPORT_GUTTER
        )
        const rise = Math.max(
            Math.min(
                0,
                window.innerHeight - VIEWPORT_GUTTER - (rect.top + height)
            ),
            VIEWPORT_GUTTER - rect.top
        )
        root.style.setProperty('--lp-agent-open-h', `${height}px`)
        root.style.setProperty('--lp-agent-rise', `${rise}px`)
        root.style.setProperty('--lp-agent-body-top', `${bodyTop}px`)
        root.style.setProperty('--lp-agent-title-h', `${lineHeight}px`)
        root.style.setProperty(
            '--lp-agent-title-x',
            `${left + PANEL_INSET - labelLeft}px`
        )
        root.style.setProperty(
            '--lp-agent-title-y',
            `${rise + PANEL_INSET - labelTop}px`
        )
    }, [open, prompt])

    useEffect(() => {
        if (!open) return
        // Only a keyboard opening hands focus to Copy: after a click, moving
        // it there would ring the button the pointer never touched.
        if (openedByKeyboard.current)
            copyRef.current?.focus({ preventScroll: true })
        const onPointerDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            setOpen(false)
            headRef.current?.focus()
        }
        // A scroll moves the page to the next scene, which fades this one out.
        const onScroll = (): void => setOpen(false)
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('scroll', onScroll)
        }
    }, [open])

    const close = (): void => {
        setOpen(false)
        headRef.current?.focus()
    }

    return (
        <div ref={rootRef} className='lp-agent' data-open={open || undefined}>
            <button
                ref={headRef}
                type='button'
                className='lp-btn lp-agent-head'
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={(event) => {
                    // A click from Enter or Space reports no pointer clicks.
                    openedByKeyboard.current = event.detail === 0
                    setOpen((value) => !value)
                }}
            >
                {t('web.landing.useInAgentCta')}
                <span className='lp-agent-marks' aria-hidden='true'>
                    <ClaudeCodeColor size={16} />
                    <CodexColor size={16} />
                </span>
            </button>
            <div className='lp-agent-frame'>
                <button
                    type='button'
                    className='lp-agent-close'
                    aria-label={t('common.close')}
                    onClick={close}
                >
                    <X />
                </button>
                <div ref={bodyRef} id={bodyId} className='lp-agent-body'>
                    <p className='lp-agent-desc'>
                        {t('web.useInAgent.description')}{' '}
                        <a href={guideUrl} target='_blank' rel='noreferrer'>
                            {t('web.landing.useInAgentSteps')}
                        </a>
                    </p>
                    <p ref={promptRef} dir='auto' className='lp-agent-prompt'>
                        {prompt}
                    </p>
                    <div className='lp-agent-foot'>
                        <span>{t('web.useInAgent.hint')}</span>
                        <button
                            ref={copyRef}
                            type='button'
                            className='lp-btn lp-btn-primary lp-agent-copy'
                            onClick={() => {
                                void copy()
                            }}
                        >
                            {copied ? t('common.copied') : t('common.copy')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default UseInAgentCta

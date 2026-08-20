import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@manyfold/i18n'
import { CheckIcon, ChevronDownIcon } from '@/components/icons'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'

export type WorkbenchSelectOption = {
    value: string
    label: ReactNode
    disabled?: boolean
    group?: string
}

/* The one dropdown-select for the product. Trigger is a short boxed
   control (Sm 10, ring + focus shadow — DESIGN.md §6.1/§8.6); the open
   menu is a `.popover-panel` (Md 14, elevated, canonical px-2.5 py-1.5
   rows — §8.7) with the popover-tier selection language (§8.12): the
   chosen row is a check + `text-fg font-medium`, and `bg-soft` belongs
   to hover alone, so the pointer's position is never ambiguous inside a
   transient menu. Opening by mouse leaves the trigger untouched — the
   panel is the open-state signal; the focus ring is `focus-visible` and
   serves keyboard traversal only.
   The `bare` variant drops the box but NOT the focus ring (§8.9 — an
   `outline-none` with no replacement strands keyboard users). It wears
   the same `--shadow-focus` at Xs 8 with `py-0.5 -my-0.5`: the padding
   keeps the corner near ⅓ of the ring's height instead of reading as a
   failed pill, and the negative margin cancels it again so the row it
   sits in does not change height. Its hover moves the chevron, not the
   label, because the label already rests at `--color-fg`.
   Native `<select>` renders the OS menu, which can't follow any of
   this — never use it in product UI.
   The menu portals to <body> with fixed positioning so it can never be
   clipped by dialog/panel overflow containers; it flips above the
   trigger when the viewport runs out of room below. */
const WorkbenchSelect: FC<{
    ariaLabel?: string
    bare?: boolean
    className?: string
    disabled?: boolean
    id?: string
    menuClassName?: string
    mono?: boolean
    onChange: (value: string) => void
    options: WorkbenchSelectOption[]
    placeholder?: string
    size?: 'md' | 'sm'
    // 'soft' is the filled chip register used in compact toolbars (the
    // automation composer footer), where every control is a chip; 'plain' is
    // the ringed form control used in panels and settings rows.
    tone?: 'plain' | 'soft'
    value: string
}> = ({
    ariaLabel,
    bare = false,
    className = '',
    disabled = false,
    id,
    menuClassName = '',
    mono = false,
    onChange,
    options,
    placeholder = t('web.workbenchSelect.placeholder'),
    size = 'md',
    tone = 'plain',
    value
}): ReactNode => {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const menuStyle = useAnchoredMenuPosition(open, rootRef, menuRef)
    const selected = options.find((option) => option.value === value)

    const grouped = useMemo(() => {
        const sections: Array<{
            group: string | null
            items: WorkbenchSelectOption[]
        }> = []
        for (const option of options) {
            const group = option.group ?? null
            const last = sections[sections.length - 1]
            if (last && last.group === group) {
                last.items.push(option)
            } else {
                sections.push({ group, items: [option] })
            }
        }
        return sections
    }, [options])

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !rootRef.current?.contains(target) &&
                !menuRef.current?.contains(target)
            ) {
                setOpen(false)
            }
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    return (
        <div ref={rootRef} className={['relative', className].join(' ')}>
            <button
                type='button'
                id={id}
                disabled={disabled}
                aria-label={ariaLabel}
                aria-haspopup='listbox'
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
                className={[
                    bare
                        ? 'text-fg text-ui focus-visible:shadow-focus rounded-xs group -my-0.5 flex w-full min-w-0 items-center justify-between gap-2 py-0.5 text-left transition-[color,box-shadow] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'
                        : tone === 'soft'
                          ? 'text-fg bg-soft hover:bg-surface-hover focus-visible:shadow-focus flex w-full min-w-0 items-center justify-between rounded-sm text-left font-medium transition-[color,background-color,box-shadow] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'
                          : 'text-fg shadow-ring-light bg-surface hover:bg-surface-hover focus-visible:shadow-focus flex w-full min-w-0 items-center justify-between rounded-sm text-left transition-[color,background-color,box-shadow] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                    bare
                        ? ''
                        : size === 'sm'
                          ? 'text-caption h-8 gap-1.5 px-2.5'
                          : 'text-ui h-10 gap-2 px-3.5',
                    mono ? 'font-mono' : ''
                ].join(' ')}
            >
                <span
                    className={[
                        'min-w-0 flex-1 truncate',
                        selected ? '' : 'text-placeholder'
                    ].join(' ')}
                >
                    {selected ? selected.label : placeholder}
                </span>
                <ChevronDownIcon
                    className={
                        bare
                            ? 'text-subtle group-hover:text-muted h-4 w-4 shrink-0 transition-colors'
                            : 'text-subtle h-4 w-4 shrink-0'
                    }
                />
            </button>

            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        data-workbench-select-menu=''
                        role='listbox'
                        aria-label={ariaLabel}
                        className={[
                            'popover-panel bg-surface-elevated shadow-elevated fixed z-[110] overflow-auto overscroll-contain rounded-md p-1',
                            menuStyle ? '' : 'invisible',
                            menuClassName
                        ].join(' ')}
                        style={menuStyle}
                        onWheel={(event) => event.stopPropagation()}
                        onTouchMove={(event) => event.stopPropagation()}
                    >
                        {grouped.flatMap((section, index) => [
                            ...(section.group
                                ? [
                                      <div
                                          key={`group-${section.group}-${index}`}
                                          className='text-caption text-placeholder px-2.5 pb-0.5 pt-1.5 font-medium'
                                      >
                                          {section.group}
                                      </div>
                                  ]
                                : []),
                            ...section.items.map((option) => {
                                const active = option.value === value

                                return (
                                    <button
                                        key={option.value}
                                        type='button'
                                        role='option'
                                        aria-selected={active}
                                        disabled={option.disabled}
                                        onClick={() => {
                                            onChange(option.value)
                                            setOpen(false)
                                        }}
                                        className={[
                                            'text-ui hover:bg-soft hover:text-fg flex w-full items-center justify-between gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                            mono ? 'font-mono' : '',
                                            active
                                                ? 'text-fg font-medium'
                                                : 'text-muted'
                                        ].join(' ')}
                                    >
                                        <span className='min-w-0 flex-1 truncate'>
                                            {option.label}
                                        </span>
                                        {active && (
                                            <CheckIcon className='text-link h-3.5 w-3.5 shrink-0' />
                                        )}
                                    </button>
                                )
                            })
                        ])}
                    </div>,
                    document.body
                )}
        </div>
    )
}

export default WorkbenchSelect

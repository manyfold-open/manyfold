import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AutomationSchedulePreset } from '@manyfold/shared'
import { AutomationsIcon, ChevronDownIcon } from '@/components/icons'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { useI18n } from '@/lib/i18n'
import {
    buildPresetRrule,
    describeRrule,
    presetLabel,
    scheduleLabel,
    schedulePresets,
    weekdayOptions
} from './automationSchedule'

interface SchedulePickerProps {
    align?: 'start' | 'end'
    className?: string
    placement?: 'top' | 'bottom'
    preset: AutomationSchedulePreset
    rrule: string
    time: string
    // 'chip' matches the filled controls of the composer footer; 'select'
    // matches the ringed WorkbenchSelect rows it sits beside in a panel.
    variant?: 'chip' | 'select'
    weekday: string
    onPresetChange: (value: AutomationSchedulePreset) => void
    onRruleChange: (value: string) => void
    onTimeChange: (value: string) => void
    onWeekdayChange: (value: string) => void
}

const SchedulePicker: FC<SchedulePickerProps> = ({
    align = 'start',
    className = '',
    placement = 'bottom',
    preset,
    rrule,
    time,
    variant = 'chip',
    weekday,
    onPresetChange,
    onRruleChange,
    onTimeChange,
    onWeekdayChange
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    // Portalled: the sidebar cards clip their overflow, so an absolutely
    // positioned panel would be cut off at the card edge.
    const menuStyle = useAnchoredMenuPosition(open, rootRef, menuRef, {
        align,
        matchAnchorWidth: false,
        placement
    })

    useEffect(() => {
        if (!open) return

        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (rootRef.current?.contains(target)) return
            if (menuRef.current?.contains(target)) return
            if (
                target instanceof Element &&
                target.closest('[data-workbench-select-menu]')
            )
                return
            setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    const changePreset = (next: AutomationSchedulePreset): void => {
        onPresetChange(next)
        if (next !== 'custom')
            onRruleChange(buildPresetRrule(next, time, weekday))
    }

    const changeTime = (next: string): void => {
        onTimeChange(next)
        if (preset !== 'custom')
            onRruleChange(buildPresetRrule(preset, next, weekday))
    }

    const changeWeekday = (next: string): void => {
        onWeekdayChange(next)
        if (preset === 'weekly')
            onRruleChange(buildPresetRrule(preset, time, next))
    }

    const chip = variant === 'chip'

    return (
        <div
            ref={rootRef}
            className={[
                chip ? 'relative inline-flex min-w-0' : 'relative',
                className
            ]
                .join(' ')
                .trim()}
        >
            <button
                type='button'
                aria-haspopup='dialog'
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
                className={
                    chip
                        ? 'text-ui text-fg bg-soft hover:bg-surface-hover focus-visible:shadow-focus inline-flex h-10 max-w-full items-center gap-2 rounded-sm px-3.5 font-medium transition-[color,background-color,box-shadow] focus:outline-none'
                        : 'text-caption text-fg shadow-ring-light bg-surface hover:bg-surface-hover focus-visible:shadow-focus flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-sm px-2.5 text-left transition-[color,background-color,box-shadow] focus:outline-none'
                }
            >
                {chip && (
                    <AutomationsIcon className='text-subtle h-4 w-4 shrink-0' />
                )}
                <span className={chip ? 'truncate' : 'min-w-0 flex-1 truncate'}>
                    {scheduleLabel(preset, rrule)}
                </span>
                <ChevronDownIcon className='text-subtle h-4 w-4 shrink-0' />
            </button>

            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        role='dialog'
                        aria-label={t('web.automations.schedule')}
                        className={[
                            'popover-panel shadow-elevated bg-surface-elevated fixed z-[110] rounded-md p-1 text-left backdrop-blur',
                            preset === 'custom'
                                ? 'w-[min(34rem,calc(100vw-2rem))]'
                                : 'w-[min(17rem,calc(100vw-2rem))]',
                            menuStyle ? '' : 'invisible'
                        ].join(' ')}
                        style={menuStyle}
                    >
                        <div className='text-body text-placeholder px-2.5 pb-2 pt-1.5 font-medium'>
                            {t('web.automations.schedule')}
                        </div>
                        <div className='space-y-1.5'>
                            <WorkbenchSelect
                                ariaLabel={t('web.automations.schedulePreset')}
                                value={preset}
                                onChange={(next) =>
                                    changePreset(
                                        next as AutomationSchedulePreset
                                    )
                                }
                                options={schedulePresets.map((option) => ({
                                    value: option,
                                    label: presetLabel(option)
                                }))}
                            />

                            {preset === 'weekly' && (
                                <WorkbenchSelect
                                    ariaLabel={t('web.automations.repeatDay')}
                                    value={weekday}
                                    onChange={changeWeekday}
                                    options={weekdayOptions.map((option) => ({
                                        value: option.code,
                                        label: t(option.labelKey)
                                    }))}
                                />
                            )}

                            {preset !== 'hourly' && preset !== 'custom' && (
                                <div className='relative'>
                                    <input
                                        aria-label={t(
                                            'web.automations.scheduleTime'
                                        )}
                                        type='time'
                                        value={time}
                                        onChange={(event) =>
                                            changeTime(event.target.value)
                                        }
                                        className={`${fieldClass} pr-10 [&::-webkit-calendar-picker-indicator]:opacity-0`}
                                    />
                                    <AutomationsIcon className='text-placeholder pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2' />
                                </div>
                            )}

                            {preset === 'custom' && (
                                <CustomRrule
                                    rrule={rrule}
                                    onRruleChange={onRruleChange}
                                />
                            )}
                        </div>
                    </div>,
                    document.body
                )}
        </div>
    )
}

// A hand-typed rule is read back in plain language on every keystroke, so a
// typo surfaces here instead of at save time.
const CustomRrule: FC<{
    rrule: string
    onRruleChange: (value: string) => void
}> = ({ rrule, onRruleChange }): ReactNode => {
    const { t } = useI18n()
    const described = describeRrule(rrule)

    return (
        <>
            <input
                aria-label={t('web.automations.customRrule')}
                value={rrule}
                onChange={(event) => onRruleChange(event.target.value)}
                className={
                    described.ok
                        ? `${fieldClass} font-mono`
                        : `${fieldClass} border-error font-mono`
                }
            />
            <div className='flex items-start gap-2 px-1 pb-1 pt-0.5'>
                {described.ok ? (
                    <>
                        <AutomationsIcon className='text-placeholder mt-0.5 h-3.5 w-3.5 shrink-0' />
                        <span className='text-ui text-fg font-medium'>
                            {described.text}
                        </span>
                    </>
                ) : (
                    <span className='text-ui text-error'>
                        {described.message}
                    </span>
                )}
            </div>
        </>
    )
}

const fieldClass =
    'border-divider text-ui text-fg focus:border-focus bg-surface block h-10 w-full rounded-md border px-3 outline-none transition-colors'

export default SchedulePicker

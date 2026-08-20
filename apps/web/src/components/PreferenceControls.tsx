import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Language } from '@manyfold/i18n'
import {
    ChevronDownIcon,
    GlobeIcon,
    type LucideIcon,
    MoonIcon,
    SunIcon
} from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { languageOptions, useI18n } from '@/lib/i18n'
import type { ThemeMode } from '@/lib/theme'
import { useTheme } from '@/lib/theme'

type ControlTone = 'surface' | 'inverse'

const dotClass = (active: boolean): string =>
    ['h-2 w-2 shrink-0 rounded-full', active ? 'bg-link' : 'bg-divider'].join(
        ' '
    )

const segmentButtonClass = (active: boolean): string =>
    [
        'inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-sm px-3 text-ui font-medium transition-colors',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'text-muted hover:bg-surface-hover'
    ].join(' ')

const controlButtonClass = (tone: ControlTone, open = false): string =>
    [
        'focus-visible:shadow-focus inline-flex h-9 items-center justify-center gap-2 rounded-sm text-ui font-medium transition-[color,background-color,box-shadow] focus:outline-none',
        tone === 'inverse'
            ? 'bg-white/10 text-white shadow-[rgba(255,255,255,0.22)_0_0_0_1px] hover:bg-white/[0.15]'
            : 'bg-surface text-fg shadow-ring-light hover:bg-surface-hover',
        open && tone === 'inverse' ? 'bg-white/[0.15]' : '',
        open && tone === 'surface' ? 'shadow-card' : ''
    ].join(' ')

const themeOptions: Array<{
    icon: LucideIcon
    labelKey: string
    value: ThemeMode
}> = [
    { icon: SunIcon, labelKey: 'web.general.themeLight', value: 'light' },
    { icon: MoonIcon, labelKey: 'web.general.themeDark', value: 'dark' }
]

export const LanguageSelect: FC<{
    compact?: boolean
    language: Language
    menuAlign?: 'left' | 'right'
    onChange: (language: Language) => void
    tone?: ControlTone
}> = ({
    compact = false,
    language,
    menuAlign = 'left',
    onChange,
    tone = 'surface'
}): ReactNode => {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const { t } = useI18n()
    const selected =
        languageOptions.find((option) => option.code === language) ??
        languageOptions[0]

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) {
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
        <div
            ref={rootRef}
            className={compact ? 'relative z-30' : 'relative z-20 max-w-sm'}
        >
            <ShortcutTooltip
                label={t('web.settingsMenu.language')}
                className={compact ? undefined : 'w-full'}
            >
                <button
                    type='button'
                    aria-label={t('web.settingsMenu.language')}
                    aria-haspopup='listbox'
                    aria-expanded={open}
                    onClick={() => setOpen((current) => !current)}
                    className={[
                        controlButtonClass(tone, open),
                        compact
                            ? 'w-9 px-0 sm:w-40 sm:justify-between sm:px-3'
                            : 'h-12 w-full justify-between px-4 text-left'
                    ].join(' ')}
                >
                    {compact && (
                        <GlobeIcon className='h-4 w-4 shrink-0 sm:hidden' />
                    )}
                    <span
                        className={
                            compact
                                ? 'hidden min-w-0 sm:block'
                                : 'flex min-w-0 flex-1 items-center gap-3'
                        }
                    >
                        <span className='block min-w-0 truncate'>
                            {selected.nativeName}
                        </span>
                        {!compact && (
                            <span className='text-caption text-subtle ml-auto block max-w-[50%] shrink-0 truncate text-right'>
                                {selected.englishName}
                            </span>
                        )}
                    </span>
                    <ChevronDownIcon
                        className={[
                            'h-4 w-4 shrink-0',
                            tone === 'inverse' ? 'text-white/70' : 'text-subtle',
                            compact ? 'hidden sm:block' : ''
                        ].join(' ')}
                    />
                </button>
            </ShortcutTooltip>

            {open && (
                <div
                    role='listbox'
                    aria-label={t('web.settingsMenu.language')}
                    className={[
                        'popover-panel bg-surface-elevated shadow-elevated absolute top-[calc(100%+0.5rem)] z-30 max-h-72 overflow-auto rounded-md p-1',
                        compact
                            ? 'w-64 max-w-[calc(100vw-2rem)]'
                            : 'right-0 left-0',
                        compact && menuAlign === 'right' ? 'right-0' : '',
                        compact && menuAlign === 'left' ? 'left-0' : ''
                    ].join(' ')}
                >
                    {languageOptions.map((option) => {
                        const active = option.code === language

                        return (
                            <button
                                key={option.code}
                                type='button'
                                role='option'
                                aria-selected={active}
                                onClick={() => {
                                    onChange(option.code)
                                    setOpen(false)
                                }}
                                className={[
                                    'hover:bg-soft hover:text-fg flex w-full items-center justify-between gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors',
                                    active
                                        ? 'text-fg font-medium'
                                        : 'text-muted'
                                ].join(' ')}
                            >
                                <span className='flex min-w-0 flex-1 items-center gap-3'>
                                    <span className='text-ui block min-w-0 truncate font-medium'>
                                        {option.nativeName}
                                    </span>
                                    <span className='text-caption text-subtle ml-auto block max-w-[50%] shrink-0 truncate text-right'>
                                        {option.englishName}
                                    </span>
                                </span>
                                <span
                                    className={dotClass(active)}
                                    aria-hidden='true'
                                />
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

const ThemeToggleButton: FC<{
    tone?: ControlTone
}> = ({ tone = 'surface' }): ReactNode => {
    const { t } = useI18n()
    const { theme, toggleTheme } = useTheme()
    const Icon = theme === 'dark' ? MoonIcon : SunIcon
    const currentLabel =
        theme === 'dark'
            ? t('web.general.themeDark')
            : t('web.general.themeLight')

    return (
        <ShortcutTooltip label={currentLabel}>
            <button
                type='button'
                aria-label={`${t('web.general.themeTitle')}: ${currentLabel}`}
                onClick={toggleTheme}
                className={[controlButtonClass(tone), 'w-9 px-0'].join(' ')}
            >
                <Icon className='h-4 w-4' />
            </button>
        </ShortcutTooltip>
    )
}

export const ThemeSegmentedControl: FC = (): ReactNode => {
    const { t } = useI18n()
    const { setTheme, theme } = useTheme()

    return (
        <div
            role='group'
            aria-label={t('web.general.themeTitle')}
            className='bg-soft shadow-ring-light flex gap-1 rounded-md p-1'
        >
            {themeOptions.map((option) => {
                const Icon = option.icon
                const active = theme === option.value

                return (
                    <button
                        key={option.value}
                        type='button'
                        aria-pressed={active}
                        onClick={() => setTheme(option.value)}
                        className={segmentButtonClass(active)}
                    >
                        <Icon className='h-3.5 w-3.5 shrink-0' />
                        {t(option.labelKey)}
                    </button>
                )
            })}
        </div>
    )
}

export const PreferenceControls: FC<{
    className?: string
    languageMenuAlign?: 'left' | 'right'
    tone?: ControlTone
}> = ({
    className = '',
    languageMenuAlign = 'right',
    tone = 'surface'
}): ReactNode => {
    const { language, setLanguage } = useI18n()

    return (
        <div className={['flex items-center gap-2', className].join(' ')}>
            <ThemeToggleButton tone={tone} />
            <LanguageSelect
                compact
                language={language}
                menuAlign={languageMenuAlign}
                onChange={setLanguage}
                tone={tone}
            />
        </div>
    )
}

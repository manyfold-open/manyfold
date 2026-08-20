import type { FC, ReactNode } from 'react'
import {
    LanguageSelect,
    ThemeSegmentedControl
} from '@/components/PreferenceControls'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import type { FontSizeMode } from '@/lib/fontSize'
import { useFontSize } from '@/lib/fontSize'
import { useI18n } from '@/lib/i18n'

const optionButtonClass = (active: boolean): string =>
    [
        'flex min-h-16 w-full items-center justify-between gap-3 rounded-md px-3.5 py-3 text-left transition-colors',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'bg-soft text-muted shadow-ring-light hover:bg-surface-hover'
    ].join(' ')

const dotClass = (active: boolean): string =>
    ['h-2 w-2 shrink-0 rounded-full', active ? 'bg-link' : 'bg-divider'].join(
        ' '
    )

const fontSizeOptions: Array<{
    hintKey: string
    labelKey: string
    sampleClass: string
    value: FontSizeMode
}> = [
    {
        hintKey: 'web.general.fontSizeCompactHint',
        labelKey: 'web.general.fontSizeCompact',
        sampleClass: 'text-caption',
        value: 'compact'
    },
    {
        hintKey: 'web.general.fontSizeDefaultHint',
        labelKey: 'web.general.fontSizeDefault',
        sampleClass: 'text-ui',
        value: 'default'
    },
    {
        hintKey: 'web.general.fontSizeLargeHint',
        labelKey: 'web.general.fontSizeLarge',
        sampleClass: 'text-body',
        value: 'large'
    }
]

const General: FC = (): ReactNode => {
    const { fontSize, setFontSize } = useFontSize()
    const { language, setLanguage, t } = useI18n()

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                title={t('web.general.title')}
                description={t('web.general.subtitle')}
            />
            <section className='settings-section relative z-20'>
                <div className='settings-card overflow-visible p-5'>
                    <div className='settings-card-label'>
                        {t('web.general.languageTitle')}
                    </div>
                    <p className='settings-card-copy'>
                        {t('web.general.languageBody')}
                    </p>
                    <div className='mt-4'>
                        <LanguageSelect
                            language={language}
                            onChange={setLanguage}
                        />
                    </div>
                </div>
            </section>

            <section className='settings-section'>
                <div className='settings-card p-5'>
                    <div className='grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem] md:items-center'>
                        <div>
                            <div className='settings-card-label'>
                                {t('web.general.themeTitle')}
                            </div>
                            <p className='settings-card-copy'>
                                {t('web.general.themeBody')}
                            </p>
                        </div>
                        <ThemeSegmentedControl />
                    </div>
                </div>
            </section>

            <section className='settings-section'>
                <div className='settings-card p-5'>
                    <div className='settings-card-label'>
                        {t('web.general.fontSizeTitle')}
                    </div>
                    <p className='settings-card-copy'>
                        {t('web.general.fontSizeBody')}
                    </p>
                    <div className='mt-4 grid gap-2 md:grid-cols-3'>
                        {fontSizeOptions.map((option) => {
                            const active = fontSize === option.value

                            return (
                                <button
                                    key={option.value}
                                    type='button'
                                    aria-pressed={active}
                                    onClick={() => setFontSize(option.value)}
                                    className={optionButtonClass(active)}
                                >
                                    <span className='min-w-0'>
                                        <span
                                            className={[
                                                option.sampleClass,
                                                'block truncate font-medium'
                                            ].join(' ')}
                                        >
                                            {t(option.labelKey)}
                                        </span>
                                        <span className='text-caption text-subtle mt-0.5 block truncate'>
                                            {t(option.hintKey)}
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
                </div>
            </section>
        </div>
    )
}

export default General

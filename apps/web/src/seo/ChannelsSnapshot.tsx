import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import {
    CHANNEL_STEP_KEYS,
    CHANNEL_SYNC_POINTS,
    CHANNEL_TILE_GROUPS,
    channelTileLabel
} from '@/seo/channelsContent'
import { SeoClosingCta } from '@/seo/SeoClosingCta'
import type { SeoPageEntry } from '@/seo/pages'

// The no-JS view of /channels and /zh/channels: the same four screens the
// interactive page argues, in the same order, from the same keys and the same
// content tables. It used to be the home page's snapshot — every manifest
// page rendered LandingSnapshot — which meant two URLs served one body under
// two different headlines, and neither `/channels` document said anything
// about channels. Only rendered at build time; the renderer calls
// setLanguage() first, so the module-level t() resolves the right dictionary.
export const ChannelsSnapshot: FC<{ entry: SeoPageEntry }> = ({
    entry
}): ReactNode => {
    const { copy } = entry
    return (
        <main className='seo-main'>
            <section className='lp-section seo-hero'>
                <div className='lp-container'>
                    <p className='lp-eyebrow'>
                        {t('web.channelsPage.heroEyebrow')}
                    </p>
                    <h1 className='lp-h1'>{copy.h1}</h1>
                    <p className='lp-lead'>{copy.lead}</p>
                    <div className='seo-ctas'>
                        <a
                            className='lp-btn lp-btn-primary'
                            href={copy.ctaPrimary.href}
                        >
                            {copy.ctaPrimary.label}
                        </a>
                        <a
                            className='lp-btn lp-btn-secondary'
                            href={copy.ctaSecondary.href}
                        >
                            {copy.ctaSecondary.label}
                        </a>
                    </div>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <p className='lp-eyebrow'>
                        {t('web.channelsPage.appsEyebrow')}
                    </p>
                    <h2 className='lp-h2'>
                        {t('web.channelsPage.appsTitle')}{' '}
                        {t('web.channelsPage.appsTitleAccent')}
                    </h2>
                    {/* Grouped the way the page groups them: a reader looking
                        for their own app finds it under where they talk, not
                        under which credential its API wants. */}
                    <ul className='seo-bullets'>
                        {CHANNEL_TILE_GROUPS.map((group) => (
                            <li key={group.labelKey}>
                                {t(group.labelKey)} —{' '}
                                {group.tiles
                                    .map((tile) =>
                                        channelTileLabel(tile.provider)
                                    )
                                    .join(' · ')}
                            </li>
                        ))}
                    </ul>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <p className='lp-eyebrow'>
                        {t('web.channelsPage.stepsEyebrow')}
                    </p>
                    <h2 className='lp-h2'>
                        {t('web.channelsPage.stepsTitle')}{' '}
                        {t('web.channelsPage.stepsTitleAccent')}
                    </h2>
                    <ol className='seo-bullets'>
                        {CHANNEL_STEP_KEYS.map((step) => (
                            <li key={step.title}>
                                {t(step.title)} — {t(step.body)}
                                {step.note ? ` ${t(step.note)}` : ''}
                            </li>
                        ))}
                    </ol>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <p className='lp-eyebrow'>
                        {t('web.channelsPage.syncEyebrow')}
                    </p>
                    <h2 className='lp-h2'>
                        {t('web.channelsPage.syncTitle')}{' '}
                        {t('web.channelsPage.syncTitleAccent')}
                    </h2>
                    <p className='lp-lead'>{t('web.channelsPage.syncLead')}</p>
                    <ul className='seo-bullets'>
                        {CHANNEL_SYNC_POINTS.map((point) => (
                            <li key={point}>
                                {t(`web.channelsPage.syncPoint${point}`)} —{' '}
                                {t(`web.channelsPage.syncPoint${point}Body`)}
                            </li>
                        ))}
                    </ul>
                    <p className='seo-positioning'>
                        {t('web.channelsPage.syncWsFoot')}
                    </p>
                </div>
            </section>
            <SeoClosingCta entry={entry} />
        </main>
    )
}

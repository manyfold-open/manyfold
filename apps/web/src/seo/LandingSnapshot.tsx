import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import {
    FAQ_KEYS,
    PRICING_TIERS,
    TIER_LABEL,
    TIER_TAGLINE_KEY,
    WORKS_WITH_ROWS
} from '@/seo/landingContent'
import type { SeoPageEntry } from '@/seo/pages'

// The no-JS view of `/` and `/zh/`: a semantic snapshot of the visible
// landing content, sourced from the same i18n keys and shared content tables
// as the interactive page. Only rendered at build time (the hydrated page is
// the real Landing route); the renderer calls setLanguage() before this, so
// the module-level t() resolves to the right dictionary.

// The hero's three middle scenes. On the page they arrive one at a time as
// the reader scrolls the pinned stage; here they are plain sections, in the
// same order and with the same copy.
const SCENES = [1, 2, 3]
const ITEMS = [1, 2, 3]

export const LandingSnapshot: FC<{ entry: SeoPageEntry }> = ({
    entry
}): ReactNode => {
    const { copy } = entry
    return (
        <main className='seo-main'>
            <section className='lp-section seo-hero'>
                <div className='lp-container'>
                    <p className='lp-eyebrow'>{t('web.landing.heroEyebrow')}</p>
                    <h1 className='lp-h1'>{copy.h1}</h1>
                    <p className='lp-lead'>{t('web.landing.heroTagline')}</p>
                    <p className='seo-positioning'>{copy.lead}</p>
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
                    <p className='seo-brands'>
                        {t('web.landing.worksWithEyebrow')}{' '}
                        {WORKS_WITH_ROWS[0].chips
                            .map((chip) => chip.name ?? t(chip.key ?? ''))
                            .join(' · ')}
                    </p>
                </div>
            </section>
            {SCENES.map((scene) => (
                <section key={scene} className='lp-section seo-section'>
                    <div className='lp-container'>
                        <h2 className='lp-h2'>
                            {t(`web.landing.scene${scene}Title`)}{' '}
                            {t(`web.landing.scene${scene}TitleAccent`)}
                        </h2>
                        <p className='lp-lead'>
                            {t(`web.landing.scene${scene}Lead`)}
                        </p>
                        <ul className='seo-bullets'>
                            {ITEMS.map((item) => (
                                <li key={item}>
                                    {t(
                                        `web.landing.scene${scene}Item${item}Label`
                                    )}{' '}
                                    —{' '}
                                    {t(
                                        `web.landing.scene${scene}Item${item}Body`
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>
            ))}
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.worksWithTitle')}{' '}
                        {t('web.landing.worksWithTitleAccent')}
                    </h2>
                    <p className='lp-lead'>{t('web.landing.worksWithLead')}</p>
                    <ul className='seo-bullets'>
                        {WORKS_WITH_ROWS.map((row) => (
                            <li key={row.labelKey}>
                                {t(row.labelKey)} —{' '}
                                {row.chips
                                    .map(
                                        (chip) => chip.name ?? t(chip.key ?? '')
                                    )
                                    .join(' · ')}
                            </li>
                        ))}
                    </ul>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.obsTitle')}{' '}
                        {t('web.landing.obsTitleAccent')}
                    </h2>
                    <ul className='seo-bullets'>
                        {ITEMS.map((point) => (
                            <li key={point}>
                                {t(`web.landing.obsPoint${point}Label`)}{' '}
                                {t(`web.landing.obsPoint${point}Body`)}
                            </li>
                        ))}
                    </ul>
                    <p className='seo-positioning'>{t('web.landing.obsLead')}</p>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.pricingTitleBefore')}{' '}
                        {t('web.landing.pricingTitleAccent')}
                    </h2>
                    <p className='lp-lead'>{t('web.landing.pricingLead')}</p>
                    <ul className='seo-bullets'>
                        {PRICING_TIERS.map((tier) => (
                            <li key={tier.id}>
                                {TIER_LABEL[tier.id]} —{' '}
                                {tier.price === 0
                                    ? t('web.landing.pricingFree')
                                    : `$${tier.price} ${t('web.landing.pricingPerMonth')}`}{' '}
                                · {t(TIER_TAGLINE_KEY[tier.id])}
                            </li>
                        ))}
                    </ul>
                    <p className='seo-positioning'>
                        {t('web.landing.pricingNote')}
                    </p>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.faqTitleBefore')}{' '}
                        {t('web.landing.faqTitleAccent')}
                    </h2>
                    <dl className='seo-faq'>
                        {FAQ_KEYS.map((item) => (
                            <div key={item.q}>
                                <dt>{t(item.q)}</dt>
                                <dd>{t(item.a)}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </section>
        </main>
    )
}

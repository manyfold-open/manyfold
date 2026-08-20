import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import {
    FAQ_KEYS,
    FLOOR_BRAND_NAMES,
    PRICING_TIERS,
    TIER_LABEL,
    TIER_TAGLINE_KEY
} from '@/seo/landingContent'
import type { SeoPageEntry } from '@/seo/pages'

// The no-JS view of `/` and `/zh/`: a semantic snapshot of the visible
// landing content, sourced from the same i18n keys and shared content tables
// as the interactive page. Only rendered at build time (the hydrated page is
// the real Landing route); the renderer calls setLanguage() before this, so
// the module-level t() resolves to the right dictionary.

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
                        {t('web.landing.heroFloorBrands')}{' '}
                        {FLOOR_BRAND_NAMES.join(' · ')}
                    </p>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.flowTitleBefore')}{' '}
                        {t('web.landing.flowTitleAccent')}
                    </h2>
                    <p className='lp-lead'>{t('web.landing.flowBody')}</p>
                    <ul className='seo-bullets'>
                        <li>
                            {t('web.landing.flowStep1Title1')}{' '}
                            {t('web.landing.flowStep1TitleAccent')}{' '}
                            {t('web.landing.flowStep1Body')}
                        </li>
                        <li>
                            {t('web.landing.flowStep2Title1')}{' '}
                            {t('web.landing.flowStep2TitleAccent')}{' '}
                            {t('web.landing.flowStep2Body')}
                        </li>
                        <li>
                            {t('web.landing.flowStep3Title1')}{' '}
                            {t('web.landing.flowStep3TitleAccent')}{' '}
                            {t('web.landing.flowStep3Body')}
                        </li>
                    </ul>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.machinesTitle1')}{' '}
                        {t('web.landing.machinesTitleAccent')}
                    </h2>
                    <p className='lp-lead'>{t('web.landing.machinesBody')}</p>
                    <ul className='seo-bullets'>
                        <li>
                            {t('web.landing.machineCloudName1')}{' '}
                            {t('web.landing.machineCloudName2')} —{' '}
                            {t('web.landing.machineCloudBody')}
                        </li>
                        <li>
                            {t('web.landing.machineLocalName1')}{' '}
                            {t('web.landing.machineLocalName2')} —{' '}
                            {t('web.landing.machineLocalBody')}
                        </li>
                        <li>
                            {t('web.landing.machineByoName1')}{' '}
                            {t('web.landing.machineByoName2')}{' '}
                            {t('web.landing.machineByoName3')} —{' '}
                            {t('web.landing.machineByoBody')}
                        </li>
                    </ul>
                </div>
            </section>
            <section className='lp-section seo-section'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>
                        {t('web.landing.featuresTitle1')}{' '}
                        {t('web.landing.featuresTitleAccent')}{' '}
                        {t('web.landing.featuresTitle2')}
                    </h2>
                    <p className='lp-lead'>{t('web.landing.featuresBody')}</p>
                    <ul className='seo-bullets'>
                        <li>
                            {t('web.landing.featAutomateTitleAccent')}{' '}
                            {t('web.landing.featAutomateTitleRest')}{' '}
                            {t('web.landing.featAutomateBody')}
                        </li>
                        <li>
                            {t('web.landing.featChannelsTitle1')}{' '}
                            {t('web.landing.featChannelsTitleAccent')}{' '}
                            {t('web.landing.featChannelsBody')}
                        </li>
                        <li>
                            {t('web.landing.featThreadTitle1')}{' '}
                            {t('web.landing.featThreadTitleAccent')}{' '}
                            {t('web.landing.featThreadBody')}
                        </li>
                        <li>
                            {t('web.landing.featMcpTitle1')}{' '}
                            {t('web.landing.featMcpTitleAccent')}{' '}
                            {t('web.landing.featMcpBody')}
                        </li>
                    </ul>
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
            <section className='lp-section seo-section seo-cta-block'>
                <div className='lp-container'>
                    <h2 className='lp-h2'>{copy.ctaTitle}</h2>
                    <p className='lp-lead'>{t('web.landing.ctaLead')}</p>
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
                    <h3 className='seo-links-label'>{copy.docsLinksLabel}</h3>
                    <ul className='seo-links'>
                        {copy.docsLinks.map((link) => (
                            <li key={link.href}>
                                <a href={link.href}>{link.label}</a>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>
        </main>
    )
}

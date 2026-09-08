import type { FC, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { requestConsentPrompt } from '@/lib/analyticsConsent'
import { GithubMono } from '@/lib/brandIcons'
import { DiscordMark, XMark } from '@/lib/brandMarks'
import { CHALLENGE_PATH } from '@/lib/challengeConfig'
import { analyticsConfigured } from '@/lib/googleAnalytics'
import { useI18n } from '@/lib/i18n'
import {
    SOCIAL_DISCORD_URL,
    SOCIAL_GITHUB_URL,
    SOCIAL_X_URL
} from '@/lib/socialLinks'
import {
    marketingLinkLanguage,
    marketingLinksFor
} from '@/seo/marketingLinks'
import { MarketingBrand, withStay } from '@/components/marketing/MarketingNav'
import { CloudFooterLink } from '@/components/marketing/CloudNavLink'
import { useAppAuth } from '@/lib/auth'
import type { MarketingLinks } from '@/seo/marketingLinks'

interface FooterLink {
    key: string
    label: string
}

/* In-app destinations render as router links; the rest are absolute URLs on
   the docs site, keyed straight off MarketingLinks. Pricing is a section of
   the landing page, so it carries `stay` for the same reason the nav's copy
   does: without it a signed-in visitor following it lands in the workspace
   instead of on the section they asked for. */
const routeTo = (
    key: string,
    hrefs: MarketingLinks,
    signedIn: boolean
): string | null => {
    if (key === 'challenge') return CHALLENGE_PATH
    if (key === 'channels') return hrefs.channels
    if (key === 'pricing')
        return withStay(`${hrefs.home}#lp-pricing`, signedIn)
    return null
}

export const MarketingFooter: FC<{ badge?: ReactNode }> = ({
    badge
}): ReactNode => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    const { isSignedIn } = useAppAuth()
    const hrefs = marketingLinksFor(
        marketingLinkLanguage(pathname, language)
    )
    /* Three columns rather than one row of eight. A row ranks nothing: it put
       Cloud and "Cookie settings" at the same weight, which is a worse answer
       than leaving the page out of the footer altogether. */
    const product: FooterLink[] = [
        { key: 'channels', label: t('web.landing.navChannels') },
        { key: 'pricing', label: t('web.landing.navPricing') },
        /* Naming Cloud in the nav asserts that something is not cloud, so the
           site has to say what that is or the word carries nothing. This is
           also the open-source core's only entrance here that is a word
           rather than a glyph. */
        { key: 'selfHost', label: t('web.landing.footerSelfHost') }
    ]
    const resources: FooterLink[] = [
        { key: 'docs', label: t('web.landing.footerDocs') },
        { key: 'changelog', label: t('web.landing.footerChangelog') },
        { key: 'status', label: t('web.landing.footerStatus') },
        /* Permanent, campaign state or not: one address for the series is what
           lets links to it accumulate across editions. It sits with the
           resources because it is an event, not a line of the product. */
        { key: 'challenge', label: t('web.landing.footerChallenge') }
    ]
    const legal: FooterLink[] = [
        { key: 'privacy', label: t('web.landing.footerPrivacy') },
        { key: 'terms', label: t('web.landing.footerTerms') }
    ]
    const renderLink = (link: FooterLink): ReactNode => {
        const to = routeTo(link.key, hrefs, isSignedIn)
        return to !== null ? (
            <Link key={link.key} to={to}>
                {link.label}
            </Link>
        ) : (
            <a key={link.key} href={hrefs[link.key as keyof MarketingLinks]}>
                {link.label}
            </a>
        )
    }
    return (
        <footer className='lp-foot'>
            <div className='lp-container'>
                <div className='lp-foot-grid'>
                    <div className='lp-foot-brand'>
                        <MarketingBrand badge={badge} homeTo={hrefs.home} />
                        {/* Kept here as well as in the nav: the nav catches
                            people passing through, the footer catches the ones
                            who came looking. No hairline in a column — the
                            white space above already separates the cluster,
                            and a rule would read as a divider from whatever
                            sits below. */}
                        <span className='lp-foot-social'>
                            {/* Source first: for an open-source product the
                                repository is the destination the other two
                                lead people to, not a third social account. */}
                            <a
                                className='lp-nav-ico'
                                href={SOCIAL_GITHUB_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                aria-label={t('web.marketing.sourceGithub')}
                            >
                                <GithubMono />
                            </a>
                            <a
                                className='lp-nav-ico'
                                href={SOCIAL_X_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                aria-label={t('web.marketing.followX')}
                            >
                                <XMark />
                            </a>
                            <a
                                className='lp-nav-ico'
                                href={SOCIAL_DISCORD_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                aria-label={t('web.marketing.joinDiscord')}
                            >
                                <DiscordMark mono />
                            </a>
                        </span>
                    </div>
                    <nav className='lp-foot-col'>
                        <p className='lp-foot-col-title'>
                            {t('web.landing.footerGroupProduct')}
                        </p>
                        <CloudFooterLink />
                        {product.map(renderLink)}
                    </nav>
                    <nav className='lp-foot-col'>
                        <p className='lp-foot-col-title'>
                            {t('web.landing.footerGroupResources')}
                        </p>
                        {resources.map(renderLink)}
                    </nav>
                    <nav className='lp-foot-col'>
                        <p className='lp-foot-col-title'>
                            {t('web.landing.footerGroupLegal')}
                        </p>
                        {legal.map(renderLink)}
                        {analyticsConfigured ? (
                            <button
                                type='button'
                                onClick={requestConsentPrompt}
                            >
                                {t('web.landing.footerCookies')}
                            </button>
                        ) : null}
                    </nav>
                </div>
                <div className='lp-foot-legal'>
                    <span>{t('web.landing.footerLegal')}</span>
                </div>
            </div>
        </footer>
    )
}

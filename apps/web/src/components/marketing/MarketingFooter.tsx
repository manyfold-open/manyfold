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
import { MarketingBrand } from '@/components/marketing/MarketingNav'

/* In-app routes render as router links; `to` is what marks them. */
const FOOTER_TO: Record<string, string> = {
    challenge: CHALLENGE_PATH
}

export const MarketingFooter: FC<{ badge?: ReactNode }> = ({
    badge
}): ReactNode => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    const hrefs = marketingLinksFor(
        marketingLinkLanguage(pathname, language)
    )
    const links: Array<{ key: string; label: string }> = [
        { key: 'docs', label: t('web.landing.footerDocs') },
        /* Permanent, campaign state or not: one address for the series is what
           lets links to it accumulate across editions. */
        { key: 'challenge', label: t('web.landing.footerChallenge') },
        { key: 'changelog', label: t('web.landing.footerChangelog') },
        { key: 'status', label: t('web.landing.footerStatus') },
        { key: 'privacy', label: t('web.landing.footerPrivacy') },
        { key: 'terms', label: t('web.landing.footerTerms') }
    ]
    return (
        <footer className='lp-foot'>
            <div className='lp-container'>
                <div className='lp-foot-row'>
                    <div className='lp-foot-left'>
                        <MarketingBrand badge={badge} homeTo={hrefs.home} />
                        <span className='lp-copy'>
                            {t('web.landing.footerLegal')}
                        </span>
                    </div>
                    <nav className='lp-foot-links'>
                        {links.map((link) =>
                            FOOTER_TO[link.key] ? (
                                <Link key={link.key} to={FOOTER_TO[link.key]}>
                                    {link.label}
                                </Link>
                            ) : (
                                <a
                                    key={link.key}
                                    href={hrefs[link.key as keyof typeof hrefs]}
                                >
                                    {link.label}
                                </a>
                            )
                        )}
                        {analyticsConfigured ? (
                            <button
                                type='button'
                                onClick={requestConsentPrompt}
                            >
                                {t('web.landing.footerCookies')}
                            </button>
                        ) : null}
                        {/* Kept here as well as in the nav: the nav catches
                            people passing through, the footer catches the ones
                            who came looking. */}
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
                    </nav>
                </div>
            </div>
        </footer>
    )
}

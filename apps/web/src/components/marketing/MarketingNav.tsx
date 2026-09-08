import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
    BookOpen,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Globe,
    Menu,
    MessageSquare,
    Moon,
    Sun,
    Tag
} from 'lucide-react'
import { BrandMark } from '@/components/Brand'
import ChallengeNavLink, {
    ChallengeNavMenuItem
} from '@/components/challenge/ChallengeNavLink'
import CloudNavLink, {
    CloudNavMenuItem
} from '@/components/marketing/CloudNavLink'
import { useAppAuth } from '@/lib/auth'
import { GithubMono } from '@/lib/brandIcons'
import { DiscordMark, XMark } from '@/lib/brandMarks'
import { languageOptions, useI18n } from '@/lib/i18n'
import {
    SOCIAL_DISCORD_URL,
    SOCIAL_GITHUB_URL,
    SOCIAL_X_URL
} from '@/lib/socialLinks'
import {
    marketingLinkLanguage,
    marketingLinksFor
} from '@/seo/marketingLinks'
import { seoPageForPath } from '@/seo/pages'
import { useTheme } from '@/lib/theme'
import {
    marketingLanguageMenuItems,
    selectMarketingLanguage
} from './marketingLanguage'
import type { MarketingLanguagePaths } from './marketingLanguage'

export type { MarketingLanguagePaths } from './marketingLanguage'

/* Landing sends a signed-in visitor to the workspace unless the URL carries
   `stay=1` — which is right for someone typing the bare domain, but wrong for
   every in-site link that points back at the marketing pages: clicking the
   logo or Pricing from anywhere landed you in the workspace instead of where
   you asked to go. Following an in-site link *is* the intent `stay` encodes,
   so those links say so.

   Only for signed-in visitors, so signed-out URLs (the ones crawlers and
   shared links see) stay clean. A bare hash is left alone: it never leaves the
   page, so it cannot trip the redirect. */
export const withStay = (to: string, signedIn: boolean): string => {
    if (!signedIn || to.startsWith('#')) return to
    const [path, hash] = to.split('#')
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}stay=1${hash === undefined ? '' : `#${hash}`}`
}

export const MarketingBrand: FC<{ badge?: ReactNode; homeTo?: string }> = ({
    badge,
    homeTo = '/'
}): ReactNode => {
    const { isSignedIn } = useAppAuth()
    return (
        <Link
            to={withStay(homeTo, isSignedIn)}
            aria-label='Manyfold'
            className='lp-brand'
        >
            <BrandMark className='lp-brand-mark' />
            <span>Manyfold</span>
            {badge}
        </Link>
    )
}

// Marketing pages carry their language in the URL: the switch renders real
// links between the en/zh page pair instead of writing localStorage.
const LangSwitch: FC<{ languagePaths?: MarketingLanguagePaths }> = ({
    languagePaths
}): ReactNode => {
    const { t, language, setLanguage } = useI18n()
    const { search } = useLocation()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const selected =
        languageOptions.find((option) => option.code === language) ??
        languageOptions[0]
    const menuItems = marketingLanguageMenuItems(languagePaths, search)

    useEffect(() => {
        if (!open) return
        const onDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('pointerdown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <div ref={rootRef} className='lp-nav-chip-root'>
            {/* The globe is gone because "EN" already says "language"; the
                label alone would read as static text, so the chevron says
                menu and aria-label carries what the icon used to. */}
            <button
                type='button'
                className='lp-nav-ico lp-nav-ico-text'
                aria-haspopup='listbox'
                aria-expanded={open}
                aria-label={t('web.marketing.language')}
                onClick={() => setOpen((value) => !value)}
            >
                <span>{selected.code.toUpperCase()}</span>
                <ChevronDown aria-hidden='true' />
            </button>
            {open ? (
                <div className='lp-nav-menu' role='listbox'>
                    {menuItems.map((item) => {
                        const active = item.code === selected.code
                        const className = [
                            'lp-nav-menu-item',
                            active ? 'lp-nav-menu-item-active' : ''
                        ].join(' ')
                        return item.path !== undefined ? (
                            <Link
                                key={item.code}
                                to={item.path}
                                role='option'
                                aria-selected={active}
                                className={className}
                                onClick={() => {
                                    selectMarketingLanguage(item, setLanguage)
                                    setOpen(false)
                                }}
                            >
                                <span>{item.nativeName}</span>
                                <span className='lp-nav-menu-item-meta'>
                                    {item.code.toUpperCase()}
                                </span>
                            </Link>
                        ) : (
                            <button
                                key={item.code}
                                type='button'
                                role='option'
                                aria-selected={active}
                                className={className}
                                onClick={() => {
                                    selectMarketingLanguage(item, setLanguage)
                                    setOpen(false)
                                }}
                            >
                                <span>{item.nativeName}</span>
                                <span className='lp-nav-menu-item-meta'>
                                    {item.code.toUpperCase()}
                                </span>
                            </button>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}

const ThemeToggle: FC = (): ReactNode => {
    const { t } = useI18n()
    const { theme, toggleTheme } = useTheme()
    const Icon = theme === 'dark' ? Moon : Sun
    return (
        <button
            type='button'
            className='lp-nav-ico'
            aria-label={t('web.marketing.toggleTheme')}
            onClick={toggleTheme}
        >
            <Icon />
        </button>
    )
}

/* The three outward doors, source first: an open-source product's repository
   is the one a visitor evaluating it reaches for, and the other two are
   pointing there anyway. They sit with the page preferences rather than in the
   centre group because all three are utilities — and at 16px in muted grey
   none competes with the CTA, which is the whole reason the nav can carry them
   at all. The rule after them separates "leaves the site" from "changes this
   page"; without it the bare glyphs read as one string. */
const SocialLinks: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <>
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
                {/* mono: in the nav the mark is one utility glyph among
                    several, so blurple would make it the loudest thing on a
                    bar whose only accent is meant to be the CTA. */}
                <DiscordMark mono />
            </a>
            <span className='lp-nav-sep' aria-hidden='true' />
        </>
    )
}

const NavOverflow: FC<{
    channelsCurrent: boolean
    channelsTo: string
    docsHref: string
    renderCta?: (close: () => void) => ReactNode
    languagePaths?: MarketingLanguagePaths
    pricingTo: string
}> = ({
    channelsCurrent,
    channelsTo,
    docsHref,
    renderCta,
    languagePaths,
    pricingTo
}): ReactNode => {
    const { t, language, setLanguage } = useI18n()
    const { theme, toggleTheme } = useTheme()
    const { search } = useLocation()
    const { isSignedIn } = useAppAuth()
    const [open, setOpen] = useState(false)
    /* The eleven locales are a second view rather than eleven more rows.
       Measured on local dev at 390x844 [2026-09-08]: listed flat the menu is
       873px, which under the 54px bar overflows a phone of exactly this size
       by 89px — before considering a shorter one. Drilled down it is 422px,
       and one row replaces the two the locales used to take. */
    const [view, setView] = useState<'root' | 'lang'>('root')
    const rootRef = useRef<HTMLDivElement | null>(null)
    const ThemeIcon = theme === 'dark' ? Moon : Sun
    const menuItems = marketingLanguageMenuItems(languagePaths, search)
    const selected =
        languageOptions.find((option) => option.code === language) ??
        languageOptions[0]

    // Closing returns to the root view: reopening on the language list would
    // have lost the page group the menu was opened for.
    useEffect(() => {
        if (!open) setView('root')
    }, [open])

    useEffect(() => {
        if (!open) return
        const onDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('pointerdown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <div ref={rootRef} className='lp-nav-chip-root lp-nav-more-root'>
            <button
                type='button'
                className='lp-nav-chip lp-nav-chip-icon'
                aria-label={t('web.marketing.menu')}
                aria-haspopup='menu'
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <Menu />
            </button>
            {open ? (
                <div className='lp-nav-menu lp-nav-menu-overflow' role='menu'>
                    {view === 'lang' ? (
                        <>
                            {/* Title and back control in one row: the chevron
                                is the affordance and the label says where back
                                goes, which is the pairing the row that opened
                                this view already carries. */}
                            <button
                                type='button'
                                className='lp-nav-menu-back'
                                onClick={() => setView('root')}
                            >
                                <ChevronLeft aria-hidden='true' />
                                <span>{t('web.marketing.language')}</span>
                            </button>
                            <div
                                className='lp-nav-menu-sep'
                                role='separator'
                            />
                            {/* The list outruns a short viewport on its own,
                                so it scrolls inside the panel rather than
                                growing the menu past the fold. */}
                            <div className='lp-nav-menu-scroll'>
                                {menuItems.map((item) => {
                                    const active = item.code === language
                                    const className = [
                                        'lp-nav-menu-item',
                                        active
                                            ? 'lp-nav-menu-item-active'
                                            : ''
                                    ].join(' ')
                                    /* No globe per row: the whole panel is
                                       languages, so the glyph would repeat
                                       what the view itself says. */
                                    return item.path !== undefined ? (
                                        <Link
                                            key={item.code}
                                            to={item.path}
                                            role='menuitemradio'
                                            aria-checked={active}
                                            className={className}
                                            onClick={() => {
                                                selectMarketingLanguage(
                                                    item,
                                                    setLanguage
                                                )
                                                setOpen(false)
                                            }}
                                        >
                                            <span>{item.nativeName}</span>
                                            <span className='lp-nav-menu-item-meta'>
                                                {item.code.toUpperCase()}
                                            </span>
                                        </Link>
                                    ) : (
                                        <button
                                            key={item.code}
                                            type='button'
                                            role='menuitemradio'
                                            aria-checked={active}
                                            className={className}
                                            onClick={() => {
                                                selectMarketingLanguage(
                                                    item,
                                                    setLanguage
                                                )
                                                setOpen(false)
                                            }}
                                        >
                                            <span>{item.nativeName}</span>
                                            <span className='lp-nav-menu-item-meta'>
                                                {item.code.toUpperCase()}
                                            </span>
                                        </button>
                                    )
                                })}
                            </div>
                        </>
                    ) : (
                        <>
                            {renderCta?.(() => setOpen(false))}
                            <CloudNavMenuItem close={() => setOpen(false)} />
                            {/* The folded menu is the one place with room to
                                say what "Channels" means to someone who has
                                not used the product; the bar itself keeps a
                                single text tier. */}
                            <Link
                                className={
                                    channelsCurrent
                                        ? 'lp-nav-menu-item lp-nav-menu-item-2l lp-nav-menu-item-active'
                                        : 'lp-nav-menu-item lp-nav-menu-item-2l'
                                }
                                to={channelsTo}
                                aria-current={
                                    channelsCurrent ? 'page' : undefined
                                }
                                role='menuitem'
                                onClick={() => setOpen(false)}
                            >
                                <MessageSquare />
                                <span className='lp-nav-menu-item-text'>
                                    <span>{t('web.landing.navChannels')}</span>
                                    <span className='lp-nav-menu-item-sub'>
                                        {t('web.landing.navChannelsApps')}
                                    </span>
                                </span>
                            </Link>
                            <a
                                className='lp-nav-menu-item'
                                href={withStay(pricingTo, isSignedIn)}
                                role='menuitem'
                                onClick={() => setOpen(false)}
                            >
                                <Tag />
                                <span>{t('web.landing.navPricing')}</span>
                            </a>
                            <a
                                className='lp-nav-menu-item'
                                href={docsHref}
                                role='menuitem'
                            >
                                <BookOpen />
                                <span>{t('web.landing.navDocs')}</span>
                            </a>
                            <ChallengeNavMenuItem
                                close={() => setOpen(false)}
                            />
                            <div
                                className='lp-nav-menu-sep'
                                role='separator'
                            />
                            {/* Their own group between the pages and the
                                preferences: "which page" and "which site" are
                                different questions, and the icon column keeps
                                them scannable as a set. */}
                            <a
                                className='lp-nav-menu-item'
                                href={SOCIAL_GITHUB_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                role='menuitem'
                                onClick={() => setOpen(false)}
                            >
                                <GithubMono />
                                <span>{t('web.marketing.sourceGithub')}</span>
                            </a>
                            <a
                                className='lp-nav-menu-item'
                                href={SOCIAL_X_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                role='menuitem'
                                onClick={() => setOpen(false)}
                            >
                                <XMark />
                                <span>{t('web.marketing.followX')}</span>
                            </a>
                            <a
                                className='lp-nav-menu-item'
                                href={SOCIAL_DISCORD_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                role='menuitem'
                                onClick={() => setOpen(false)}
                            >
                                <DiscordMark mono />
                                <span>{t('web.marketing.joinDiscord')}</span>
                            </a>
                            <div
                                className='lp-nav-menu-sep'
                                role='separator'
                            />
                            {/* Language and theme are one group — both answer
                                "how should this page be shown to me" — so no
                                rule divides them. */}
                            <button
                                type='button'
                                role='menuitem'
                                className='lp-nav-menu-item'
                                aria-haspopup='menu'
                                onClick={() => setView('lang')}
                            >
                                <Globe />
                                <span>{t('web.marketing.language')}</span>
                                <span className='lp-nav-menu-value'>
                                    {selected.nativeName}
                                    <ChevronRight aria-hidden='true' />
                                </span>
                            </button>
                            <button
                                type='button'
                                role='menuitem'
                                className='lp-nav-menu-item'
                                onClick={() => {
                                    toggleTheme()
                                    setOpen(false)
                                }}
                            >
                                <ThemeIcon />
                                <span>
                                    {theme === 'dark'
                                        ? t('web.marketing.lightMode')
                                        : t('web.marketing.darkMode')}
                                </span>
                            </button>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    )
}

export interface MarketingNavProps {
    badge?: ReactNode
    cta?: ReactNode
    overflowCta?: (close: () => void) => ReactNode
    languagePaths?: MarketingLanguagePaths
    homeTo?: string
    /* Pricing is a section of the landing page, not a route of its own. The
       landing page passes a bare hash so the click just scrolls; everywhere
       else the default navigates home first and lands on the section — to
       the home page in the language this URL pins, not a hard-coded '/'. A
       constant here sent a visitor reading /zh/channels to the English
       landing page. */
    pricingTo?: string
}

export const MarketingNav: FC<MarketingNavProps> = ({
    badge,
    cta,
    overflowCta,
    languagePaths,
    homeTo,
    pricingTo
}): ReactNode => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    const { isSignedIn } = useAppAuth()
    const links = marketingLinksFor(
        marketingLinkLanguage(pathname, language)
    )
    /* Only a page of our own can be the current one. Docs leaves for the docs
       site and Pricing is a section of the landing page, so neither has a
       state to be in — marking Pricing active on the home page would claim
       the visitor is standing on a section they may not have scrolled to. */
    const channelsCurrent = seoPageForPath(pathname)?.def.key === 'channels'
    const pricingHref = pricingTo ?? `${links.home}#lp-pricing`
    return (
        <header className='lp-nav'>
            {/* Three columns rather than two: the destinations now sit in the
                middle, which leaves the right edge to utilities and the CTA
                alone and stops the CTA from being crowded by page links. */}
            <div className='lp-nav-inner lp-nav-inner-tri'>
                <div className='lp-nav-inner-left'>
                    <MarketingBrand badge={badge} homeTo={homeTo} />
                </div>
                {/* Product first, then price, then documentation: what a
                    visitor can get, what it costs, how to work it. Docs held
                    the leftmost slot for historical reasons, which put the
                    surface written for people who have already committed
                    ahead of the two pages arguing that they should. Challenge
                    trails the group because it is a campaign, not a permanent
                    line of the product. */}
                <nav className='lp-nav-center'>
                    <CloudNavLink />
                    <Link
                        className={
                            channelsCurrent
                                ? 'lp-nav-link lp-nav-link-active'
                                : 'lp-nav-link'
                        }
                        to={links.channels}
                        aria-current={channelsCurrent ? 'page' : undefined}
                    >
                        {t('web.landing.navChannels')}
                    </Link>
                    <a
                        className='lp-nav-link'
                        href={withStay(pricingHref, isSignedIn)}
                    >
                        {t('web.landing.navPricing')}
                    </a>
                    <a className='lp-nav-link' href={links.docs}>
                        {t('web.landing.navDocs')}
                    </a>
                    <ChallengeNavLink />
                </nav>
                <div className='lp-nav-actions'>
                    <div className='lp-nav-desktop'>
                        <SocialLinks />
                        <LangSwitch languagePaths={languagePaths} />
                        <ThemeToggle />
                        {cta}
                    </div>
                    <div className='lp-nav-mobile'>
                        <NavOverflow
                            channelsCurrent={channelsCurrent}
                            channelsTo={links.channels}
                            docsHref={links.docs}
                            renderCta={overflowCta}
                            languagePaths={languagePaths}
                            pricingTo={pricingHref}
                        />
                    </div>
                </div>
            </div>
        </header>
    )
}

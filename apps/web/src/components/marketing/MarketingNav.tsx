import type { FC, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
    ArrowRight,
    ArrowUpRight,
    BookOpen,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Menu,
    Moon,
    Sun,
    Tag
} from 'lucide-react'
import { BrandMark } from '@/components/Brand'
import {
    groupHasPage,
    useMarketingNavMenus,
    type MarketingNavMenus,
    type NavMenuGroup,
    type NavMenuLink
} from '@/components/marketing/navMenus'
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
    const { toggleTheme } = useTheme()
    return (
        <button
            type='button'
            className='lp-nav-ico'
            aria-label={t('web.marketing.toggleTheme')}
            onClick={toggleTheme}
        >
            <Sun className='lp-theme-light' />
            <Moon className='lp-theme-dark' />
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

/* A menu link goes three ways: a page of this site through the router, the
   docs in the same tab (they are part of the product, like the bar's own Docs
   link), and another site in a new tab. */
const MenuLink: FC<{
    link: NavMenuLink
    className: string
    current?: boolean
    role?: 'menuitem'
    onClick?: () => void
    children: ReactNode
}> = ({ link, className, current, role, onClick, children }): ReactNode => {
    if (link.external)
        return (
            <a
                className={className}
                href={link.href}
                target='_blank'
                rel='noopener noreferrer'
                role={role}
                onClick={onClick}
            >
                {children}
            </a>
        )
    if (link.href.startsWith('/'))
        return (
            <Link
                className={className}
                to={link.href}
                aria-current={current ? 'page' : undefined}
                role={role}
                onClick={onClick}
            >
                {children}
            </Link>
        )
    return (
        <a className={className} href={link.href} role={role} onClick={onClick}>
            {children}
        </a>
    )
}

const ExternalMark: FC = (): ReactNode => (
    <ArrowUpRight className='lp-nav-ext' aria-hidden='true' />
)

/* The way out at the foot of a group: everything in it. Its own arrow, → for
   a page here and ↗ for another site, always shown — it is the row's whole
   affordance. */
const MoreArrow: FC<{ link: NavMenuLink }> = ({ link }): ReactNode =>
    link.external ? (
        <ExternalMark />
    ) : (
        <ArrowRight className='lp-nav-ext' aria-hidden='true' />
    )

/* The desktop panel. The trigger stays a text link of the bar's own tier —
   open is its hover fill held, plus the caret turned — and the panel is the
   folded menu's paper, so the bar gains a behaviour, not a new look. Inside,
   a row is a name and one line saying what it is, nothing else: a lead
   sentence, a framed icon per row, ↗ on every row and a tinted footer were
   four layers on top of the list, and read as a busier menu than three links
   need. ↗ shows where the pointer or focus is, which is when it matters. */
const NavDropdown: FC<{
    group: NavMenuGroup
    current: string | undefined
    open: boolean
    onPointerEnter: () => void
    onPointerLeave: () => void
    onToggle: () => void
    onClose: () => void
}> = ({
    group,
    current,
    open,
    onPointerEnter,
    onPointerLeave,
    onToggle,
    onClose
}): ReactNode => {
    const panelId = useId()
    const active = groupHasPage(group, current)
    const marked = group.links.some((link) => link.image || link.icon)
    return (
        <div
            className='lp-nav-dd'
            onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') onPointerEnter()
            }}
            onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') onPointerLeave()
            }}
        >
            <button
                type='button'
                className={
                    active
                        ? 'lp-nav-link lp-nav-trigger lp-nav-link-active'
                        : 'lp-nav-link lp-nav-trigger'
                }
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                data-menu-trigger={group.key}
                onClick={onToggle}
            >
                <span>{group.label}</span>
                <ChevronDown className='lp-nav-caret' aria-hidden='true' />
            </button>
            {open ? (
                <div
                    id={panelId}
                    className={
                        marked ? 'lp-nav-pop lp-nav-pop-marked' : 'lp-nav-pop'
                    }
                >
                    {group.links.map((link) => {
                        const Icon = link.icon
                        const here =
                            link.page !== undefined && link.page === current
                        return (
                            <MenuLink
                                key={link.key}
                                link={link}
                                current={here}
                                className={
                                    here
                                        ? 'lp-nav-pop-item lp-nav-pop-item-active'
                                        : 'lp-nav-pop-item'
                                }
                                onClick={onClose}
                            >
                                {marked ? (
                                    <span
                                        className='lp-nav-pop-mark'
                                        aria-hidden='true'
                                    >
                                        {link.image ? (
                                            <img
                                                src={link.image}
                                                alt=''
                                                width={20}
                                                height={20}
                                            />
                                        ) : Icon ? (
                                            <Icon />
                                        ) : null}
                                    </span>
                                ) : null}
                                <span className='lp-nav-pop-text'>
                                    <span className='lp-nav-pop-title'>
                                        {link.label}
                                        {link.external ? (
                                            <ExternalMark />
                                        ) : null}
                                    </span>
                                    {link.gloss ? (
                                        <span className='lp-nav-pop-gloss'>
                                            {link.gloss}
                                        </span>
                                    ) : null}
                                </span>
                            </MenuLink>
                        )
                    })}
                    {group.more ? (
                        <>
                            <div
                                className='lp-nav-pop-sep'
                                aria-hidden='true'
                            />
                            <MenuLink
                                link={group.more}
                                current={group.more.page === current}
                                className='lp-nav-pop-more'
                                onClick={onClose}
                            >
                                <span>{group.more.label}</span>
                                <MoreArrow link={group.more} />
                                {group.more.meta ? (
                                    <span className='lp-nav-pop-meta'>
                                        {group.more.meta}
                                    </span>
                                ) : null}
                            </MenuLink>
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

/* One menu group in the folded menu, opening in place. Not a drill-down like
   the languages: those are a picker you leave as soon as you choose, while a
   page group is three to six rows you want to read beside the others. Its
   links are text only — the indent already says whose they are, and there is
   no pointer to reveal a ↗ for. */
const FoldGroup: FC<{
    group: NavMenuGroup
    current: string | undefined
    open: boolean
    onToggle: () => void
    close: () => void
}> = ({ group, current, open, onToggle, close }): ReactNode => {
    const kidsId = useId()
    const Icon = group.icon
    return (
        <>
            <button
                type='button'
                role='menuitem'
                className='lp-nav-menu-item lp-nav-menu-group'
                aria-expanded={open}
                aria-controls={open ? kidsId : undefined}
                onClick={onToggle}
            >
                <Icon />
                <span>{group.label}</span>
                <ChevronDown className='lp-nav-menu-caret' aria-hidden='true' />
            </button>
            {open ? (
                <div id={kidsId} className='lp-nav-menu-kids'>
                    {group.links.map((link) => {
                        const here =
                            link.page !== undefined && link.page === current
                        return (
                            <MenuLink
                                key={link.key}
                                link={link}
                                current={here}
                                role='menuitem'
                                className={
                                    here
                                        ? 'lp-nav-menu-kid lp-nav-menu-kid-active'
                                        : 'lp-nav-menu-kid'
                                }
                                onClick={close}
                            >
                                <span>{link.label}</span>
                                {link.foldGloss && link.gloss ? (
                                    <span className='lp-nav-menu-item-sub'>
                                        {link.gloss}
                                    </span>
                                ) : null}
                            </MenuLink>
                        )
                    })}
                    {group.more ? (
                        <MenuLink
                            link={group.more}
                            current={group.more.page === current}
                            role='menuitem'
                            className='lp-nav-menu-kid lp-nav-menu-kid-more'
                            onClick={close}
                        >
                            <span>{group.more.label}</span>
                            <MoreArrow link={group.more} />
                            {group.more.meta ? (
                                <span className='lp-nav-pop-meta'>
                                    {group.more.meta}
                                </span>
                            ) : null}
                        </MenuLink>
                    ) : null}
                </div>
            ) : null}
        </>
    )
}

const NavOverflow: FC<{
    menus: MarketingNavMenus
    docsHref: string
    renderCta?: (close: () => void) => ReactNode
    languagePaths?: MarketingLanguagePaths
    pricingTo: string
}> = ({ menus, docsHref, renderCta, languagePaths, pricingTo }): ReactNode => {
    const { t, language, setLanguage } = useI18n()
    const { search } = useLocation()
    const { isSignedIn } = useAppAuth()
    const [open, setOpen] = useState(false)
    /* The eleven locales are a second view rather than eleven more rows.
       Measured on local dev at 390x844 [2026-09-08]: listed flat the menu is
       873px, which under the 54px bar overflows a phone of exactly this size
       by 89px — before considering a shorter one. Drilled down it is 422px,
       and one row replaces the two the locales used to take. */
    const [view, setView] = useState<'root' | 'lang'>('root')
    /* The group holding the page you are on opens with the menu, so the
       current page is visible without a tap; elsewhere every group starts
       closed, one open at a time. */
    const currentGroup =
        menus.groups.find((group) => groupHasPage(group, menus.current))?.key ??
        null
    const [openGroup, setOpenGroup] = useState<string | null>(currentGroup)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const menuItems = marketingLanguageMenuItems(languagePaths, search)
    const selected =
        languageOptions.find((option) => option.code === language) ??
        languageOptions[0]

    // Closing returns to the root view: reopening on the language list would
    // have lost the page group the menu was opened for.
    useEffect(() => {
        if (open) return
        setView('root')
        setOpenGroup(currentGroup)
    }, [open, currentGroup])

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
                            {menus.barLinks.map((link) => {
                                const Icon = link.icon
                                const current = link.page === menus.current
                                return (
                                    <MenuLink
                                        key={link.key}
                                        link={link}
                                        className={
                                            current
                                                ? 'lp-nav-menu-item lp-nav-menu-item-active'
                                                : 'lp-nav-menu-item'
                                        }
                                        current={current}
                                        role='menuitem'
                                        onClick={() => setOpen(false)}
                                    >
                                        {Icon && <Icon />}
                                        <span>{link.label}</span>
                                    </MenuLink>
                                )
                            })}
                            {menus.groups.map((group) => (
                                <FoldGroup
                                    key={group.key}
                                    group={group}
                                    current={menus.current}
                                    open={openGroup === group.key}
                                    onToggle={() =>
                                        setOpenGroup((value) =>
                                            value === group.key
                                                ? null
                                                : group.key
                                        )
                                    }
                                    close={() => setOpen(false)}
                                />
                            ))}
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
                            <div className='lp-nav-menu-sep' role='separator' />
                            {/* The bar's utility cluster, verbatim and in one
                                row: controls the bar itself shows as 16px
                                glyphs were five full rows here. Measured on
                                local dev at 390x844 [2026-10-12]: those rows
                                took 178px, the one row takes 34px, and the
                                whole menu is 320px with every group closed,
                                483px with the longest open. The language chip
                                still opens the list view; the rule still
                                separates leaving the site from changing this
                                page. */}
                            <div className='lp-nav-menu-utils'>
                                <span className='lp-nav-menu-utils-group'>
                                    <a
                                        className='lp-nav-ico'
                                        href={SOCIAL_GITHUB_URL}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                        role='menuitem'
                                        aria-label={t(
                                            'web.marketing.sourceGithub'
                                        )}
                                    >
                                        <GithubMono />
                                    </a>
                                    <a
                                        className='lp-nav-ico'
                                        href={SOCIAL_X_URL}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                        role='menuitem'
                                        aria-label={t('web.marketing.followX')}
                                    >
                                        <XMark />
                                    </a>
                                    <a
                                        className='lp-nav-ico'
                                        href={SOCIAL_DISCORD_URL}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                        role='menuitem'
                                        aria-label={t(
                                            'web.marketing.joinDiscord'
                                        )}
                                    >
                                        <DiscordMark mono />
                                    </a>
                                </span>
                                <span className='lp-nav-menu-utils-group'>
                                    <span
                                        className='lp-nav-sep'
                                        aria-hidden='true'
                                    />
                                    <button
                                        type='button'
                                        role='menuitem'
                                        className='lp-nav-ico lp-nav-ico-text'
                                        aria-label={t('web.marketing.language')}
                                        aria-haspopup='menu'
                                        onClick={() => setView('lang')}
                                    >
                                        <span>
                                            {selected.code.toUpperCase()}
                                        </span>
                                        <ChevronRight aria-hidden='true' />
                                    </button>
                                    <ThemeToggle />
                                </span>
                            </div>
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
       constant here sent a visitor reading /zh/agent-channels to the English
       landing page. */
    pricingTo?: string
}

/* Which desktop panel is open, shared so that only one ever is. A mouse opens
   a panel by pointing and closes it a moment after leaving — 180ms, long
   enough to cross the gap down into the panel or slide over to the next
   trigger, short enough not to linger. Touch and keyboard go by click: a tap
   on a touch screen also fires pointerenter, and toggling on both would open
   and shut the panel in one gesture. */
const useNavDropdowns = () => {
    const { pathname } = useLocation()
    const [open, setOpen] = useState<string | null>(null)
    const openedByHover = useRef(false)
    const closeTimer = useRef<number | undefined>(undefined)
    const rootRef = useRef<HTMLElement | null>(null)

    useEffect(() => {
        setOpen(null)
    }, [pathname])

    useEffect(() => () => window.clearTimeout(closeTimer.current), [])

    useEffect(() => {
        if (open === null) return
        const onDown = (event: PointerEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(null)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            rootRef.current
                ?.querySelector<HTMLButtonElement>(
                    `[data-menu-trigger='${open}']`
                )
                ?.focus()
            setOpen(null)
        }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('pointerdown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    return {
        rootRef,
        open,
        bind: (key: string) => ({
            open: open === key,
            onPointerEnter: () => {
                window.clearTimeout(closeTimer.current)
                openedByHover.current = true
                setOpen(key)
            },
            onPointerLeave: () => {
                window.clearTimeout(closeTimer.current)
                closeTimer.current = window.setTimeout(() => setOpen(null), 180)
            },
            /* A click on a panel the pointer has just opened keeps it open
               instead of shutting it: the person was reaching for it. */
            onToggle: () => {
                if (open === key && openedByHover.current) {
                    openedByHover.current = false
                    return
                }
                openedByHover.current = false
                setOpen(open === key ? null : key)
            },
            onClose: () => setOpen(null)
        })
    }
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
    const menus = useMarketingNavMenus()
    const dropdowns = useNavDropdowns()
    const pricingHref = pricingTo ?? `${links.home}#lp-pricing`
    return (
        <header className='lp-nav'>
            {/* Three columns rather than two: the destinations now sit in the
                middle, which leaves the right edge to utilities and the CTA
                alone and stops the CTA from being crowded by page links. */}
            <div
                className={
                    menus.barLinks.length > 0
                        ? 'lp-nav-inner lp-nav-inner-tri lp-nav-inner-wide'
                        : 'lp-nav-inner lp-nav-inner-tri'
                }
            >
                <div className='lp-nav-inner-left'>
                    <MarketingBrand badge={badge} homeTo={homeTo} />
                </div>
                {/* Product first, then price, then documentation: what a
                    visitor can get, what it costs, how to work it. The pages
                    of the product sit in menus rather than on the bar: one
                    flat link each stopped fitting once a composition had a
                    showcase as well as the product to point at, and a menu
                    can say in a line what a bare word like "Channels" means.
                    Pricing and Docs stay single links — one destination
                    each, nothing to choose between. Only a page of our own
                    can be the current one: Docs leaves for the docs site and
                    Pricing is a section of the landing page, so neither has a
                    state to be in. A composition's own direct links come
                    first: they lead to a page for a reader the menus are not
                    written for. */}
                <nav className='lp-nav-center' ref={dropdowns.rootRef}>
                    {menus.barLinks.map((link) => (
                        <MenuLink
                            key={link.key}
                            link={link}
                            className={
                                link.page === menus.current
                                    ? 'lp-nav-link lp-nav-link-active'
                                    : 'lp-nav-link'
                            }
                            current={link.page === menus.current}
                        >
                            {link.label}
                        </MenuLink>
                    ))}
                    {menus.groups.map((group) => (
                        <NavDropdown
                            key={group.key}
                            group={group}
                            current={menus.current}
                            {...dropdowns.bind(group.key)}
                        />
                    ))}
                    <a
                        className='lp-nav-link'
                        href={withStay(pricingHref, isSignedIn)}
                    >
                        {t('web.landing.navPricing')}
                    </a>
                    <a className='lp-nav-link' href={links.docs}>
                        {t('web.landing.navDocs')}
                    </a>
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
                            menus={menus}
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

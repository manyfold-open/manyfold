import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Box, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { marketingLinkLanguage, marketingLinksFor } from '@/seo/marketingLinks'
import { seoPageForPath } from '@/seo/pages'
import { editionNavMenus } from './editionNavMenus'

/* One description of the marketing menus, rendered twice: as dropdown panels
   on the desktop bar and as accordion groups in the folded menu. Two
   hand-written copies had already drifted once (the folded menu carried a
   gloss the bar had no room for), and every app or dataset a composition adds
   would otherwise have to be added in both places. */

export interface NavMenuLink {
    key: string
    label: ReactNode
    href: string
    /* One line under the label in the desktop panel. */
    gloss?: string
    /* Keep the gloss in the folded menu as well. Only for a name that does
       not explain itself: every gloss there is another line on a phone. */
    foldGloss?: boolean
    /* A mark left of the label in the desktop panel: the site's own image
       where it has one — the icon its tab will show once opened, which is
       what makes it worth the room — or a line glyph naming the subject where
       it does not. A link with neither is text only, and so is the folded
       menu, whose indent already says which group a link is in. */
    image?: string
    icon?: LucideIcon
    /* A figure at the far end of the row, e.g. a count the composition
       fetches. */
    meta?: ReactNode
    /* Another site, not another page of this one: opens a new tab, and says
       so with ↗ where the pointer is. The docs are part of the product and
       stay in the tab, like the bar's own Docs link. */
    external?: boolean
    /* The SEO page key this link opens, so the page you are on reads as
       current in the menu and its group's trigger reads as active. */
    page?: string
}

export interface NavMenuGroup {
    key: string
    label: string
    /* The group's row in the folded menu. */
    icon: LucideIcon
    links: NavMenuLink[]
    /* The one way out at the foot: everything in the group. */
    more?: NavMenuLink
}

export interface MarketingFooterColumn {
    key: string
    title: string
    links: NavMenuLink[]
}

export interface MarketingNavMenus {
    /* Direct links ahead of the menus; the folded menu lists them first too. */
    barLinks: NavMenuLink[]
    groups: NavMenuGroup[]
    footerColumn: MarketingFooterColumn | null
    current: string | undefined
}

export const groupHasPage = (
    group: NavMenuGroup,
    page: string | undefined
): boolean =>
    page !== undefined &&
    [...group.links, ...(group.more ? [group.more] : [])].some(
        (link) => link.page === page
    )

export const useMarketingNavMenus = (): MarketingNavMenus => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    const linkLanguage = marketingLinkLanguage(pathname, language)
    const links = marketingLinksFor(linkLanguage)
    const edition = editionNavMenus(linkLanguage)
    /* Text only: these are pages of this site, with no image of their own,
       and a stock glyph per row would be decoration. */
    const product: NavMenuGroup = {
        key: 'product',
        label: t('web.landing.navProduct'),
        icon: Box,
        links: [
            ...edition.productLinks,
            {
                key: 'channels',
                label: t('web.landing.navChannels'),
                gloss: t('web.landing.navChannelsApps'),
                foldGloss: true,
                href: links.channels,
                page: 'channels'
            },
            {
                key: 'selfHost',
                label: t('web.landing.footerSelfHost'),
                gloss: t('web.landing.navSelfHostGloss'),
                href: links.selfHost
            }
        ]
    }
    return {
        barLinks: edition.barLinks ?? [],
        groups: [product, ...edition.groups],
        footerColumn: edition.footerColumn,
        current: seoPageForPath(pathname)?.def.key
    }
}

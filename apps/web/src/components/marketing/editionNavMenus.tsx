import type { SeoLanguage } from '@/seo/pages'
import type {
    MarketingFooterColumn,
    NavMenuGroup,
    NavMenuLink
} from './navMenus'

// Editions slot (§3.3): what a composition adds to the marketing menus — the
// links that lead its Product menu, whole groups after it, and one footer
// column. Empty here: an open-source install has no hosted offering to lead
// with and no showcase of its own to point at, so its menus are the core
// Product group alone. The cloud overlay shadows this file with its own.
//
// `.tsx` so the overlay may render a live value (a count it fetches) as a
// label; the overlay resolver maps by exact file name.
export interface EditionNavMenus {
    productLinks: NavMenuLink[]
    groups: NavMenuGroup[]
    footerColumn: MarketingFooterColumn | null
}

const NONE: EditionNavMenus = {
    productLinks: [],
    groups: [],
    footerColumn: null
}

export const editionNavMenus = (_language: SeoLanguage): EditionNavMenus => NONE

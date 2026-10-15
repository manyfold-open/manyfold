import type { SeoLanguage } from '@/seo/pages'
import type {
    MarketingFooterColumn,
    NavMenuGroup,
    NavMenuLink
} from './navMenus'

// Editions slot (§3.3): what a composition adds to the marketing menus — the
// links that lead its Product menu, whole groups after it, direct links ahead
// of every menu on the bar, and one footer column. Empty here: an open-source
// install has no hosted offering to lead with and no showcase of its own to
// point at, so its menus are the core Product group alone. The cloud overlay
// shadows this file with its own.
//
// `.tsx` so the overlay may render a live value (a count it fetches) as a
// label; the overlay resolver maps by exact file name.
export interface EditionNavMenus {
    productLinks: NavMenuLink[]
    groups: NavMenuGroup[]
    /* Single links on the bar itself, before the menus: a page with one
       destination and a different reader from the product's, which a menu
       would hide behind a word that means nothing to that reader. Optional so
       an overlay written before it still satisfies the contract. */
    barLinks?: NavMenuLink[]
    footerColumn: MarketingFooterColumn | null
}

const NONE: EditionNavMenus = {
    productLinks: [],
    groups: [],
    barLinks: [],
    footerColumn: null
}

export const editionNavMenus = (_language: SeoLanguage): EditionNavMenus => NONE

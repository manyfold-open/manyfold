import { languageOptions } from '@manyfold/i18n'
import type { Language } from '@manyfold/i18n'

export type MarketingLanguagePaths = Partial<Record<Language, string>>

export interface MarketingLanguageMenuItem {
    code: Language
    nativeName: string
    path?: string
}

export type MarketingLanguageSetter = (
    language: Language,
    options?: { persist?: boolean }
) => void

/* `search` is carried across the switch because the query string is state the
   page is already in, and swapping language should not silently drop it. The
   case that made this load-bearing: a signed-in reader can only stay on the
   landing page with `?stay=1` — without it Landing redirects to /workspace —
   so a language link built from the bare path bounced them out of the page
   they were reading. Campaign and utm params ride along for the same reason. */
export const marketingLanguageMenuItems = (
    languagePaths?: MarketingLanguagePaths,
    search?: string
): MarketingLanguageMenuItem[] =>
    languageOptions.map((option) => {
        const path = languagePaths?.[option.code]
        return {
            code: option.code,
            nativeName: option.nativeName,
            path: path === undefined ? undefined : `${path}${search ?? ''}`
        }
    })

export const selectMarketingLanguage = (
    item: MarketingLanguageMenuItem,
    setLanguage: MarketingLanguageSetter
): void => {
    setLanguage(
        item.code,
        item.path !== undefined ? { persist: false } : undefined
    )
}

export const shouldPinMarketingLanguage = (
    pathname: string,
    lastPinnedPathname: string | null,
    targetLanguage: Language | null
): boolean =>
    targetLanguage !== null && pathname !== lastPinnedPathname
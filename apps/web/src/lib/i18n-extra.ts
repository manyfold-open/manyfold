import type { Language } from '@manyfold/i18n'

// Editions slot (§3.3): app-level translation extras layered over the core
// catalogs. Empty in the open-source build; the cloud overlay shadows this
// file with the commercial strings (waitlist, invite, billing surfaces),
// which is why those keys exist nowhere in the core catalogs.
export const extraTranslations: Partial<
    Record<Language, Record<string, string>>
> = {}

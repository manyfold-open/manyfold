import type { Language } from '@manyfold/i18n'
import { registerExtraTranslations, setBrandName } from '@manyfold/i18n'

// Editions slot (§3.4): app-level translation extras layered over the core
// catalogs, mirroring apps/web/src/lib/i18n-extra.ts. Empty in the
// open-source build; the cloud overlay shadows this file with the
// commercial admin strings.
export const extraTranslations: Partial<
    Record<Language, Record<string, string>>
> = {}

registerExtraTranslations(extraTranslations)
// Build-time like the web side: the operator owns the brand and the first
// paint cannot wait on a capabilities fetch.
setBrandName(import.meta.env?.VITE_BRAND_NAME)

// This entry shares the same singleton as index.ts; only catalog loading
// differs. English is immediate, and loadLanguage resolves other languages.
export {
    defaultLanguage,
    languageOptions,
    loadLanguage,
    isLanguage,
    resolveLanguage,
    setLanguage,
    getLanguageOption,
    getLocale,
    setBrandName,
    t,
    registerExtraTranslations,
    tForLanguage
} from './runtime'
export type {
    Language,
    LanguageOption,
    TextDirection,
    Translations
} from './types'

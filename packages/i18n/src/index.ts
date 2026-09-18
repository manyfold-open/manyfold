import zh from './langs/zh'
import { registerNestedLanguage } from './runtime'

// Node, Admin and static rendering keep their synchronous bilingual contract.
registerNestedLanguage('zh', zh)

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

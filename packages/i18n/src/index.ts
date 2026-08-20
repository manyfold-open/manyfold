import en from './langs/en'
import zh from './langs/zh'
import { loadGeneratedTranslation } from './langs/generated'
import type {
    Language,
    LanguageOption,
    Translations
} from './types'

export const defaultLanguage: Language = 'en'

export const languageOptions: readonly LanguageOption[] = [
    {
        code: 'en',
        direction: 'ltr',
        englishName: 'English',
        locale: 'en-US',
        nativeName: 'English'
    },
    {
        code: 'zh',
        direction: 'ltr',
        englishName: 'Simplified Chinese',
        locale: 'zh-CN',
        nativeName: '简体中文'
    },
    {
        code: 'es',
        direction: 'ltr',
        englishName: 'Spanish',
        locale: 'es-ES',
        nativeName: 'Español'
    },
    {
        code: 'fr',
        direction: 'ltr',
        englishName: 'French',
        locale: 'fr-FR',
        nativeName: 'Français'
    },
    {
        code: 'de',
        direction: 'ltr',
        englishName: 'German',
        locale: 'de-DE',
        nativeName: 'Deutsch'
    },
    {
        code: 'ja',
        direction: 'ltr',
        englishName: 'Japanese',
        locale: 'ja-JP',
        nativeName: '日本語'
    },
    {
        code: 'ko',
        direction: 'ltr',
        englishName: 'Korean',
        locale: 'ko-KR',
        nativeName: '한국어'
    },
    {
        code: 'pt',
        direction: 'ltr',
        englishName: 'Portuguese',
        locale: 'pt-BR',
        nativeName: 'Português'
    },
    {
        code: 'ru',
        direction: 'ltr',
        englishName: 'Russian',
        locale: 'ru-RU',
        nativeName: 'Русский'
    },
    {
        code: 'ar',
        direction: 'rtl',
        englishName: 'Arabic',
        locale: 'ar',
        nativeName: 'العربية'
    },
    {
        code: 'hi',
        direction: 'ltr',
        englishName: 'Hindi',
        locale: 'hi-IN',
        nativeName: 'हिन्दी'
    }
]

const languages: Partial<Record<Language, Translations>> = {
    en,
    zh
}

const generatedTranslations: Partial<
    Record<Language, Readonly<Record<string, string>>>
> = {}
const generatedTranslationLoads: Partial<Record<Language, Promise<void>>> = {}

export const loadLanguage = async (language: Language): Promise<void> => {
    if (
        language === 'en' ||
        language === 'zh' ||
        generatedTranslations[language]
    )
        return

    const activeLoad = generatedTranslationLoads[language]
    if (activeLoad) return activeLoad

    const load = loadGeneratedTranslation(language)
        .then((catalog) => {
            if (catalog) generatedTranslations[language] = catalog
        })
        .finally(() => {
            delete generatedTranslationLoads[language]
        })
    generatedTranslationLoads[language] = load
    return load
}

const languageMeta = Object.fromEntries(
    languageOptions.map((option) => [option.code, option])
) as Record<Language, LanguageOption>

let currentLanguage: Language = defaultLanguage

export const isLanguage = (
    value: string | null | undefined
): value is Language =>
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(languageMeta, value)

export const resolveLanguage = (value: string | null | undefined): Language =>
    isLanguage(value) ? value : defaultLanguage

export const setLanguage = (lang: Language): void => {
    currentLanguage = resolveLanguage(lang)
}

export const getLanguageOption = (
    lang: Language = currentLanguage
): LanguageOption => languageMeta[lang]

export const getLocale = (): string => getLanguageOption().locale

const resolveKey = (obj: Translations, path: string): string | undefined => {
    const parts = path.split('.')
    let node: unknown = obj
    for (const key of parts) {
        if (
            node &&
            typeof node === 'object' &&
            key in (node as Record<string, unknown>)
        ) {
            node = (node as Record<string, unknown>)[key]
        } else {
            return undefined
        }
    }
    return typeof node === 'string' ? node : undefined
}

const interpolate = (
    template: string,
    params?: Record<string, string | number>
): string => {
    if (!params) return template
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
        key in params ? String(params[key]) : `{{${key}}}`
    )
}

export const t = (
    key: string,
    params?: Record<string, string | number>
): string => {
    const raw = resolveTranslation(currentLanguage, key)
    return interpolate(raw, params)
}

// App-registered translation extras (editions §3.3): flat dotted-key maps a
// composition layer can add without editing the core catalogs — the cloud
// web overlay registers its commercial strings here, so the open-source
// catalogs never carry them. Extras win over every catalog layer, and the
// English extras back-fill languages an extra map does not cover.
let extraTranslations: Partial<Record<Language, Record<string, string>>> = {}

export const registerExtraTranslations = (
    extras: Partial<Record<Language, Record<string, string>>>
): void => {
    extraTranslations = extras
}

const resolveTranslation = (language: Language, key: string): string => {
    const nestedTranslations = languages[language]
    return (
        extraTranslations[language]?.[key] ??
        generatedTranslations[language]?.[key] ??
        (nestedTranslations
            ? resolveKey(nestedTranslations, key)
            : undefined) ??
        resolveKey(en, key) ??
        extraTranslations.en?.[key] ??
        key
    )
}

export const tForLanguage = (
    language: Language,
    key: string,
    params?: Record<string, string | number>
): string => interpolate(resolveTranslation(language, key), params)

export type {
    Language,
    LanguageOption,
    TextDirection,
    Translations
} from './types'

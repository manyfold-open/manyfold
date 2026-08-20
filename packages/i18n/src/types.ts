export type Language =
    | 'en'
    | 'zh'
    | 'es'
    | 'fr'
    | 'de'
    | 'ja'
    | 'ko'
    | 'pt'
    | 'ru'
    | 'ar'
    | 'hi'

export type TextDirection = 'ltr' | 'rtl'

export interface LanguageOption {
    code: Language
    direction: TextDirection
    englishName: string
    locale: string
    nativeName: string
}

export type Translations = typeof import('./langs/en').default

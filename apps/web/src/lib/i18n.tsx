import type { FC, ReactNode } from 'react'
import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState
} from 'react'
import {
    defaultLanguage,
    getLanguageOption,
    isLanguage,
    languageOptions,
    loadLanguage as loadPackageLanguage,
    setLanguage as setPackageLanguage,
    t as translate,
    registerExtraTranslations
} from '@manyfold/i18n'
import type { Language, TextDirection } from '@manyfold/i18n'
import { extraTranslations } from '@/lib/i18n-extra'

// Module scope, before any component renders: the extras must be in place
// for the first paint's translations (the cloud overlay swaps the module).
registerExtraTranslations(extraTranslations)

const languageStorageKey = 'nca.web.language'

export const resolveBrowserLanguage = (
    browserLanguages: readonly string[]
): Language => {
    for (const raw of browserLanguages) {
        const value = raw.toLowerCase()
        if (value.startsWith('zh')) return 'zh'
        const base = value.split('-')[0]
        if (isLanguage(base)) return base
    }

    return defaultLanguage
}

const browserLanguages = (): readonly string[] => {
    if (typeof navigator === 'undefined') return []
    return navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language]
}

const matchBrowserLanguage = (): Language =>
    resolveBrowserLanguage(browserLanguages())

export const resolvePreferredLanguage = (
    stored: string | null,
    browserLanguages: readonly string[]
): Language =>
    isLanguage(stored) ? stored : resolveBrowserLanguage(browserLanguages)

const readInitialLanguage = (): Language => {
    if (typeof window === 'undefined') return defaultLanguage

    try {
        const stored = window.localStorage.getItem(languageStorageKey)
        return resolvePreferredLanguage(stored, browserLanguages())
    } catch {
        return matchBrowserLanguage()
    }
}

const applyDocumentLanguage = (language: Language): void => {
    if (typeof document === 'undefined') return

    const option = getLanguageOption(language)
    document.documentElement.lang = option.locale
    document.documentElement.dir = option.direction
}

export type TFn = typeof translate

interface I18nContextValue {
    direction: TextDirection
    language: Language
    locale: string
    setLanguage: (language: Language, options?: { persist?: boolean }) => void
    t: TFn
}

export const createLanguageRequestGuard = (): {
    begin: () => number
    isCurrent: (request: number) => boolean
} => {
    let current = 0
    return {
        begin: () => {
            current += 1
            return current
        },
        isCurrent: (request) => request === current
    }
}

const I18nContext = createContext<I18nContextValue | null>(null)

const initializeLanguage = (): Language => {
    const initial = readInitialLanguage()
    setPackageLanguage(initial)
    applyDocumentLanguage(initial)
    return initial
}

// At module load rather than in the provider's first render: anything that
// calls t() before React mounts — the initial analytics page view, for one —
// would otherwise silently get the default language.
const initialLanguage = initializeLanguage()
export const i18nReady = loadPackageLanguage(initialLanguage)

export const I18nProvider: FC<{ children: ReactNode }> = ({
    children
}): ReactNode => {
    const [language, setLanguageState] = useState<Language>(initialLanguage)
    const languageRequests = useRef(createLanguageRequestGuard())

    const setLanguage = useCallback(
        (nextLanguage: Language, options?: { persist?: boolean }): void => {
            const request = languageRequests.current.begin()
            void loadPackageLanguage(nextLanguage).then(
                () => {
                    if (!languageRequests.current.isCurrent(request)) return
                    setPackageLanguage(nextLanguage)
                    applyDocumentLanguage(nextLanguage)
                    setLanguageState(nextLanguage)

                    // Transient switches (the URL-pinned marketing language) must not
                    // overwrite the visitor's stored product language.
                    if (options?.persist === false) return
                    try {
                        window.localStorage.setItem(
                            languageStorageKey,
                            nextLanguage
                        )
                    } catch {
                        return
                    }
                },
                () => {
                    return
                }
            )
        },
        []
    )

    const value = useMemo<I18nContextValue>(() => {
        const option = getLanguageOption(language)
        return {
            direction: option.direction,
            language,
            locale: option.locale,
            setLanguage,
            t: translate
        }
    }, [language, setLanguage])

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = (): I18nContextValue => {
    const value = useContext(I18nContext)
    if (!value) throw new Error('useI18n must be used within I18nProvider')
    return value
}

export { languageOptions }

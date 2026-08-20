import type { Language } from '../../types'

type Catalog = Readonly<Record<string, string>>

const catalogLoaders: Partial<
    Record<Language, () => Promise<{ default: Catalog }>>
> = {
    es: () => import('./es'),
    fr: () => import('./fr'),
    de: () => import('./de'),
    ja: () => import('./ja'),
    ko: () => import('./ko'),
    pt: () => import('./pt'),
    ru: () => import('./ru'),
    ar: () => import('./ar'),
    hi: () => import('./hi')
}

export const loadGeneratedTranslation = async (
    language: Language
): Promise<Catalog | undefined> => {
    const loader = catalogLoaders[language]
    return loader ? (await loader()).default : undefined
}

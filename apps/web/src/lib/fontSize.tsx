import type { FC, ReactNode } from 'react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

export type FontSizeMode = 'compact' | 'default' | 'large'

const fontSizeStorageKey = 'nca.web.fontSize'

const isFontSizeMode = (
    value: string | null | undefined
): value is FontSizeMode =>
    value === 'compact' || value === 'default' || value === 'large'

const readInitialFontSize = (): FontSizeMode => {
    if (typeof window === 'undefined') return 'default'

    try {
        const stored = window.localStorage.getItem(fontSizeStorageKey)
        if (isFontSizeMode(stored)) return stored
    } catch {
        const documentFontSize = document.documentElement.dataset.fontSize
        if (isFontSizeMode(documentFontSize)) return documentFontSize
    }

    const documentFontSize = document.documentElement.dataset.fontSize
    if (isFontSizeMode(documentFontSize)) return documentFontSize

    return 'default'
}

const applyFontSize = (fontSize: FontSizeMode): void => {
    if (typeof document === 'undefined') return

    document.documentElement.dataset.fontSize = fontSize
}

interface FontSizeContextValue {
    fontSize: FontSizeMode
    setFontSize: (fontSize: FontSizeMode) => void
}

const FontSizeContext = createContext<FontSizeContextValue | null>(null)

export const FontSizeProvider: FC<{ children: ReactNode }> = ({
    children
}): ReactNode => {
    const [fontSize, setFontSize] = useState<FontSizeMode>(() =>
        readInitialFontSize()
    )

    useEffect(() => {
        applyFontSize(fontSize)

        try {
            window.localStorage.setItem(fontSizeStorageKey, fontSize)
        } catch {
            return
        }
    }, [fontSize])

    const value = useMemo<FontSizeContextValue>(
        () => ({
            fontSize,
            setFontSize
        }),
        [fontSize]
    )

    return (
        <FontSizeContext.Provider value={value}>
            {children}
        </FontSizeContext.Provider>
    )
}

export const useFontSize = (): FontSizeContextValue => {
    const value = useContext(FontSizeContext)
    if (!value)
        throw new Error('useFontSize must be used within FontSizeProvider')
    return value
}

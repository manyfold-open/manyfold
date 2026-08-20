import type { FC, ReactNode } from 'react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

export type ThemeMode = 'light' | 'dark'

const themeStorageKey = 'nca.web.theme'

const isThemeMode = (value: string | null | undefined): value is ThemeMode =>
    value === 'light' || value === 'dark'

const readInitialTheme = (): ThemeMode => {
    if (typeof window === 'undefined') return 'light'

    try {
        const stored = window.localStorage.getItem(themeStorageKey)
        if (isThemeMode(stored)) return stored
    } catch {
        const documentTheme = document.documentElement.dataset.theme
        if (isThemeMode(documentTheme)) return documentTheme
    }

    const documentTheme = document.documentElement.dataset.theme
    if (isThemeMode(documentTheme)) return documentTheme

    return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
}

const applyTheme = (theme: ThemeMode): void => {
    if (typeof document === 'undefined') return

    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
}

interface ThemeContextValue {
    setTheme: (theme: ThemeMode) => void
    theme: ThemeMode
    toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export const ThemeProvider: FC<{ children: ReactNode }> = ({
    children
}): ReactNode => {
    const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme())

    useEffect(() => {
        applyTheme(theme)

        try {
            window.localStorage.setItem(themeStorageKey, theme)
        } catch {
            return
        }
    }, [theme])

    const value = useMemo<ThemeContextValue>(
        () => ({
            setTheme,
            theme,
            toggleTheme: () => {
                setTheme((current) => (current === 'light' ? 'dark' : 'light'))
            }
        }),
        [theme]
    )

    return (
        <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
    )
}

export const useTheme = (): ThemeContextValue => {
    const value = useContext(ThemeContext)
    if (!value) throw new Error('useTheme must be used within ThemeProvider')
    return value
}

import type { PublicNetmindConfig } from '@manyfold/shared'
import { useSyncExternalStore } from 'react'

// NetMind's login flow runs in the browser (it talks to NetMind directly), so
// its endpoint config is delivered via publicConfig (auth.config) and stashed
// here on auth boot. The values are public — there is no secret.
let current: PublicNetmindConfig | null = null

const listeners = new Set<() => void>()

export const setNetmindConfig = (config: PublicNetmindConfig | null): void => {
    current = config
    listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

// Reactive variant for components that may mount before the config arrives
// (the auth boot stashes it asynchronously in dev-token mode).
export const useNetmindConfigured = (): boolean =>
    useSyncExternalStore(subscribe, isNetmindConfigured)

export const getNetmindConfig = (): PublicNetmindConfig =>
    current ?? {
        authApi: '',
        accountsUrl: '',
        sysCode: '',
        registerUrl: '',
        keyProvision: false
    }

// Email/password sign-in needs the API endpoint + sysCode (sent on every NetMind
// request); without both, no flow can complete.
export const isNetmindConfigured = (): boolean =>
    Boolean(current?.authApi && current?.sysCode)

// OAuth additionally needs the accounts domain that hosts the auth.html popup.
export const isNetmindOAuthConfigured = (): boolean =>
    isNetmindConfigured() && Boolean(current?.accountsUrl)

// Reactive full-config accessor; overlay trees derive their own gates from it
// (e.g. flags the server surfaces that core UI has no use for).
/** @public consumed by the web-cloud overlay tree */
export const useNetmindConfig = (): PublicNetmindConfig | null =>
    useSyncExternalStore(subscribe, () => current)

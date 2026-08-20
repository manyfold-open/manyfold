import { useEffect, useState } from 'react'
import type { SdkUser } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { useAppAuth } from '@/lib/auth'

interface CurrentUserState {
    user: SdkUser | null
    isAdmin: boolean
    loading: boolean
    error: string | null
}

interface CachedCurrentUser {
    sessionKey: string
    user: SdkUser
}

let cached: CachedCurrentUser | null = null
let inflight: { sessionKey: string; promise: Promise<SdkUser> } | null = null

export const useCurrentUser = (): CurrentUserState => {
    const client = useApiClient()
    const { sessionKey } = useAppAuth()
    const currentCached = cached
    const cachedUser =
        currentCached && currentCached.sessionKey === sessionKey
            ? currentCached.user
            : null
    const [state, setState] = useState<CurrentUserState>(() => ({
        user: cachedUser,
        isAdmin: cachedUser?.role === 'admin',
        loading: Boolean(sessionKey) && cachedUser === null,
        error: null
    }))

    useEffect(() => {
        if (!sessionKey) {
            setState({
                user: null,
                isAdmin: false,
                loading: false,
                error: null
            })
            return
        }

        const currentCached = cached
        if (currentCached && currentCached.sessionKey === sessionKey) {
            setState({
                user: currentCached.user,
                isAdmin: currentCached.user.role === 'admin',
                loading: false,
                error: null
            })
            return
        }

        setState({
            user: null,
            isAdmin: false,
            loading: true,
            error: null
        })

        const p =
            inflight?.sessionKey === sessionKey
                ? inflight.promise
                : (inflight = {
                      sessionKey,
                      promise: client.auth
                          .me()
                          .then((u) => {
                              cached = { sessionKey, user: u }
                              if (inflight?.sessionKey === sessionKey)
                                  inflight = null
                              return u
                          })
                          .catch((e: Error) => {
                              if (inflight?.sessionKey === sessionKey)
                                  inflight = null
                              throw e
                          })
                  }).promise
        let cancelled = false
        p.then((u) => {
            if (cancelled) return
            setState({
                user: u,
                isAdmin: u.role === 'admin',
                loading: false,
                error: null
            })
        }).catch((e: Error) => {
            if (cancelled) return
            setState({
                user: null,
                isAdmin: false,
                loading: false,
                error: e.message
            })
        })
        return (): void => {
            cancelled = true
        }
    }, [client, sessionKey])

    return state
}

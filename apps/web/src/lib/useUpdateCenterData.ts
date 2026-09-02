import { useCallback, useEffect, useRef, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import {
    emptyUpdateCenterInputs,
    type UpdateCenterInputs
} from '@/lib/updateCenter'

export interface UpdateCenterData {
    inputs: UpdateCenterInputs
    loaded: boolean
    loading: boolean
    error: string | null
    refresh: () => Promise<void>
}

// Every category is fetched from its own list endpoint and joined on the
// client. A partial failure degrades that one category to empty rather than
// blanking the page: a broken skills scan should not hide a machine that needs
// a security update.
export const useUpdateCenterData = (active: boolean): UpdateCenterData => {
    const client = useApiClient()
    const [inputs, setInputs] = useState<UpdateCenterInputs>(
        emptyUpdateCenterInputs
    )
    const [loaded, setLoaded] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const cancelled = useRef(false)

    useEffect(() => {
        cancelled.current = false
        return () => {
            cancelled.current = true
        }
    }, [])

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true)
        let failure: unknown = null
        const orEmpty = <T,>(promise: Promise<T[]>): Promise<T[]> =>
            promise.catch((err: unknown) => {
                failure ??= err
                return []
            })
        const [daemonHosts, sandboxes, runtimes, frameworkCatalog, skillGroups] =
            await Promise.all([
                orEmpty(client.daemons.listHosts()),
                orEmpty(client.sandboxes.list()),
                orEmpty(client.agentRuntimes.list()),
                orEmpty(client.frameworkVersions.list()),
                orEmpty(client.skills.installed())
            ])
        if (cancelled.current) return
        setInputs({
            daemonHosts,
            sandboxes,
            runtimes,
            frameworkCatalog,
            skillGroups
        })
        setError(failure === null ? null : apiErrorMessage(failure))
        setLoaded(true)
        setLoading(false)
    }, [client])

    useEffect(() => {
        if (!active) return
        void refresh()
    }, [active, refresh])

    return { inputs, loaded, loading, error, refresh }
}

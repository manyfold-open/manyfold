import { useCallback, useEffect, useRef, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { updateRunStore, useUpdateRuns } from '@/lib/updateRunStore'
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
    const snapshot = useRef(emptyUpdateCenterInputs)
    const runs = useUpdateRuns()

    useEffect(() => {
        cancelled.current = false
        return () => {
            cancelled.current = true
        }
    }, [])

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true)
        let failure: unknown = null
        const orValue = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
            promise.catch((err: unknown) => {
                failure ??= err
                return fallback
            })
        const orEmpty = <T>(promise: Promise<T[]>): Promise<T[]> =>
            orValue(promise, [])
        const [
            daemonHosts,
            sandboxes,
            podHosts,
            runtimes,
            frameworkCatalog,
            skillGroups,
            cliVersions
        ] = await Promise.all([
            orValue(client.daemons.listHosts(), snapshot.current.daemonHosts),
            orEmpty(client.sandboxes.list()),
            orEmpty(client.podHosts.list()),
            orEmpty(client.agentRuntimes.list()),
            orEmpty(client.frameworkVersions.list()),
            orValue(client.skills.installed(), snapshot.current.skillGroups),
            orValue(client.cliVersions.list(), { stable: [], dev: [] })
        ])
        if (cancelled.current) return
        updateRunStore.reconcile({ daemonHosts, skillGroups })
        snapshot.current = {
            daemonHosts,
            sandboxes,
            podHosts,
            runtimes,
            frameworkCatalog,
            skillGroups,
            cliVersions
        }
        setInputs(snapshot.current)
        setError(failure === null ? null : apiErrorMessage(failure))
        setLoaded(true)
        setLoading(false)
    }, [client])

    useEffect(() => {
        if (!active) return
        void refresh()
    }, [active, refresh])

    const pending =
        inputs.skillGroups.some((group) =>
            group.skills.some(
                (skill) => skill.materializeStatus === 'installing'
            )
        ) ||
        Object.values(runs).some(
            (run) => run.state === 'deferred' || run.state === 'installing'
        )
    useEffect(() => {
        if (!active || !loaded || loading || !pending) return
        const timer = window.setTimeout(() => void refresh(), 5_000)
        return () => window.clearTimeout(timer)
    }, [active, loaded, loading, pending, refresh])

    return { inputs, loaded, loading, error, refresh }
}

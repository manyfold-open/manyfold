import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeAccountView } from '@manyfold/shared'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'

// The host account probe for one runtime, shared by the runtime page and the
// composer's local-config panel. Mounting never wakes a sleeping sandbox —
// `probe(true)` is the user's explicit click — and a wake taken here holds
// the sandbox's awake lease until the surface unmounts, so the sign-in or
// refresh it was for does not pay a second wake.
export const useRuntimeAccount = (
    runtimeId: string | null
): {
    view: RuntimeAccountView | null
    loading: boolean
    error: string | null
    probe: (wake: boolean, refreshUsage?: boolean) => Promise<void>
} => {
    const client = useApiClient()
    const [view, setView] = useState<RuntimeAccountView | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const wokeRef = useRef(false)

    const probe = useCallback(
        async (wake: boolean, refreshUsage = false): Promise<void> => {
            if (!runtimeId) return
            if (wake) wokeRef.current = true
            setLoading(true)
            setError(null)
            try {
                setView(
                    await client.agentRuntimes.getAccount(runtimeId, {
                        wake,
                        refreshUsage
                    })
                )
            } catch (e) {
                setError(apiErrorMessage(e))
            } finally {
                setLoading(false)
            }
        },
        [client, runtimeId]
    )

    useEffect(() => {
        setView(null)
        setError(null)
        if (!runtimeId) return
        let cancelled = false
        setLoading(true)
        client.agentRuntimes
            .getAccount(runtimeId, { wake: false, refreshUsage: false })
            .then((next) => {
                if (!cancelled) setView(next)
            })
            .catch((e) => {
                if (!cancelled) setError(apiErrorMessage(e))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return (): void => {
            cancelled = true
        }
    }, [client, runtimeId])

    useEffect(
        () => (): void => {
            if (!runtimeId || !wokeRef.current) return
            wokeRef.current = false
            void client.runtimeAuth.release(runtimeId).catch(() => null)
        },
        [client, runtimeId]
    )

    return { view, loading, error, probe }
}

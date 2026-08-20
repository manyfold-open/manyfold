import { useMemo } from 'react'
import { createClient, type NcaClient } from '@manyfold/sdk'
import { useAppAuth } from '@/lib/auth'

export const useApiClient = (): NcaClient => {
    const { getToken } = useAppAuth()
    return useMemo(
        () =>
            createClient({
                baseUrl: import.meta.env.VITE_API_URL ?? '/api',
                token: getToken
            }),
        [getToken]
    )
}

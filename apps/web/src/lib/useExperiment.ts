import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCurrentUser } from '@/lib/useCurrentUser'

export interface UseExperimentResult {
    variant: string
    loading: boolean
    source: 'preview' | 'server' | 'fallback'
}

export const useExperiment = (
    key: string,
    fallback: string
): UseExperimentResult => {
    const { user, loading } = useCurrentUser()
    const [params] = useSearchParams()
    return useMemo(() => {
        const previewVariant = params.get(`variant.${key}`) ?? params.get('variant')
        if (previewVariant && user?.role === 'admin')
            return { variant: previewVariant, loading: false, source: 'preview' }
        const assigned = user?.experiments?.[key]
        if (assigned)
            return { variant: assigned, loading: false, source: 'server' }
        return { variant: fallback, loading, source: 'fallback' }
    }, [fallback, key, loading, params, user])
}

export const useExperimentVariant = (key: string, fallback: string): string =>
    useExperiment(key, fallback).variant

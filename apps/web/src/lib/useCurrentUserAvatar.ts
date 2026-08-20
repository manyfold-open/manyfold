import { useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface CurrentUserAvatar {
    imageUrl: string | null
    label: string
}

export const useCurrentUserAvatar = (): CurrentUserAvatar => {
    const client = useApiClient()
    const { user } = useCurrentUser()
    const [imageUrl, setImageUrl] = useState<string | null>(null)
    const avatarUpdatedAt = user?.avatarUpdatedAt ?? null

    useEffect(() => {
        setImageUrl(null)
        if (!avatarUpdatedAt) return

        let cancelled = false
        let objectUrl: string | null = null
        void client.profile
            .fetchAvatar()
            .then((blob) => {
                if (cancelled || !blob) return
                objectUrl = URL.createObjectURL(blob)
                setImageUrl(objectUrl)
            })
            .catch(() => undefined)

        return () => {
            cancelled = true
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [avatarUpdatedAt, client])

    return {
        imageUrl,
        label: user?.displayName?.trim() || user?.email || 'A'
    }
}

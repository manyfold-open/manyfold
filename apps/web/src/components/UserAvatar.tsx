import type { FC, ReactNode } from 'react'

interface UserAvatarProps {
    imageUrl: string | null
    label: string
    className?: string
}

const avatarInitials = (label: string): string => {
    const source = label.trim().split('@')[0]
    const words = source.split(/\s+/).filter(Boolean)
    const pair =
        words.length >= 2
            ? `${words[0].charAt(0)}${words[1].charAt(0)}`
            : source.slice(0, 2)
    return (pair || 'A').toUpperCase()
}

const UserAvatar: FC<UserAvatarProps> = ({
    imageUrl,
    label,
    className
}): ReactNode => (
    <span
        className={[
            'shadow-ring-light bg-avatar-bg text-avatar-fg inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium',
            className ?? ''
        ].join(' ')}
        aria-hidden='true'
    >
        {imageUrl ? (
            <img src={imageUrl} alt='' className='h-full w-full object-cover' />
        ) : (
            avatarInitials(label)
        )}
    </span>
)

export default UserAvatar

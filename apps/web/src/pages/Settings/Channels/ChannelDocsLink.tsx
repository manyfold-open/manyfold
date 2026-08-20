import type { ChannelProviderName } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { ExternalLinkIcon } from '@/components/icons'
import { channelDocsHref } from '@/lib/channelMeta'

interface ChannelDocsLinkProps {
    provider: ChannelProviderName
    label?: string
    className?: string
}

const ChannelDocsLink: FC<ChannelDocsLinkProps> = ({
    provider,
    label,
    className
}): ReactNode => {
    const { t } = useI18n()
    const resolvedLabel = label ?? t('web.channels.settings.setupDocs')
    const href = channelDocsHref(provider)
    if (!href) return null
    return (
        <a
            href={href}
            target='_blank'
            rel='noopener noreferrer'
            className={[
                'text-ui text-muted shadow-ring-light hover:text-fg inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2.5 font-medium transition-colors',
                className ?? ''
            ].join(' ')}
        >
            <ExternalLinkIcon className='h-3.5 w-3.5' />
            {resolvedLabel}
        </a>
    )
}

export default ChannelDocsLink

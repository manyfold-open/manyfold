import type { ConnectionProvider } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'

const GithubIcon: FC<{ className?: string }> = ({ className }): ReactNode => (
    <svg
        viewBox='0 0 24 24'
        className={className}
        aria-hidden='true'
        fill='currentColor'
    >
        <path d='M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' />
    </svg>
)

const CloudflareIcon: FC<{ className?: string }> = ({
    className
}): ReactNode => (
    <svg
        viewBox='0 0 24 24'
        className={className}
        aria-hidden='true'
        fill='#F38020'
    >
        <path d='M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.5-1.0645-.5215l-8.6716-.1104a.1559.1559 0 01-.1333-.0713c-.0264-.043-.0334-.0996-.0182-.1523.0264-.0817.1053-.1444.1929-.1487l8.7482-.1113c1.0378-.0478 2.1616-.8896 2.5552-1.9155l.499-1.3013c.0211-.0561.0264-.1123.0143-.168-.5625-2.5405-2.8306-4.4363-5.5445-4.4363-2.5006 0-4.6242 1.6118-5.3877 3.8525-.4926-.3686-1.1216-.5654-1.7995-.499-1.2026.1197-2.1704 1.0876-2.29 2.2901-.0313.3105-.0079.6128.0645.897C1.5686 13.171 0 14.7754 0 16.752c0 .1787.0132.354.0381.5259.0117.0854.0846.1494.1709.1494h16.0091c.0947 0 .1821-.0669.209-.1582l.0817-.4244zm2.7743-5.5815c-.0796 0-.1592.0023-.2378.0068-.0552.0034-.1035.0415-.1225.0947l-.3406.9528c-.1475.5068-.0908.9707.1553 1.3155.2246.3163.6045.4999 1.0645.5214l1.8547.1104c.0518.0023.0996.0288.1284.0713.0288.0439.0341.1005.0182.1533-.0264.0806-.1053.1434-.1929.1478l-1.9275.1113c-1.0466.0488-2.1704.8896-2.5639 1.9145l-.1387.3628c-.0284.0732.0248.1533.1035.1533h6.6349c.0791 0 .1489-.0518.1719-.1279.1148-.4097.1768-.8413.1768-1.2876 0-2.6299-2.1323-4.7627-4.7627-4.7627' />
    </svg>
)

const ComposioIcon: FC<{ className?: string }> = ({ className }): ReactNode => (
    <svg
        viewBox='0 0 31.797 36.774'
        className={className}
        aria-hidden='true'
        fill='currentColor'
    >
        <path
            d='M 31.152 10.36 L 10.432 6.123 C 9.786 5.992 9.116 6.158 8.605 6.574 C 8.095 6.991 7.798 7.614 7.797 8.273 L 7.797 28.426 C 7.798 29.085 8.095 29.709 8.606 30.125 C 9.116 30.542 9.787 30.707 10.433 30.576 L 31.152 26.339'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.05'
            strokeLinecap='round'
            strokeLinejoin='round'
        />
        <path d='M 15.15 2.716 C 15.15 0.769 17.14 -0.532 18.922 0.213 L 19.007 0.25 L 19.008 0.25 L 30.092 5.37 C 31.058 5.809 31.678 6.774 31.675 7.835 L 31.675 12.171 C 31.676 12.927 31.361 13.65 30.806 14.164 C 30.251 14.679 29.507 14.938 28.753 14.881 L 16.201 13.944 L 16.201 22.76 L 28.751 21.823 L 28.899 21.815 C 29.628 21.797 30.333 22.075 30.854 22.585 C 31.375 23.096 31.668 23.795 31.666 24.524 L 31.666 28.86 C 31.666 29.923 31.04 30.88 30.085 31.324 L 30.083 31.324 L 19.009 36.434 C 17.203 37.271 15.15 35.954 15.15 33.97 L 15.15 29.838 C 15.067 29.871 14.979 29.891 14.89 29.898 L 8.765 30.338 C 8.52 30.356 8.279 30.271 8.099 30.104 C 7.919 29.937 7.817 29.702 7.817 29.457 L 7.817 24.909 C 7.817 24.733 7.87 24.567 7.961 24.428 L 2.921 24.804 L 2.92 24.804 C 2.167 24.857 1.425 24.596 0.872 24.083 C 0.319 23.569 0.003 22.849 0 22.094 L 0 14.61 C 0 13.853 0.315 13.131 0.87 12.617 C 1.425 12.102 2.169 11.843 2.923 11.9 L 7.851 12.268 C 7.829 12.191 7.817 12.111 7.817 12.03 L 7.817 7.24 C 7.817 6.54 8.443 6.006 9.134 6.117 L 14.967 7.05 C 15.031 7.06 15.092 7.078 15.15 7.1 L 15.15 2.717 Z M 28.834 22.87 L 28.832 22.87 L 16.202 23.813 L 16.202 29.294 L 30.617 26.281 L 30.617 24.52 L 30.615 24.43 C 30.591 23.985 30.389 23.568 30.054 23.275 C 29.719 22.981 29.279 22.835 28.835 22.87 Z M 7.615 13.303 C 7.703 13.441 7.755 13.603 7.755 13.778 L 7.755 23.088 C 7.754 23.193 7.735 23.296 7.698 23.394 L 15.15 22.838 L 15.15 13.865 Z M 16.201 12.891 L 28.831 13.834 L 28.833 13.834 L 28.923 13.839 C 29.371 13.848 29.805 13.677 30.125 13.363 C 30.445 13.049 30.625 12.619 30.625 12.171 L 30.625 10.348 L 16.2 7.333 L 16.2 12.891 Z' />
    </svg>
)

const META: Record<
    ConnectionProvider,
    { labelKey: string; Icon: FC<{ className?: string }> }
> = {
    github: {
        labelKey: 'web.connectionProviders.github',
        Icon: GithubIcon
    },
    cloudflare: {
        labelKey: 'web.connectionProviders.cloudflare',
        Icon: CloudflareIcon
    },
    composio: {
        labelKey: 'web.connectionProviders.composio',
        Icon: ComposioIcon
    }
}

export const CONNECTION_PROVIDERS: ConnectionProvider[] = [
    'github',
    'cloudflare',
    'composio'
]

// The single source for the per-agent binding field. An agent points at one
// connection per provider through `extras`, so the list page's bound-agent
// count, the detail page's Linked agents panel and the agent-side selects all
// have to agree on this mapping.
const EXTRAS_KEY: Record<ConnectionProvider, string> = {
    github: 'githubConnectionId',
    cloudflare: 'cloudflareConnectionId',
    composio: 'composioConnectionId'
}

export interface ConnectionBindPatch {
    githubConnectionId?: string | null
    cloudflareConnectionId?: string | null
    composioConnectionId?: string | null
}

export const connectionExtrasKey = (provider: ConnectionProvider): string =>
    EXTRAS_KEY[provider]

export const connectionRef = (agent: SdkAgent, key: string): string | null =>
    ((agent.extras ?? {}) as Record<string, string | null>)[key] ?? null

export const boundConnectionId = (
    agent: SdkAgent,
    provider: ConnectionProvider
): string | null => connectionRef(agent, EXTRAS_KEY[provider])

export const bindPatch = (
    provider: ConnectionProvider,
    value: string | null
): ConnectionBindPatch => {
    if (provider === 'github') return { githubConnectionId: value }
    if (provider === 'cloudflare') return { cloudflareConnectionId: value }
    return { composioConnectionId: value }
}

export const connectionProviderLabel = (provider: ConnectionProvider): string =>
    t(META[provider].labelKey)

export const ConnectionProviderIcon: FC<{
    provider: ConnectionProvider
    className?: string
}> = ({ provider, className }): ReactNode => {
    const { Icon } = META[provider]
    return <Icon className={className} />
}

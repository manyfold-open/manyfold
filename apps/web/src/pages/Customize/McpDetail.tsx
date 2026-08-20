import type {
    McpCatalogEntry,
    McpConfigFormat
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import EmptyState from '@/components/EmptyState'
import { GhostCatalogDetail } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import MarkdownText from '@/components/chat/MarkdownText'
import { ArrowLeftIcon, ExternalLinkIcon, McpIcon } from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage, apiErrorMessage } from '@/lib/errorMessage'
import { githubAvatarUrlFromRepositoryUrl } from '@/lib/githubAvatar'
import { useI18n } from '@/lib/i18n'
import { mcpServerJsonSnippet, mcpServerTomlSnippet } from '@/lib/mcpSnippet'
import InstallMcpDialog from './InstallMcpDialog'
import { mcpTransportLabel } from './McpCatalog'

const hasPlaceholders = (entry: McpCatalogEntry): boolean =>
    [
        ...Object.values(entry.headers ?? {}),
        ...Object.values(entry.env ?? {}),
        ...(entry.args ?? [])
    ].some((value) => value.includes('${'))

const McpDetail: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const params = useParams<{ serverId: string }>()
    const [entry, setEntry] = useState<McpCatalogEntry | null>(null)
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const [error, setError] = useState<string | null>(null)
    const [format, setFormat] = useState<McpConfigFormat>('json')
    const [installOpen, setInstallOpen] = useState(false)
    const [iconFailed, setIconFailed] = useState(false)
    const [copying, setCopying] = useState(false)
    const [copyError, setCopyError] = useState<string | null>(null)

    const copyToLibrary = async (): Promise<void> => {
        if (!entry || copying) return
        setCopying(true)
        setCopyError(null)
        try {
            await client.mcp.library.create({
                serverKey: entry.id,
                name: entry.name,
                description: entry.description || undefined,
                transport: entry.transport,
                url: entry.url,
                headers: entry.headers,
                command: entry.command,
                args: entry.args,
                env: entry.env
            })
            navigate('/mcp/library')
        } catch (err) {
            setCopyError(
                err instanceof ApiError && err.status === 409
                    ? apiErrorDetailMessage(err)
                    : apiErrorMessage(err)
            )
        } finally {
            setCopying(false)
        }
    }

    useEffect(() => {
        if (!params.serverId) {
            setLoading(false)
            return
        }
        setLoading(true)
        setEntry(null)
        setIconFailed(false)
        client.mcp
            .catalogEntry(params.serverId)
            .then((item) => {
                setEntry(item)
                setError(null)
            })
            .catch((err: unknown) => {
                if (err instanceof ApiError && err.status === 404) {
                    setError(null)
                    return
                }
                setError(apiErrorMessage(err))
            })
            .finally(() => setLoading(false))
    }, [client, params.serverId])

    const snippet = useMemo(() => {
        if (!entry) return ''
        return format === 'toml'
            ? mcpServerTomlSnippet(entry)
            : mcpServerJsonSnippet('claude-code', entry)
    }, [entry, format])

    const iconUrl = entry
        ? (entry.iconUrl ?? githubAvatarUrlFromRepositoryUrl(entry.homepageUrl))
        : null
    const showIcon = !!iconUrl && !iconFailed

    return (
        <>
            <header className='mb-6'>
                <Link
                    to='/mcp'
                    className='text-caption text-muted hover:text-fg inline-flex items-center gap-1.5 transition-colors'
                >
                    <ArrowLeftIcon className='h-3.5 w-3.5' />
                    {t('web.customize.backToMcp')}
                </Link>
            </header>

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            {gate.showLoading && <GhostCatalogDetail aside={false} />}

            {!loading && !gate.showLoading && !entry && !error && (
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.customize.mcpNotFound')}
                />
            )}

            {!loading && !gate.showLoading && entry && (
                <>
                    {copyError && (
                        <div className='workbench-alert-error mb-5'>
                            {copyError}
                        </div>
                    )}
                    <div className='mb-6 flex flex-wrap items-start justify-between gap-4'>
                        <div className='flex min-w-0 items-start gap-3'>
                            <div className='bg-soft text-subtle flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm'>
                                {showIcon ? (
                                    <img
                                        src={iconUrl ?? undefined}
                                        alt=''
                                        className='h-full w-full object-cover'
                                        onError={() => setIconFailed(true)}
                                    />
                                ) : (
                                    <McpIcon className='h-5 w-5' />
                                )}
                            </div>
                            <div className='min-w-0'>
                                <div className='flex flex-wrap items-center gap-2'>
                                    <h1 className='text-h2 text-fg tracking-tight'>
                                        {entry.name}
                                    </h1>
                                    <span className='bg-soft text-caption text-subtle rounded-md px-2 py-0.5'>
                                        {mcpTransportLabel(t, entry.transport)}
                                    </span>
                                    {entry.featured && (
                                        <span className='bg-success-bg text-success text-caption rounded-md px-2 py-0.5'>
                                            {t('web.customize.featuredBadge')}
                                        </span>
                                    )}
                                </div>
                                <p className='text-ui text-muted mt-2'>
                                    {entry.description}
                                </p>
                                {(entry.category || entry.tags.length > 0) && (
                                    <div className='mt-2 flex flex-wrap gap-1.5'>
                                        {entry.category && (
                                            <span className='text-caption text-fg bg-soft rounded-md px-1.5 py-0.5'>
                                                {entry.category.name}
                                            </span>
                                        )}
                                        {entry.tags.map((tag) => (
                                            <span
                                                key={tag}
                                                className='text-caption text-subtle bg-soft rounded-md px-1.5 py-0.5'
                                            >
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <a
                                    href={entry.homepageUrl}
                                    target='_blank'
                                    rel='noreferrer'
                                    className='text-ui text-muted hover:text-fg mt-2 inline-flex items-center gap-1.5 font-medium transition-colors'
                                >
                                    {t('web.customize.visitHomepage')}
                                    <ExternalLinkIcon className='h-3.5 w-3.5' />
                                </a>
                            </div>
                        </div>
                        <div className='flex shrink-0 flex-wrap items-center gap-2'>
                            <button
                                type='button'
                                disabled={copying}
                                onClick={() => void copyToLibrary()}
                                className='workbench-button-secondary'
                            >
                                {copying
                                    ? t('common.loading')
                                    : t('web.customize.myMcpCopyToLibrary')}
                            </button>
                            <button
                                type='button'
                                onClick={() => setInstallOpen(true)}
                                className='workbench-button-primary'
                            >
                                {t('web.customize.installToAgent')}
                            </button>
                        </div>
                    </div>

                    {entry.longDescription && (
                        <section className='settings-card mb-4 p-5'>
                            <div className='settings-card-label mb-3'>
                                {t('web.customize.aboutTitle')}
                            </div>
                            <MarkdownText text={entry.longDescription} />
                        </section>
                    )}

                    <section className='settings-card p-4'>
                        <div className='mb-3 flex items-center justify-between gap-3'>
                            <div className='settings-card-label'>
                                {t('web.customize.configPreview')}
                            </div>
                            <div className='flex gap-1'>
                                {(['json', 'toml'] as const).map((item) => (
                                    <button
                                        key={item}
                                        type='button'
                                        onClick={() => setFormat(item)}
                                        className={[
                                            'text-caption h-7 rounded-md px-2.5 font-medium transition-colors',
                                            format === item
                                                ? 'bg-soft text-fg'
                                                : 'text-muted hover:text-fg'
                                        ].join(' ')}
                                    >
                                        {item.toUpperCase()}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <pre className='bg-soft text-caption text-fg overflow-x-auto whitespace-pre rounded-md p-3 font-mono'>
                            {snippet}
                        </pre>
                        {hasPlaceholders(entry) && (
                            <p className='text-caption text-muted mt-3'>
                                {t('web.customize.placeholdersNote')}
                            </p>
                        )}
                    </section>

                    {installOpen && (
                        <InstallMcpDialog
                            entry={entry}
                            onClose={() => setInstallOpen(false)}
                        />
                    )}
                </>
            )}
        </>
    )
}

export default McpDetail

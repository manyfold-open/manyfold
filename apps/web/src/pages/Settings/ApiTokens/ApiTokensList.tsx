import type { ApiTokenSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CascadeShell } from '@/components/CascadeShell'
import { PlusIcon } from '@/components/icons'
import { GhostRailRows } from '@/components/Loading'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useApiClient } from '@/lib/apiClient'
import {
    API_TOKEN_STATUS_DOT,
    apiTokenStatus,
    apiTokenStatusLabelKey
} from '@/lib/apiTokenStatus'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import ApiTokenDetail from '@/pages/Settings/ApiTokens/ApiTokenDetail'
import ApiTokenNew from '@/pages/Settings/ApiTokens/ApiTokenNew'
import ApiTokensDashboard from '@/pages/Settings/ApiTokens/ApiTokensDashboard'

// Reserved path segments under api-tokens/*: token ids are prefixed ObjectIds,
// so a bare word can never collide with one. Both pages render in the detail
// pane so the rail stays alongside them.
const DASHBOARD_SEGMENT = 'dashboard'
const NEW_SEGMENT = 'new'

const TokenLeaf: FC<{
    token: ApiTokenSummary
    selected: boolean
    onSelect: () => void
}> = ({ token, selected, onSelect }): ReactNode => {
    const { t } = useI18n()
    const status = apiTokenStatus(token)
    return (
        <button
            type='button'
            onClick={onSelect}
            aria-current={selected ? 'true' : undefined}
            className={[
                'flex w-full items-center gap-2.5 rounded-sm py-2 pl-2 pr-2.5 text-left transition-colors',
                selected ? 'bg-active-session' : 'hover:bg-rail-hover'
            ].join(' ')}
        >
            <span className='min-w-0 flex-1'>
                <span className='text-ui text-fg block truncate'>
                    {token.name}
                </span>
                <span className='text-caption text-subtle block truncate'>
                    {t(apiTokenStatusLabelKey(status))}
                </span>
            </span>
            <span
                className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    API_TOKEN_STATUS_DOT[status]
                ].join(' ')}
            />
        </button>
    )
}

const ApiTokensList: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const navigate = useNavigate()
    const { confirm, confirmDialog } = useProductConfirm()
    const segment = useParams()['*'] ?? ''
    const onDashboard = segment === DASHBOARD_SEGMENT
    const onNew = segment === NEW_SEGMENT
    const selectedId = onDashboard || onNew ? null : segment || null
    // The bare URL keeps the rail on mobile and shows the dashboard beside it;
    // every explicit segment is a selection that takes over the screen.
    const hasSelection = segment !== ''

    const [tokens, setTokens] = useState<ApiTokenSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    // §10.8: the rail ghosts on the cold load so "no tokens" never appears
    // before we know it is true — that reads as "your tokens are gone".
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setTokens(await client.apiTokens.list())
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const revoke = async (id: string): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.apiTokens.revokeTitle'),
                description: t('web.apiTokens.revokeDescription'),
                confirmLabel: t('web.apiTokens.revoke'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBusy(true)
        setError(null)
        try {
            await client.apiTokens.revoke(id)
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const renderRail = (): ReactNode => {
        if (gate.showLoading) return <GhostRailRows rows={3} />
        if (loading) return null
        if (error)
            return (
                <div className='workbench-alert-error mx-1 my-2'>{error}</div>
            )
        if (tokens.length === 0)
            return (
                <div className='text-caption text-subtle px-3 py-4'>
                    {t('web.apiTokens.empty')}
                </div>
            )
        return tokens.map((token) => (
            <TokenLeaf
                key={token.id}
                token={token}
                selected={token.id === selectedId}
                onSelect={() => navigate(`/settings/api-tokens/${token.id}`)}
            />
        ))
    }

    return (
        <>
            <CascadeShell
                railLabel={t('web.apiTokens.title')}
                hasSelection={hasSelection}
                rail={
                    <>
                        <div className='shrink-0 p-3'>
                            <div className='flex items-center justify-between'>
                                <Link
                                    to={`/settings/api-tokens/${DASHBOARD_SEGMENT}`}
                                    aria-current={
                                        !hasSelection ? 'page' : undefined
                                    }
                                    className='hover:bg-rail-hover -mx-1.5 flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 transition-colors'
                                >
                                    <h2 className='text-h3 text-fg tracking-tight'>
                                        {t('web.apiTokens.title')}
                                    </h2>
                                    <span className='tag tag-neutral tabular-nums'>
                                        {tokens.length}
                                    </span>
                                </Link>
                                <Link
                                    to={`/settings/api-tokens/${NEW_SEGMENT}`}
                                    aria-label={t('web.apiTokens.createTitle')}
                                    className='text-muted hover:text-fg hover:bg-rail-hover flex h-7 w-7 items-center justify-center rounded-full transition-colors'
                                >
                                    <PlusIcon className='h-4 w-4' />
                                </Link>
                            </div>
                        </div>

                        <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-2'>
                            {renderRail()}
                        </div>

                        <div className='shrink-0 p-2'>
                            <Link
                                to={`/settings/api-tokens/${NEW_SEGMENT}`}
                                className='workbench-button-primary h-9 w-full justify-center'
                            >
                                {t('web.apiTokens.create')}
                            </Link>
                        </div>
                    </>
                }
            >
                {onNew ? (
                    <ApiTokenNew onCreated={refresh} />
                ) : selectedId ? (
                    <ApiTokenDetail
                        token={
                            tokens.find((row) => row.id === selectedId) ?? null
                        }
                        // The list is what proves a token is missing, so the
                        // detail page must not redirect while it is still
                        // loading — a deep link would bounce to the dashboard.
                        loading={loading}
                        busy={busy}
                        onRevoke={(id) => void revoke(id)}
                    />
                ) : (
                    !loading && (
                        <ApiTokensDashboard
                            tokens={tokens}
                            onSelect={(id) =>
                                navigate(`/settings/api-tokens/${id}`)
                            }
                        />
                    )
                )}
            </CascadeShell>
            {confirmDialog}
        </>
    )
}

export default ApiTokensList

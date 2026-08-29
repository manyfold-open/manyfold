import type { ApiTokenSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CascadeShell } from '@/components/CascadeShell'
import {
    ChevronDownIcon,
    ChevronUpIcon,
    HistoryIcon,
    ListViewIcon,
    PlusIcon,
    ShieldCheckIcon,
    ZapIcon
} from '@/components/icons'
import { GhostRailRows } from '@/components/Loading'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useApiClient } from '@/lib/apiClient'
import {
    API_TOKEN_STATUS_DOT,
    apiTokenStatus,
    apiTokenStatusLabelKey,
    type ApiTokenStatus
} from '@/lib/apiTokenStatus'
import {
    GroupByControl,
    type GroupByOption,
    GroupHeader,
    type Health,
    useCascadeState
} from '@/lib/cascade'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n, type TFn } from '@/lib/i18n'
import ApiTokenDetail from '@/pages/Settings/ApiTokens/ApiTokenDetail'
import ApiTokenNew from '@/pages/Settings/ApiTokens/ApiTokenNew'
import ApiTokensDashboard from '@/pages/Settings/ApiTokens/ApiTokensDashboard'

// Reserved path segments under api-tokens/*: token ids are prefixed ObjectIds,
// so a bare word can never collide with one. Both pages render in the detail
// pane so the rail stays alongside them.
const DASHBOARD_SEGMENT = 'dashboard'
const NEW_SEGMENT = 'new'

type GroupBy = 'none' | 'status' | 'scope' | 'expiry'

const TOKEN_DIMS = ['none', 'status', 'scope', 'expiry'] as const

const STATUS_ORDER: ApiTokenStatus[] = ['active', 'expired', 'revoked']

interface TokenGroup {
    key: string
    label: string
    count: number
    health: Health
    items: ApiTokenSummary[]
}

// Expiry is the only end state nobody chose: a revoked token stopped working
// because you said so, an expired one stopped on its own. Only the second is
// worth flagging on a collapsed header.
const groupHealth = (items: ApiTokenSummary[]): Health =>
    items.some((token) => apiTokenStatus(token) === 'expired') ? 'warn' : null

// A token normally carries exactly one scope — the create form issues one, and
// the multi-scope agent grants are hidden from this list. The bucket keeps the
// grouping honest for the ones that do arrive with several.
const scopeBucket = (
    token: ApiTokenSummary,
    t: TFn
): { key: string; label: string } => {
    if (token.scopes.length !== 1)
        return { key: 'sc:*', label: t('web.apiTokens.scopesMultiple') }
    const scope = token.scopes[0]
    const label =
        scope === 'chat.completions'
            ? t('web.apiTokens.scopeChat')
            : scope === 'api.full'
              ? t('web.apiTokens.scopeFull')
              : scope
    return { key: `sc:${scope}`, label }
}

// Deliberately not grouping by createdVia: the plain create path leaves it
// null (only the CLI and grant flows set it), so on most accounts that
// dimension is a single "Unknown" bucket. Expiry always splits meaningfully,
// and "which of these never die?" is the question this rail exists to answer.
const expiryBucket = (
    token: ApiTokenSummary,
    t: TFn
): { key: string; label: string } =>
    token.expiresAt
        ? { key: 'ex:dated', label: t('web.apiTokens.expires') }
        : { key: 'ex:never', label: t('web.apiTokens.expiryNever') }

const TokenLeaf: FC<{
    token: ApiTokenSummary
    selected: boolean
    indentClass: string
    onSelect: () => void
}> = ({ token, selected, indentClass, onSelect }): ReactNode => {
    const { t } = useI18n()
    const status = apiTokenStatus(token)
    return (
        <button
            type='button'
            onClick={onSelect}
            aria-current={selected ? 'true' : undefined}
            className={[
                'flex w-full items-center gap-2.5 rounded-sm py-2 pr-2.5 text-left transition-colors',
                indentClass,
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
    const lastRevealed = useRef<string | null>(null)

    const {
        groupBy,
        setGroupBy,
        expanded,
        toggle,
        collapseAll,
        expandAll,
        reveal
    } = useCascadeState('mf.apiTokens.cascade.v1', TOKEN_DIMS, 'none')

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

    const groups = useMemo<TokenGroup[]>(() => {
        // None renders one unheadered group, so the header-only fields stay
        // empty: the rail lists every token flat, in the API's own order.
        if (groupBy === 'none')
            return tokens.length === 0
                ? []
                : [
                      {
                          key: 'all',
                          label: '',
                          count: tokens.length,
                          health: null,
                          items: tokens
                      }
                  ]

        if (groupBy === 'status') {
            const out: TokenGroup[] = []
            for (const status of STATUS_ORDER) {
                const items = tokens.filter(
                    (token) => apiTokenStatus(token) === status
                )
                if (items.length === 0) continue
                out.push({
                    key: `st:${status}`,
                    label: t(apiTokenStatusLabelKey(status)),
                    count: items.length,
                    health: groupHealth(items),
                    items
                })
            }
            return out
        }

        // Insertion order preserved, so scope and expiry groups follow the
        // same most-recent-first order the flat list already uses.
        const bucket = groupBy === 'scope' ? scopeBucket : expiryBucket
        const out: TokenGroup[] = []
        const byKey = new Map<string, TokenGroup>()
        for (const token of tokens) {
            const { key, label } = bucket(token, t)
            let group = byKey.get(key)
            if (!group) {
                group = { key, label, count: 0, health: null, items: [] }
                byKey.set(key, group)
                out.push(group)
            }
            group.items.push(token)
        }
        for (const group of out) {
            group.count = group.items.length
            group.health = groupHealth(group.items)
        }
        return out
    }, [tokens, groupBy, t])

    const allKeys = useMemo(() => groups.map((g) => g.key), [groups])

    const keysForSelection = useCallback(
        (id: string): string[] => {
            if (groupBy === 'none') return []
            const token = tokens.find((row) => row.id === id)
            if (!token) return []
            if (groupBy === 'status') return [`st:${apiTokenStatus(token)}`]
            if (groupBy === 'scope') return [scopeBucket(token, t).key]
            return [expiryBucket(token, t).key]
        },
        [tokens, groupBy, t]
    )

    useEffect(() => {
        if (tokens.length === 0 || !selectedId) return
        const token = `${groupBy}|${selectedId}`
        if (lastRevealed.current === token) return
        lastRevealed.current = token
        const keys = keysForSelection(selectedId)
        if (keys.length > 0) reveal(keys)
    }, [tokens, selectedId, groupBy, keysForSelection, reveal])

    const isOpen = (key: string): boolean => expanded.has(key)
    const anyExpanded = expanded.size > 0

    const groupByOptions: ReadonlyArray<GroupByOption<GroupBy>> = [
        {
            value: 'none',
            label: t('web.channels.settings.groupBy.none'),
            icon: ListViewIcon
        },
        {
            value: 'status',
            label: t('web.channels.settings.groupBy.status'),
            icon: ZapIcon
        },
        {
            value: 'scope',
            label: t('web.apiTokens.scopesTitle'),
            icon: ShieldCheckIcon
        },
        {
            value: 'expiry',
            label: t('web.apiTokens.expires'),
            icon: HistoryIcon
        }
    ]

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
        return groups.map((group) => (
            <div key={group.key}>
                {groupBy !== 'none' && (
                    <GroupHeader
                        label={group.label}
                        count={group.count}
                        open={isOpen(group.key)}
                        health={group.health}
                        onToggle={() => toggle(group.key)}
                    />
                )}
                {(groupBy === 'none' || isOpen(group.key)) &&
                    group.items.map((token) => (
                        <TokenLeaf
                            key={token.id}
                            token={token}
                            indentClass={groupBy === 'none' ? 'pl-2' : 'pl-8'}
                            selected={token.id === selectedId}
                            onSelect={() =>
                                navigate(`/settings/api-tokens/${token.id}`)
                            }
                        />
                    ))}
            </div>
        ))
    }

    return (
        <>
            <CascadeShell
                railLabel={t('web.apiTokens.title')}
                hasSelection={hasSelection}
                rail={
                    <>
                        <div className='shrink-0 space-y-2.5 p-3'>
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

                            <div className='flex items-center justify-between gap-2'>
                                <GroupByControl
                                    value={groupBy}
                                    onChange={setGroupBy}
                                    options={groupByOptions}
                                />
                                {groupBy !== 'none' && (
                                    <button
                                        type='button'
                                        onClick={
                                            anyExpanded
                                                ? collapseAll
                                                : () => expandAll(allKeys)
                                        }
                                        className='text-caption text-muted hover:text-fg inline-flex items-center gap-1 transition-colors'
                                    >
                                        {anyExpanded ? (
                                            <ChevronUpIcon className='h-3.5 w-3.5' />
                                        ) : (
                                            <ChevronDownIcon className='h-3.5 w-3.5' />
                                        )}
                                        {anyExpanded
                                            ? t(
                                                  'web.channels.settings.collapseAll'
                                              )
                                            : t(
                                                  'web.channels.settings.expandAll'
                                              )}
                                    </button>
                                )}
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

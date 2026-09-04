import {
    GrantableScope,
    ScopeMetadata,
    scopeMetadata
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import { Ghost, Spinner } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDateTime } from '@/lib/dateFormat'
import { AddPermissionModal } from '@/components/auth/AddPermissionModal'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { RiskTag } from '@/components/Tag'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { TrashIcon } from '@/components/icons'

interface AgentPermissionsProps {
    agentId: string
}

const scopeMetaByName = new Map<GrantableScope, ScopeMetadata>(
    scopeMetadata.map((m) => [m.scope, m])
)

const orderScopes = (scopes: GrantableScope[]): GrantableScope[] => {
    const present = new Set(scopes)
    return scopeMetadata.filter((m) => present.has(m.scope)).map((m) => m.scope)
}

export const AgentPermissions: FC<AgentPermissionsProps> = ({
    agentId
}): ReactNode => {
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [scopes, setScopes] = useState<GrantableScope[] | null>(null)
    const [updatedAt, setUpdatedAt] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [removing, setRemoving] = useState<GrantableScope | null>(null)
    const [addOpen, setAddOpen] = useState(false)

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true)
        setError(null)
        try {
            const res = await client.agents.permissions.list(agentId)
            setScopes(orderScopes(res.scopes))
            setUpdatedAt(res.updatedAt)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [agentId, client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const handleRemove = async (scope: GrantableScope): Promise<void> => {
        if (removing) return
        if (
            !(await confirm({
                title: t('web.agents.detail.permissions.removeTitle'),
                description: (
                    <>
                        {t('web.agents.detail.permissions.removePrefix')}{' '}
                        <code className='font-mono'>{scope}</code>{' '}
                        {t('web.agents.detail.permissions.removeSuffix')}
                    </>
                ),
                confirmLabel: t('web.agents.detail.permissions.removeAction'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setRemoving(scope)
        setError(null)
        try {
            await client.agents.permissions.remove(agentId, {
                scopes: [scope]
            })
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setRemoving(null)
        }
    }

    if (loading) {
        return (
            <section>
                <div className='mb-4 flex flex-wrap items-center gap-x-3 gap-y-2'>
                    <h2 className='text-h3 text-fg'>
                        {t('web.agents.detail.permissions.title')}
                    </h2>
                    <span className='flex-1' />
                    <EffectTimingTag timing='next-request' />
                </div>
                <div
                    className='workbench-panel space-y-3 px-4 py-4'
                    aria-busy='true'
                >
                    <Ghost variant='line' className='w-1/3' />
                    <Ghost variant='cap' className='w-3/5' />
                    <Ghost variant='cap' className='w-2/5' />
                </div>
            </section>
        )
    }

    // The list never loaded — show only the failure, not a misleading
    // "no capabilities" empty state.
    if (scopes === null) {
        return (
            <section>
                <div className='mb-4 flex flex-wrap items-center gap-x-3 gap-y-2'>
                    <h2 className='text-h3 text-fg'>
                        {t('web.agents.detail.permissions.title')}
                    </h2>
                    <span className='flex-1' />
                    <EffectTimingTag timing='next-request' />
                </div>
                <div className='workbench-alert-error'>
                    {error ?? t('web.agents.detail.permissions.loadFailed')}
                </div>
            </section>
        )
    }

    return (
        <section>
            <header className='mb-4 flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                        <h2 className='text-h3 text-fg'>
                            {t('web.agents.detail.permissions.title')}
                        </h2>
                        <span className='flex-1' />
                        <EffectTimingTag timing='next-request' />
                    </div>
                    <p className='text-caption text-muted mt-1.5'>
                        {t('web.agents.detail.permissions.description')}
                    </p>
                </div>
                <button
                    type='button'
                    onClick={() => setAddOpen(true)}
                    className='workbench-button-primary shrink-0'
                >
                    {t('web.agents.detail.permissions.addAction')}
                </button>
            </header>

            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            {scopes.length === 0 ? (
                <div className='workbench-note'>
                    {t('web.agents.detail.permissions.emptyPrefix')}{' '}
                    <code className='font-mono'>mf request-permission</code>.
                </div>
            ) : (
                <ul className='workbench-panel divide-divider divide-y overflow-hidden'>
                    {scopes.map((scope) => (
                        <ScopeRow
                            key={scope}
                            scope={scope}
                            onRemove={handleRemove}
                            busy={removing === scope}
                        />
                    ))}
                </ul>
            )}

            {updatedAt && (
                <p className='text-caption text-subtle mt-3'>
                    {t('web.agents.detail.permissions.lastUpdated', {
                        date: formatDateTime(updatedAt, '-')
                    })}
                </p>
            )}

            {addOpen && (
                <AddPermissionModal
                    agentId={agentId}
                    onClose={() => {
                        setAddOpen(false)
                        void refresh()
                    }}
                />
            )}
            {confirmDialog}
        </section>
    )
}

interface ScopeRowProps {
    scope: GrantableScope
    onRemove: (scope: GrantableScope) => void
    busy: boolean
}

const ScopeRow: FC<ScopeRowProps> = ({
    scope,
    onRemove,
    busy
}): ReactNode => {
    const meta = scopeMetaByName.get(scope)
    const danger = meta?.danger ?? 'low'
    return (
        <li className='flex flex-wrap items-start justify-between gap-3 px-5 py-4'>
            <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-center gap-2'>
                    <code className='text-ui text-fg font-mono'>{scope}</code>
                    <RiskTag danger={danger} />
                </div>
                {meta?.summary && (
                    <p className='text-ui text-muted mt-1'>{meta.summary}</p>
                )}
            </div>
            <ShortcutTooltip
                label={t('web.agents.detail.permissions.removeTitle')}
                placement='bottom-end'
            >
                <button
                    type='button'
                    onClick={() => onRemove(scope)}
                    disabled={busy}
                    aria-label={t('web.agents.detail.permissions.removeScope', {
                        scope
                    })}
                    className='text-muted hover:text-error hover:bg-danger-bg rounded-pill inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                >
                    {busy ? (
                        <Spinner size={16} />
                    ) : (
                        <TrashIcon className='h-4 w-4' />
                    )}
                </button>
            </ShortcutTooltip>
        </li>
    )
}

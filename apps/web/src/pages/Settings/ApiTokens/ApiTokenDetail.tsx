import type {
    ApiTokenSummary,
    GrantableScope,
    ScopeMetadata
} from '@manyfold/shared'
import { scopeMetadata } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import Breadcrumb from '@/components/Breadcrumb'
import { RiskTag } from '@/components/Tag'
import {
    API_TOKEN_STATUS_DOT,
    apiTokenStatus,
    apiTokenStatusLabelKey
} from '@/lib/apiTokenStatus'
import { useI18n } from '@/lib/i18n'
import { formatLocalDateTime } from '@/lib/usageFormat'

const scopeMetaByName = new Map<GrantableScope, ScopeMetadata>(
    scopeMetadata.map((m) => [m.scope, m])
)

// scopeMetadata only describes the delegable agent scopes. The two scopes the
// create form issues are not in it, so they carry their own copy — otherwise
// the panel would render a bare machine string for every hand-made token.
const BROAD_SCOPE_SUMMARY: Record<
    string,
    { key: string; danger: 'low' | 'medium' | 'high' }
> = {
    'chat.completions': { key: 'web.apiTokens.scopeChat', danger: 'low' },
    'api.full': { key: 'web.apiTokens.scopeFull', danger: 'high' }
}

const Row: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}): ReactNode => (
    <div className='border-divider/60 flex flex-wrap items-baseline justify-between gap-2 border-b py-2.5 last:border-b-0'>
        <span className='text-caption text-muted'>{label}</span>
        <span className='text-ui text-fg min-w-0 text-right'>{children}</span>
    </div>
)

const ApiTokenDetail: FC<{
    token: ApiTokenSummary | null
    loading: boolean
    busy: boolean
    onRevoke: (id: string) => void
}> = ({ token, loading, busy, onRevoke }): ReactNode => {
    const { t } = useI18n()

    // The rail owns the list, so a missing token is only knowable once it has
    // loaded — until then a deep link would bounce off its own destination.
    if (loading) return null
    // Not in the loaded list: revoked from another tab, or never existed.
    if (!token) return <Navigate to='/settings/api-tokens' replace />

    const status = apiTokenStatus(token)

    return (
        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
            <div className='mb-4 flex flex-wrap items-center justify-between gap-2'>
                <Breadcrumb
                    items={[
                        {
                            label: t('web.apiTokens.title'),
                            to: '/settings/api-tokens'
                        },
                        { label: token.name }
                    ]}
                />
                {status !== 'revoked' && (
                    <button
                        type='button'
                        disabled={busy}
                        onClick={() => onRevoke(token.id)}
                        className='workbench-button-secondary text-workflow-ship h-8 px-3'
                    >
                        {t('web.apiTokens.revoke')}
                    </button>
                )}
            </div>

            <div className='space-y-6'>
                <section className='workbench-panel p-5 md:p-6'>
                    <header className='mb-3 flex flex-wrap items-center gap-2'>
                        <span
                            className={[
                                'h-2 w-2 shrink-0 rounded-full',
                                API_TOKEN_STATUS_DOT[status]
                            ].join(' ')}
                        />
                        <h2 className='text-h3 text-fg min-w-0 truncate tracking-tight'>
                            {token.name}
                        </h2>
                        <span className='tag tag-neutral'>
                            {t(apiTokenStatusLabelKey(status))}
                        </span>
                    </header>

                    <Row label={t('web.apiTokens.created')}>
                        {formatLocalDateTime(token.createdAt)}
                    </Row>
                    <Row label={t('web.apiTokens.lastUsed')}>
                        {token.lastUsedAt
                            ? formatLocalDateTime(token.lastUsedAt)
                            : t('web.apiTokens.never')}
                    </Row>
                    <Row label={t('web.apiTokens.expires')}>
                        {token.expiresAt
                            ? formatLocalDateTime(token.expiresAt)
                            : t('web.apiTokens.neverExpires')}
                    </Row>
                    {token.revokedAt && (
                        <Row label={t('web.apiTokens.revokedAt')}>
                            {formatLocalDateTime(token.revokedAt)}
                        </Row>
                    )}
                    {token.createdVia && (
                        <Row label={t('web.apiTokens.createdVia')}>
                            <code className='text-caption font-mono'>
                                {token.createdVia}
                            </code>
                        </Row>
                    )}
                    {token.agentId && (
                        <Row label={t('web.apiTokens.boundAgent')}>
                            <span className='flex flex-wrap items-center justify-end gap-2'>
                                <code className='text-caption font-mono'>
                                    {token.agentId}
                                </code>
                                {token.enforceAgentBinding && (
                                    <span className='tag tag-neutral'>
                                        {t('web.apiTokens.bindingEnforced')}
                                    </span>
                                )}
                            </span>
                        </Row>
                    )}
                    <Row label={t('web.apiTokens.tokenId')}>
                        <code className='text-caption break-all font-mono'>
                            {token.id}
                        </code>
                    </Row>
                </section>

                <section className='workbench-panel p-5 md:p-6'>
                    <h2 className='text-h3 text-fg mb-1 tracking-tight'>
                        {t('web.apiTokens.scopesTitle')}
                    </h2>
                    <p className='text-caption text-muted mb-4'>
                        {t('web.apiTokens.scopesDescription')}
                    </p>
                    <ul className='space-y-2'>
                        {token.scopes.map((scope) => {
                            const broad = BROAD_SCOPE_SUMMARY[scope]
                            const meta = scopeMetaByName.get(
                                scope as GrantableScope
                            )
                            const summary = broad
                                ? t(broad.key)
                                : (meta?.summary ?? null)
                            const danger = broad?.danger ?? meta?.danger ?? null
                            return (
                                <li
                                    key={scope}
                                    className='border-divider bg-surface rounded-md border px-3.5 py-3'
                                >
                                    <span className='flex flex-wrap items-center gap-2'>
                                        <code className='text-caption font-mono'>
                                            {scope}
                                        </code>
                                        {danger && <RiskTag danger={danger} />}
                                    </span>
                                    {summary && (
                                        <span className='text-ui text-muted mt-1 block'>
                                            {summary}
                                        </span>
                                    )}
                                </li>
                            )
                        })}
                    </ul>
                </section>

                <section className='workbench-panel p-5 md:p-6'>
                    <h2 className='text-h3 text-fg mb-1 tracking-tight'>
                        {t('web.apiTokens.usageTitle')}
                    </h2>
                    <p className='text-caption text-muted'>
                        {/* Say what is actually known. Every authenticated
                            request updates last_used_at, and nothing else about
                            a request is recorded anywhere — claiming a request
                            history here would be inventing one. */}
                        {t('web.apiTokens.usageNoHistory')}
                    </p>
                    <p className='text-ui text-fg mt-3'>
                        {token.lastUsedAt
                            ? t('web.apiTokens.usageLastSeen', {
                                  when: formatLocalDateTime(token.lastUsedAt)
                              })
                            : t('web.apiTokens.usageNeverSeen')}
                    </p>
                </section>
            </div>
        </div>
    )
}

export default ApiTokenDetail

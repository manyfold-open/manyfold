import type {
    ApiTokenScope,
    ApiTokenSummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { CopyIcon } from '@/components/icons'
import { GhostSettingsRows } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n, type TFn } from '@/lib/i18n'
import { formatLocalDateTime } from '@/lib/usageFormat'

type ExpiryOption = 'never' | '30' | '90' | '365'

const ApiTokens: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [tokens, setTokens] = useState<ApiTokenSummary[]>([])
    const [tokenName, setTokenName] = useState('')
    const [scope, setScope] = useState<ApiTokenScope>('chat.completions')
    const [expiry, setExpiry] = useState<ExpiryOption>('never')
    const [issuedToken, setIssuedToken] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    // §10.8: the list must not render its "no tokens" row while the
    // first fetch is still in flight — that reads as "your tokens are
    // gone" (§10.7's worst lie).
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const scopeOptions: Array<{ value: ApiTokenScope; label: string }> = [
        { value: 'chat.completions', label: t('web.apiTokens.scopeChat') },
        { value: 'api.full', label: t('web.apiTokens.scopeFull') }
    ]
    const expiryOptions: Array<{ value: ExpiryOption; label: string }> = [
        { value: 'never', label: t('web.apiTokens.expiryNever') },
        { value: '30', label: t('web.apiTokens.expiryDays', { days: 30 }) },
        { value: '90', label: t('web.apiTokens.expiryDays', { days: 90 }) },
        { value: '365', label: t('web.apiTokens.expiryDays', { days: 365 }) }
    ]

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

    const createToken = async (
        e: FormEvent<HTMLFormElement>
    ): Promise<void> => {
        e.preventDefault()
        const name = tokenName.trim()
        if (!name) return
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
            const res = await client.apiTokens.create({
                name,
                scopes: [scope],
                expiresInDays: expiry === 'never' ? null : Number(expiry)
            })
            setIssuedToken(res.token)
            setTokenName('')
            setScope('chat.completions')
            setExpiry('never')
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const revokeToken = async (id: string): Promise<void> => {
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
        setMessage(null)
        try {
            await client.apiTokens.revoke(id)
            setMessage(t('web.apiTokens.revoked'))
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const copyIssuedToken = async (): Promise<void> => {
        if (!issuedToken) return
        await navigator.clipboard.writeText(issuedToken)
        setMessage(t('web.apiTokens.copied'))
    }

    return (
        <div className='settings-page'>
            <SettingsPageHeader title={t('web.apiTokens.title')} />
            {message && <div className='workbench-note mb-4'>{message}</div>}
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            <section className='settings-section'>
                <div className='settings-card p-5'>
                    <div className='settings-card-label'>
                        {t('web.apiTokens.createTitle')}
                    </div>
                    <form
                        onSubmit={createToken}
                        className='mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px_140px]'
                    >
                        <input
                            value={tokenName}
                            onChange={(e) => setTokenName(e.target.value)}
                            placeholder={t('web.apiTokens.namePlaceholder')}
                            className='workbench-input'
                        />
                        <WorkbenchSelect
                            ariaLabel={t('web.apiTokens.scopeLabel')}
                            value={scope}
                            onChange={(next) => setScope(next as ApiTokenScope)}
                            options={scopeOptions}
                        />
                        <WorkbenchSelect
                            ariaLabel={t('web.apiTokens.expiryLabel')}
                            value={expiry}
                            onChange={(next) => setExpiry(next as ExpiryOption)}
                            options={expiryOptions}
                        />
                        <button
                            type='submit'
                            disabled={busy || !tokenName.trim()}
                            className='workbench-button-primary h-11'
                        >
                            {t('web.apiTokens.create')}
                        </button>
                    </form>
                    {issuedToken && (
                        <div className='mt-4 flex flex-col gap-2'>
                            <p className='settings-card-copy'>
                                {t('web.apiTokens.copyDescription')}
                            </p>
                            <code className='workbench-button-secondary justify-start break-all p-3 font-mono'>
                                {issuedToken}
                            </code>
                            <button
                                type='button'
                                onClick={() => void copyIssuedToken()}
                                className='workbench-button-secondary text-caption h-8 self-start px-3'
                            >
                                <CopyIcon className='h-3.5 w-3.5' />
                                {t('web.apiTokens.copy')}
                            </button>
                        </div>
                    )}
                </div>
            </section>

            <section className='settings-section'>
                <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
                    <h2 className='settings-section-label mb-0'>
                        {t('web.apiTokens.activeTitle')}
                    </h2>
                </div>
                <div className='settings-card' aria-busy={gate.showLoading}>
                    {gate.showLoading ? (
                        <GhostSettingsRows rows={2} />
                    ) : loading ? null : tokens.length === 0 ? (
                        <div className='settings-card-row'>
                            <p className='settings-card-copy'>
                                {t('web.apiTokens.empty')}
                            </p>
                        </div>
                    ) : (
                        tokens.map((token) => (
                            <TokenRow
                                key={token.id}
                                token={token}
                                busy={busy}
                                onRevoke={revokeToken}
                                t={t}
                            />
                        ))
                    )}
                </div>
            </section>
            {confirmDialog}
        </div>
    )
}

const TokenRow: FC<{
    token: ApiTokenSummary
    busy: boolean
    onRevoke: (id: string) => Promise<void>
    t: TFn
}> = ({ token, busy, onRevoke, t }): ReactNode => {
    const revoked = Boolean(token.revokedAt)
    const expired =
        Boolean(token.expiresAt) && new Date(token.expiresAt!) < new Date()
    const status = revoked
        ? t('web.apiTokens.statusRevoked')
        : expired
          ? t('web.apiTokens.statusExpired')
          : t('web.apiTokens.statusActive')

    return (
        <div className='settings-card-row'>
            <div className='min-w-0'>
                <div className='settings-card-label flex flex-wrap items-center gap-2'>
                    <span>{token.name}</span>
                    <span
                        className={[
                            'rounded-full px-2 py-0.5 text-[11px] font-medium',
                            revoked || expired
                                ? 'bg-zinc-200 text-zinc-600'
                                : 'bg-emerald-50 text-emerald-700'
                        ].join(' ')}
                    >
                        {status}
                    </span>
                </div>
                <div className='settings-card-copy text-caption text-muted'>
                    {token.scopes.join(', ')} · {t('web.apiTokens.created')}{' '}
                    {formatLocalDateTime(token.createdAt)} · {t('web.apiTokens.lastUsed')}{' '}
                    {token.lastUsedAt
                        ? formatLocalDateTime(token.lastUsedAt)
                        : t('web.apiTokens.never')}
                    {token.expiresAt
                        ? ` · ${t('web.apiTokens.expires')} ${formatLocalDateTime(token.expiresAt)}`
                        : ` · ${t('web.apiTokens.neverExpires')}`}
                    {token.revokedAt
                        ? ` · ${t('web.apiTokens.revokedAt')} ${formatLocalDateTime(token.revokedAt)}`
                        : ''}
                </div>
                <div className='settings-card-copy text-caption text-muted font-mono'>
                    {token.id}
                </div>
            </div>
            <div className='settings-card-side'>
                {!revoked && (
                    <button
                        type='button'
                        disabled={busy}
                        onClick={() => void onRevoke(token.id)}
                        className='workbench-button-secondary text-caption h-8 px-3'
                    >
                        {t('web.apiTokens.revoke')}
                    </button>
                )}
            </div>
        </div>
    )
}

export default ApiTokens

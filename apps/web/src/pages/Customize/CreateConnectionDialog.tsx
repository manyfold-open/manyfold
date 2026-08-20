import type {
    CloudflareAccountOption,
    ConnectionProvider
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { connectionProviderLabel } from './connectionMeta'

// Cloudflare "API token template URL" — pre-fills the create-token form with
// the permissions agents need (Account: Read for our account listing + Workers
// / Pages / DNS: Edit for wrangler and cloudflared deploys) and the read
// scopes the connection detail page lists Workers/Pages with. Users review and
// trim before creating.
// https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
const CF_TOKEN_URL =
    'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
    encodeURIComponent(
        JSON.stringify([
            { key: 'account_settings', type: 'read' },
            { key: 'workers_scripts', type: 'edit' },
            { key: 'workers_kv_storage', type: 'edit' },
            { key: 'workers_routes', type: 'edit' },
            { key: 'page', type: 'edit' },
            { key: 'dns', type: 'edit' }
        ])
    ) +
    '&accountId=*&zoneId=all&name=Manyfold'

const Field: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}) => (
    <label className='block'>
        <span className='text-ui text-fg mb-1 block font-medium'>{label}</span>
        {children}
    </label>
)

interface Props {
    onClose: () => void
    onCreated: (id: string) => void
}

const CreateConnectionDialog: FC<Props> = ({
    onClose,
    onCreated
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [provider, setProvider] = useState<ConnectionProvider>('github')
    const [name, setName] = useState('')
    const [cfToken, setCfToken] = useState('')
    const [cfAccounts, setCfAccounts] = useState<
        CloudflareAccountOption[] | null
    >(null)
    const [cfAccountId, setCfAccountId] = useState('')
    const [composioKey, setComposioKey] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const switchProvider = (next: ConnectionProvider): void => {
        setProvider(next)
        setError(null)
        setCfAccounts(null)
        setCfAccountId('')
    }

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            if (provider === 'github') {
                const { installUrl } = await client.connections.githubStart()
                window.location.assign(installUrl)
                return
            }
            if (provider === 'cloudflare') {
                const res = await client.connections.cloudflareCreate({
                    token: cfToken.trim(),
                    name: name.trim() || undefined,
                    accountId: cfAccountId || undefined
                })
                if (res.status === 'needs_account_selection') {
                    setCfAccounts(res.accounts)
                    setCfAccountId(res.accounts[0]?.id ?? '')
                    setBusy(false)
                    return
                }
                onCreated(res.connection.id)
                return
            }
            const created = await client.connections.composioCreate({
                apiKey: composioKey.trim(),
                name: name.trim() || undefined
            })
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
            setBusy(false)
        }
    }

    const submitDisabled =
        busy ||
        (provider === 'cloudflare' && cfToken.trim().length === 0) ||
        (provider === 'composio' && composioKey.trim().length === 0)

    const submitLabel = (): string => {
        if (busy) return t('web.customize.connectionCreate.connecting')
        if (provider === 'github')
            return t('web.customize.connectionCreate.continueGithub')
        if (provider === 'cloudflare')
            return cfAccounts
                ? t('web.customize.connectionCreate.confirmAccount')
                : t('web.customize.connectionCreate.connectCloudflare')
        return t('web.customize.connectionCreate.connectComposio')
    }

    return (
        <ProductDialog
            title={t('web.customize.connectionCreate.title')}
            description={t('web.customize.connectionCreate.description')}
            onClose={onClose}
            onSubmit={handleSubmit}
            closeDisabled={busy}
            bodyClassName='space-y-4'
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        className='workbench-button-secondary'
                        disabled={busy}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={submitDisabled}
                    >
                        {submitLabel()}
                    </button>
                </>
            }
        >
            {error && <div className='workbench-alert-error'>{error}</div>}

            <Field label={t('web.customize.connectionCreate.provider')}>
                <WorkbenchSelect
                    ariaLabel={t('web.customize.connectionCreate.provider')}
                    value={provider}
                    onChange={(next) =>
                        switchProvider(next as ConnectionProvider)
                    }
                    options={[
                        {
                            value: 'github',
                            label: connectionProviderLabel('github')
                        },
                        {
                            value: 'cloudflare',
                            label: connectionProviderLabel('cloudflare')
                        },
                        {
                            value: 'composio',
                            label: connectionProviderLabel('composio')
                        }
                    ]}
                />
            </Field>

            {provider === 'github' ? (
                <p className='text-caption text-muted'>
                    {t('web.customize.connectionCreate.githubDescription')}
                </p>
            ) : null}

            {provider === 'cloudflare' ? (
                <>
                    <p className='text-caption text-muted'>
                        {t(
                            'web.customize.connectionCreate.cloudflareDescription'
                        )}{' '}
                        <a
                            className='underline'
                            href={CF_TOKEN_URL}
                            target='_blank'
                            rel='noreferrer'
                        >
                            {t(
                                'web.customize.connectionCreate.createTokenLink'
                            )}
                        </a>
                    </p>
                    <Field label={t('web.customize.connectionCreate.apiToken')}>
                        <input
                            className='workbench-input'
                            type='password'
                            autoComplete='off'
                            placeholder={t(
                                'web.customize.connectionCreate.cloudflareTokenPlaceholder'
                            )}
                            value={cfToken}
                            onChange={(e) => setCfToken(e.target.value)}
                        />
                    </Field>
                    <Field
                        label={t(
                            'web.customize.connectionCreate.labelOptional'
                        )}
                    >
                        <input
                            className='workbench-input'
                            type='text'
                            placeholder={t(
                                'web.customize.connectionCreate.cloudflareLabelPlaceholder'
                            )}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </Field>
                    {cfAccounts ? (
                        <Field
                            label={t('web.customize.connectionCreate.account')}
                        >
                            <WorkbenchSelect
                                ariaLabel={t(
                                    'web.customize.connectionCreate.account'
                                )}
                                value={cfAccountId}
                                onChange={setCfAccountId}
                                options={cfAccounts.map((a) => ({
                                    value: a.id,
                                    label: a.name
                                }))}
                            />
                        </Field>
                    ) : null}
                </>
            ) : null}

            {provider === 'composio' ? (
                <>
                    <p className='text-caption text-muted'>
                        {t(
                            'web.customize.connectionCreate.composioDescription'
                        )}{' '}
                        <a
                            className='underline'
                            href='https://platform.composio.dev'
                            target='_blank'
                            rel='noreferrer'
                        >
                            {t('web.customize.connectionCreate.connectKeyLink')}
                        </a>
                    </p>
                    <Field
                        label={t(
                            'web.customize.connectionCreate.connectApiKey'
                        )}
                    >
                        <input
                            className='workbench-input'
                            type='password'
                            autoComplete='off'
                            placeholder={t(
                                'web.customize.connectionCreate.composioKeyPlaceholder'
                            )}
                            value={composioKey}
                            onChange={(e) => setComposioKey(e.target.value)}
                        />
                    </Field>
                    <Field
                        label={t(
                            'web.customize.connectionCreate.labelOptional'
                        )}
                    >
                        <input
                            className='workbench-input'
                            type='text'
                            placeholder={t(
                                'web.customize.connectionCreate.composioLabelPlaceholder'
                            )}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </Field>
                </>
            ) : null}
        </ProductDialog>
    )
}

export default CreateConnectionDialog

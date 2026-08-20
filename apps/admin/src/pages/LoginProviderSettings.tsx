import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { useAppAuth } from '@/lib/auth'
import NetmindSupplySection from '@/pages/NetmindSupplySection'
import { Button, Card, Heading, Input } from '@/ui'

const oauthCallbackUrl = (provider: 'google' | 'oidc'): string => {
    const base = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')
    return `${base}/auth/oauth/${provider}/callback`
}

const LoginProviderSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const auth = useAppAuth()
    const [initialAdminEmails, setInitialAdminEmails] = useState('')
    const [passwordEnabled, setPasswordEnabled] = useState(true)
    const [emailVerificationRequired, setEmailVerificationRequired] =
        useState(true)
    const [googleEnabled, setGoogleEnabled] = useState(false)
    const [googleClientId, setGoogleClientId] = useState('')
    const [googleClientSecret, setGoogleClientSecret] = useState('')
    const [googleHasSecret, setGoogleHasSecret] = useState(false)
    const [oidcEnabled, setOidcEnabled] = useState(false)
    const [oidcAuthority, setOidcAuthority] = useState('')
    const [oidcClientId, setOidcClientId] = useState('')
    const [oidcClientSecret, setOidcClientSecret] = useState('')
    const [oidcHasSecret, setOidcHasSecret] = useState(false)
    const [oidcAudience, setOidcAudience] = useState('')
    const [oidcScope, setOidcScope] = useState('openid profile email')
    const [oidcTokenSource, setOidcTokenSource] = useState<
        'access_token' | 'id_token'
    >('access_token')
    const [oidcJwksUrl, setOidcJwksUrl] = useState('')
    const [oidcUserIdClaim, setOidcUserIdClaim] = useState('sub')
    const [oidcEmailClaim, setOidcEmailClaim] = useState('email')
    const [oidcButtonLabel, setOidcButtonLabel] = useState('')
    const [netmindEnabled, setNetmindEnabled] = useState(false)
    const [netmindAuthApi, setNetmindAuthApi] = useState('')
    const [netmindAccountsUrl, setNetmindAccountsUrl] = useState('')
    const [netmindSysCode, setNetmindSysCode] = useState('')
    const [netmindRegisterUrl, setNetmindRegisterUrl] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getLoginProvider()
            .then((settings) => {
                setInitialAdminEmails(settings.initialAdminEmails.join(', '))
                setPasswordEnabled(settings.password.enabled)
                setEmailVerificationRequired(settings.emailVerificationRequired)
                setGoogleEnabled(settings.google.enabled)
                setGoogleClientId(settings.google.clientId)
                setGoogleHasSecret(settings.google.hasClientSecret)
                setOidcEnabled(settings.oidc?.enabled ?? false)
                setOidcAuthority(settings.oidc?.authority ?? '')
                setOidcClientId(settings.oidc?.clientId ?? '')
                setOidcHasSecret(Boolean(settings.oidc?.hasClientSecret))
                setOidcAudience(settings.oidc?.audience ?? '')
                setOidcScope(settings.oidc?.scope ?? 'openid profile email')
                setOidcTokenSource(settings.oidc?.tokenSource ?? 'access_token')
                setOidcJwksUrl(settings.oidc?.jwksUrl ?? '')
                setOidcUserIdClaim(settings.oidc?.userIdClaim ?? 'sub')
                setOidcEmailClaim(settings.oidc?.emailClaim ?? 'email')
                setOidcButtonLabel(settings.oidc?.buttonLabel ?? '')
                setNetmindEnabled(settings.netmind?.enabled ?? false)
                setNetmindAuthApi(settings.netmind?.authApi ?? '')
                setNetmindAccountsUrl(settings.netmind?.accountsUrl ?? '')
                setNetmindSysCode(settings.netmind?.sysCode ?? '')
                setNetmindRegisterUrl(settings.netmind?.registerUrl ?? '')
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        try {
            const settings = await client.admin.settings.updateLoginProvider({
                initialAdminEmails: parseEmails(initialAdminEmails),
                passwordEnabled,
                emailVerificationRequired,
                googleEnabled,
                googleClientId: googleClientId.trim(),
                googleClientSecret,
                oidcEnabled,
                oidcAuthority: oidcAuthority.trim(),
                oidcClientId: oidcClientId.trim(),
                oidcClientSecret,
                oidcAudience: oidcAudience.trim() || null,
                oidcScope,
                oidcTokenSource,
                oidcJwksUrl: oidcJwksUrl.trim() || null,
                oidcUserIdClaim,
                oidcEmailClaim,
                oidcButtonLabel: oidcButtonLabel.trim() || null,
                netmindEnabled,
                netmindAuthApi: netmindAuthApi.trim(),
                netmindAccountsUrl: netmindAccountsUrl.trim(),
                netmindSysCode: netmindSysCode.trim(),
                netmindRegisterUrl: netmindRegisterUrl.trim()
            })
            setGoogleHasSecret(settings.google.hasClientSecret)
            setOidcHasSecret(Boolean(settings.oidc?.hasClientSecret))
            setGoogleClientSecret('')
            setOidcClientSecret('')
            setInitialAdminEmails(settings.initialAdminEmails.join(', '))
            await auth.refreshConfig()
            setStatus('Saved')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='mx-auto max-w-3xl'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Login provider
                </Heading>
                <p className='admin-page-description'>
                    Configure which login methods admin and web accept.
                </p>
            </div>

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            <Card elevation='ambient' className='p-3'>
                <Input
                    id='settings-initial-admin-emails'
                    label='Initial admin emails'
                    value={initialAdminEmails}
                    onChange={(e) => setInitialAdminEmails(e.target.value)}
                    hint='Comma-separated email addresses promoted to admin on login.'
                />

                <div className='mt-3 space-y-2'>
                    <Checkbox
                        id='settings-password-enabled'
                        label='Enable email + password sign-in'
                        checked={passwordEnabled}
                        onChange={setPasswordEnabled}
                    />
                    <Checkbox
                        id='settings-email-verification-required'
                        label='Require email verification for new sign-ups'
                        checked={emailVerificationRequired}
                        onChange={setEmailVerificationRequired}
                    />
                    <p className='text-caption-sm text-label'>
                        Email verification and password reset require Resend to
                        be configured under Settings → Email.
                    </p>
                </div>

                <div className='border-border mt-4 space-y-2 border-t pt-3'>
                    <Checkbox
                        id='settings-google-enabled'
                        label='Enable Google sign-in'
                        checked={googleEnabled}
                        onChange={setGoogleEnabled}
                    />
                    <div className='grid gap-3 md:grid-cols-2'>
                        <Input
                            id='settings-google-client-id'
                            label='Google client ID'
                            value={googleClientId}
                            onChange={(e) => setGoogleClientId(e.target.value)}
                        />
                        <Input
                            id='settings-google-client-secret'
                            label='Google client secret'
                            type='password'
                            value={googleClientSecret}
                            onChange={(e) =>
                                setGoogleClientSecret(e.target.value)
                            }
                            hint={
                                googleHasSecret
                                    ? 'Leave blank to keep the stored secret.'
                                    : undefined
                            }
                        />
                        <p className='text-caption-sm text-label md:col-span-2'>
                            Authorized redirect URI:{' '}
                            <code>{oauthCallbackUrl('google')}</code>
                        </p>
                    </div>
                </div>

                <div className='border-border mt-4 space-y-2 border-t pt-3'>
                    <Checkbox
                        id='settings-oidc-enabled'
                        label='Enable OIDC sign-in'
                        checked={oidcEnabled}
                        onChange={setOidcEnabled}
                    />
                    <div className='grid gap-3 md:grid-cols-2'>
                        <Input
                            id='settings-oidc-authority'
                            label='OIDC authority'
                            value={oidcAuthority}
                            onChange={(e) => setOidcAuthority(e.target.value)}
                        />
                        <Input
                            id='settings-oidc-client-id'
                            label='OIDC client ID'
                            value={oidcClientId}
                            onChange={(e) => setOidcClientId(e.target.value)}
                        />
                        <Input
                            id='settings-oidc-client-secret'
                            label='OIDC client secret'
                            type='password'
                            value={oidcClientSecret}
                            onChange={(e) => setOidcClientSecret(e.target.value)}
                            hint={
                                oidcHasSecret
                                    ? 'Leave blank to keep the stored secret.'
                                    : undefined
                            }
                        />
                        <Input
                            id='settings-oidc-audience'
                            label='OIDC audience'
                            value={oidcAudience}
                            onChange={(e) => setOidcAudience(e.target.value)}
                        />
                        <Input
                            id='settings-oidc-scope'
                            label='OIDC scope'
                            value={oidcScope}
                            onChange={(e) => setOidcScope(e.target.value)}
                        />
                        <Input
                            id='settings-oidc-button-label'
                            label='OIDC button label'
                            value={oidcButtonLabel}
                            onChange={(e) => setOidcButtonLabel(e.target.value)}
                        />
                        <label className='block'>
                            <span className='text-caption text-label mb-1 block font-normal'>
                                Token source
                            </span>
                            <select
                                value={oidcTokenSource}
                                onChange={(e) =>
                                    setOidcTokenSource(
                                        e.target.value as
                                            | 'access_token'
                                            | 'id_token'
                                    )
                                }
                                className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                            >
                                <option value='access_token'>
                                    Access token
                                </option>
                                <option value='id_token'>ID token</option>
                            </select>
                        </label>
                        <Input
                            id='settings-oidc-jwks-url'
                            label='OIDC JWKS URL'
                            value={oidcJwksUrl}
                            onChange={(e) => setOidcJwksUrl(e.target.value)}
                        />
                        <Input
                            id='settings-oidc-user-id-claim'
                            label='User ID claim'
                            value={oidcUserIdClaim}
                            onChange={(e) => setOidcUserIdClaim(e.target.value)}
                        />
                        <Input
                            id='settings-oidc-email-claim'
                            label='Email claim'
                            value={oidcEmailClaim}
                            onChange={(e) => setOidcEmailClaim(e.target.value)}
                        />
                        <p className='text-caption-sm text-label md:col-span-2'>
                            Authorized redirect URI:{' '}
                            <code>{oauthCallbackUrl('oidc')}</code>
                        </p>
                    </div>
                </div>

                <div className='border-border mt-4 space-y-2 border-t pt-3'>
                    <Checkbox
                        id='settings-netmind-enabled'
                        label='Enable NetMind sign-in'
                        checked={netmindEnabled}
                        onChange={setNetmindEnabled}
                    />
                    <p className='text-caption-sm text-label'>
                        Shown on the user web app login + account settings. The
                        admin app itself signs in with password / Google / OIDC,
                        so keep at least one of those enabled.
                    </p>
                    <div className='grid gap-3 md:grid-cols-2'>
                        <Input
                            id='settings-netmind-auth-api'
                            label='NetMind auth API'
                            value={netmindAuthApi}
                            onChange={(e) => setNetmindAuthApi(e.target.value)}
                            hint='e.g. https://auth-api.netmind.ai'
                        />
                        <Input
                            id='settings-netmind-sys-code'
                            label='NetMind sysCode'
                            value={netmindSysCode}
                            onChange={(e) => setNetmindSysCode(e.target.value)}
                            hint='Multi-tenant code; must match the NetMind environment.'
                        />
                        <Input
                            id='settings-netmind-accounts-url'
                            label='NetMind accounts URL'
                            value={netmindAccountsUrl}
                            onChange={(e) =>
                                setNetmindAccountsUrl(e.target.value)
                            }
                            hint='Hosts the OAuth popup (auth.html). Optional.'
                        />
                        <Input
                            id='settings-netmind-register-url'
                            label='NetMind register URL'
                            value={netmindRegisterUrl}
                            onChange={(e) =>
                                setNetmindRegisterUrl(e.target.value)
                            }
                            hint='Optional sign-up link.'
                        />
                    </div>
                    <NetmindSupplySection />
                </div>

                <div className='mt-4 flex items-center justify-end gap-2'>
                    {status && (
                        <span className='text-caption-sm text-brand'>
                            {status}
                        </span>
                    )}
                    <Button
                        variant='primary'
                        disabled={busy}
                        onClick={() => void save()}
                    >
                        Save
                    </Button>
                </div>
            </Card>
        </div>
    )
}

const Checkbox: FC<{
    id: string
    label: string
    checked: boolean
    onChange: (next: boolean) => void
}> = ({ id, label, checked, onChange }) => (
    <label htmlFor={id} className='flex items-center gap-2'>
        <input
            id={id}
            type='checkbox'
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className='border-border text-brand focus:ring-brand h-4 w-4 rounded'
        />
        <span className='text-caption text-heading'>{label}</span>
    </label>
)

const parseEmails = (value: string): string[] =>
    value
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean)

export default LoginProviderSettingsPage

import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { useAppAuth } from '@/lib/auth'
import { storeSession } from '@/lib/session'
import { adminRoutes } from '@/routes'
import { Button, Card, Heading, Input } from '@/ui'

const oauthCallbackUrl = (provider: 'google' | 'oidc'): string => {
    const base = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')
    return `${base}/auth/oauth/${provider}/callback`
}

const Setup: FC = (): ReactNode => {
    const auth = useAppAuth()
    const client = useApiClient()
    const navigate = useNavigate()
    const [setupToken, setSetupToken] = useState('')
    const [initialAdminEmails, setInitialAdminEmails] = useState('')
    const [adminEmail, setAdminEmail] = useState('')
    const [adminPassword, setAdminPassword] = useState('')
    const [passwordEnabled, setPasswordEnabled] = useState(true)
    const [emailVerificationRequired, setEmailVerificationRequired] =
        useState(true)
    const [googleEnabled, setGoogleEnabled] = useState(false)
    const [googleClientId, setGoogleClientId] = useState('')
    const [googleClientSecret, setGoogleClientSecret] = useState('')
    const [oidcEnabled, setOidcEnabled] = useState(false)
    const [oidcAuthority, setOidcAuthority] = useState('')
    const [oidcClientId, setOidcClientId] = useState('')
    const [oidcClientSecret, setOidcClientSecret] = useState('')
    const [oidcAudience, setOidcAudience] = useState('')
    const [oidcScope, setOidcScope] = useState('openid profile email')
    const [oidcTokenSource, setOidcTokenSource] = useState<
        'access_token' | 'id_token'
    >('access_token')
    const [oidcButtonLabel, setOidcButtonLabel] = useState('')
    const [netmindEnabled, setNetmindEnabled] = useState(false)
    const [netmindAuthApi, setNetmindAuthApi] = useState('')
    const [netmindAccountsUrl, setNetmindAccountsUrl] = useState('')
    const [netmindSysCode, setNetmindSysCode] = useState('')
    const [netmindRegisterUrl, setNetmindRegisterUrl] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    if (!auth.setupRequired)
        return (
            <Navigate
                to={
                    auth.isSignedIn
                        ? adminRoutes.dashboard
                        : adminRoutes.login
                }
                replace
            />
        )

    const submit = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            const res = await client.auth.setup({
                setupToken,
                initialAdminEmails: parseEmails(initialAdminEmails),
                adminEmail: adminEmail.trim(),
                adminPassword,
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
                oidcButtonLabel: oidcButtonLabel.trim() || null,
                netmindEnabled,
                netmindAuthApi: netmindAuthApi.trim(),
                netmindAccountsUrl: netmindAccountsUrl.trim(),
                netmindSysCode: netmindSysCode.trim(),
                netmindRegisterUrl: netmindRegisterUrl.trim()
            })
            storeSession(res.token)
            await auth.refreshConfig()
            navigate(adminRoutes.dashboard, { replace: true })
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='flex min-h-screen items-center justify-center bg-white p-4'>
            <Card elevation='elevated' className='w-full max-w-2xl p-4'>
                <div className='mb-3'>
                    <Heading level={2} className='mb-2'>
                        Initial authentication setup
                    </Heading>
                    <p className='admin-page-description'>
                        Create the first admin and choose which login methods to
                        enable.
                    </p>
                </div>

                {error && (
                    <Card
                        elevation='flat'
                        className='border-accent-ruby/30 bg-accent-ruby/5 mb-3 p-2'
                    >
                        <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                            {error}
                        </pre>
                    </Card>
                )}

                <div className='grid gap-3 md:grid-cols-2'>
                    <Input
                        id='setup-token'
                        label='Setup token'
                        type='password'
                        value={setupToken}
                        onChange={(e) => setSetupToken(e.target.value)}
                    />
                    <Input
                        id='initial-admin-emails'
                        label='Initial admin emails'
                        value={initialAdminEmails}
                        onChange={(e) => setInitialAdminEmails(e.target.value)}
                        hint='Comma-separated. The admin email below is added automatically.'
                    />
                    <Input
                        id='admin-email'
                        label='First admin email'
                        type='email'
                        value={adminEmail}
                        onChange={(e) => setAdminEmail(e.target.value)}
                    />
                    <Input
                        id='admin-password'
                        label='First admin password'
                        type='password'
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        hint='At least 8 characters. Used to sign in immediately.'
                    />
                </div>

                <div className='mt-3 space-y-2'>
                    <Checkbox
                        id='password-enabled'
                        label='Enable email + password sign-in'
                        checked={passwordEnabled}
                        onChange={setPasswordEnabled}
                    />
                    <Checkbox
                        id='email-verification-required'
                        label='Require email verification for new sign-ups'
                        checked={emailVerificationRequired}
                        onChange={setEmailVerificationRequired}
                    />
                    <p className='text-caption-sm text-label'>
                        Email verification and password reset require an email
                        provider — configure Resend under Settings → Email after
                        setup.
                    </p>
                </div>

                <div className='mt-4 space-y-2'>
                    <Checkbox
                        id='google-enabled'
                        label='Enable Google sign-in'
                        checked={googleEnabled}
                        onChange={setGoogleEnabled}
                    />
                    {googleEnabled && (
                        <div className='grid gap-3 md:grid-cols-2'>
                            <Input
                                id='google-client-id'
                                label='Google client ID'
                                value={googleClientId}
                                onChange={(e) =>
                                    setGoogleClientId(e.target.value)
                                }
                            />
                            <Input
                                id='google-client-secret'
                                label='Google client secret'
                                type='password'
                                value={googleClientSecret}
                                onChange={(e) =>
                                    setGoogleClientSecret(e.target.value)
                                }
                            />
                            <p className='text-caption-sm text-label md:col-span-2'>
                                Authorized redirect URI:{' '}
                                <code>{oauthCallbackUrl('google')}</code>
                            </p>
                        </div>
                    )}
                </div>

                <div className='mt-4 space-y-2'>
                    <Checkbox
                        id='oidc-enabled'
                        label='Enable OIDC sign-in'
                        checked={oidcEnabled}
                        onChange={setOidcEnabled}
                    />
                    {oidcEnabled && (
                        <div className='grid gap-3 md:grid-cols-2'>
                            <Input
                                id='oidc-authority'
                                label='OIDC authority'
                                value={oidcAuthority}
                                onChange={(e) =>
                                    setOidcAuthority(e.target.value)
                                }
                            />
                            <Input
                                id='oidc-client-id'
                                label='OIDC client ID'
                                value={oidcClientId}
                                onChange={(e) => setOidcClientId(e.target.value)}
                            />
                            <Input
                                id='oidc-client-secret'
                                label='OIDC client secret'
                                type='password'
                                value={oidcClientSecret}
                                onChange={(e) =>
                                    setOidcClientSecret(e.target.value)
                                }
                            />
                            <Input
                                id='oidc-audience'
                                label='OIDC audience'
                                value={oidcAudience}
                                onChange={(e) => setOidcAudience(e.target.value)}
                            />
                            <Input
                                id='oidc-scope'
                                label='OIDC scope'
                                value={oidcScope}
                                onChange={(e) => setOidcScope(e.target.value)}
                            />
                            <Input
                                id='oidc-button-label'
                                label='OIDC button label'
                                value={oidcButtonLabel}
                                onChange={(e) =>
                                    setOidcButtonLabel(e.target.value)
                                }
                                hint='Optional, e.g. "Continue with Okta".'
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
                            <p className='text-caption-sm text-label md:col-span-2'>
                                Authorized redirect URI:{' '}
                                <code>{oauthCallbackUrl('oidc')}</code>
                            </p>
                        </div>
                    )}
                </div>

                <div className='mt-4 space-y-2'>
                    <Checkbox
                        id='netmind-enabled'
                        label='Enable NetMind sign-in'
                        checked={netmindEnabled}
                        onChange={setNetmindEnabled}
                    />
                    {netmindEnabled && (
                        <div className='grid gap-3 md:grid-cols-2'>
                            <Input
                                id='netmind-auth-api'
                                label='NetMind auth API'
                                value={netmindAuthApi}
                                onChange={(e) =>
                                    setNetmindAuthApi(e.target.value)
                                }
                            />
                            <Input
                                id='netmind-sys-code'
                                label='NetMind sysCode'
                                value={netmindSysCode}
                                onChange={(e) =>
                                    setNetmindSysCode(e.target.value)
                                }
                            />
                            <Input
                                id='netmind-accounts-url'
                                label='NetMind accounts URL'
                                value={netmindAccountsUrl}
                                onChange={(e) =>
                                    setNetmindAccountsUrl(e.target.value)
                                }
                                hint='Optional — hosts the OAuth popup.'
                            />
                            <Input
                                id='netmind-register-url'
                                label='NetMind register URL'
                                value={netmindRegisterUrl}
                                onChange={(e) =>
                                    setNetmindRegisterUrl(e.target.value)
                                }
                                hint='Optional sign-up link.'
                            />
                            <p className='text-caption-sm text-label md:col-span-2'>
                                Keep password / Google / OIDC enabled too — the
                                admin app signs in with those.
                            </p>
                        </div>
                    )}
                </div>

                <div className='mt-4 flex justify-end'>
                    <Button
                        variant='primary'
                        disabled={busy}
                        onClick={() => void submit()}
                    >
                        Save setup
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

export default Setup
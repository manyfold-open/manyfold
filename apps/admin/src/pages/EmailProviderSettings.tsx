import type { EmailProviderKind } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

const EmailProviderSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [provider, setProvider] = useState<EmailProviderKind>('console')
    const [from, setFrom] = useState('')
    const [replyTo, setReplyTo] = useState('')
    const [apiKey, setApiKey] = useState('')
    const [apiKeyMasked, setApiKeyMasked] = useState<string | null>(null)
    const [smtpHost, setSmtpHost] = useState('')
    const [smtpPort, setSmtpPort] = useState('587')
    const [smtpSecure, setSmtpSecure] = useState(false)
    const [smtpUsername, setSmtpUsername] = useState('')
    const [smtpPassword, setSmtpPassword] = useState('')
    const [smtpPasswordMasked, setSmtpPasswordMasked] = useState<string | null>(
        null
    )
    const [smtpFrom, setSmtpFrom] = useState('')
    const [smtpReplyTo, setSmtpReplyTo] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [testTo, setTestTo] = useState('')
    const [testBusy, setTestBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getEmailProvider()
            .then((settings) => {
                setProvider(settings.provider)
                setFrom(settings.resend?.from ?? '')
                setReplyTo(settings.resend?.replyTo ?? '')
                setApiKeyMasked(settings.resend?.apiKeyMasked ?? null)
                setSmtpHost(settings.smtp?.host ?? '')
                setSmtpPort(String(settings.smtp?.port ?? 587))
                setSmtpSecure(settings.smtp?.secure ?? false)
                setSmtpUsername(settings.smtp?.username ?? '')
                setSmtpPasswordMasked(settings.smtp?.passwordMasked ?? null)
                setSmtpFrom(settings.smtp?.from ?? '')
                setSmtpReplyTo(settings.smtp?.replyTo ?? '')
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        try {
            const settings = await client.admin.settings.updateEmailProvider({
                provider,
                ...(provider === 'resend'
                    ? {
                          resendFrom: from,
                          resendReplyTo: replyTo.trim() || null,
                          resendApiKey: apiKey
                      }
                    : {}),
                ...(provider === 'smtp'
                    ? {
                          smtpHost,
                          smtpPort: Number(smtpPort),
                          smtpSecure,
                          smtpUsername: smtpUsername.trim() || null,
                          smtpPassword,
                          smtpFrom,
                          smtpReplyTo: smtpReplyTo.trim() || null
                      }
                    : {})
            })
            setProvider(settings.provider)
            setFrom(settings.resend?.from ?? '')
            setReplyTo(settings.resend?.replyTo ?? '')
            setApiKeyMasked(settings.resend?.apiKeyMasked ?? null)
            setSmtpHost(settings.smtp?.host ?? '')
            setSmtpPort(String(settings.smtp?.port ?? 587))
            setSmtpSecure(settings.smtp?.secure ?? false)
            setSmtpUsername(settings.smtp?.username ?? '')
            setSmtpPasswordMasked(settings.smtp?.passwordMasked ?? null)
            setSmtpFrom(settings.smtp?.from ?? '')
            setSmtpReplyTo(settings.smtp?.replyTo ?? '')
            setApiKey('')
            setSmtpPassword('')
            setStatus('Saved')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const sendTest = async (): Promise<void> => {
        setTestBusy(true)
        setError(null)
        setStatus(null)
        try {
            const result = await client.admin.settings.sendTestEmail({
                to: testTo.trim()
            })
            setStatus(
                result.provider === 'console'
                    ? 'Test email logged to the API console (provider is console).'
                    : `Test email sent via ${result.provider}.`
            )
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setTestBusy(false)
        }
    }

    return (
        <div className='mx-auto max-w-3xl'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Email provider
                </Heading>
                <p className='admin-page-description'>
                    Outbound email used by waitlist confirmations and invites.
                    The console provider only logs messages to the API output;
                    switch to Resend or SMTP to actually deliver them. Changes
                    apply within seconds, no redeploy needed.
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

            {!loaded && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {loaded && (
                <Card elevation='ambient' className='p-3'>
                    <div className='grid gap-3 md:grid-cols-2'>
                        <label className='block'>
                            <span className='text-caption text-label mb-1 block font-normal'>
                                Provider
                            </span>
                            <select
                                value={provider}
                                onChange={(e) =>
                                    setProvider(
                                        e.target.value as EmailProviderKind
                                    )
                                }
                                className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-8 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'
                            >
                                <option value='console'>
                                    Console (log only)
                                </option>
                                <option value='resend'>Resend</option>
                                <option value='smtp'>SMTP</option>
                            </select>
                        </label>
                    </div>

                    {provider === 'resend' && (
                        <div className='mt-3 grid gap-3 md:grid-cols-2'>
                            <Input
                                id='settings-email-resend-from'
                                label='From'
                                value={from}
                                onChange={(e) => setFrom(e.target.value)}
                                hint='e.g. "Manyfold <no-reply@manyfold.ai>". The domain must be verified in Resend.'
                            />
                            <Input
                                id='settings-email-resend-reply-to'
                                label='Reply-To (optional)'
                                value={replyTo}
                                onChange={(e) => setReplyTo(e.target.value)}
                            />
                            <Input
                                id='settings-email-resend-api-key'
                                label='Resend API key'
                                type='password'
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                hint={
                                    apiKeyMasked
                                        ? `Leave blank to keep the stored key (${apiKeyMasked}).`
                                        : undefined
                                }
                            />
                        </div>
                    )}

                    {provider === 'smtp' && (
                        <div className='mt-3 grid gap-3 md:grid-cols-2'>
                            <Input
                                id='settings-email-smtp-host'
                                label='Host'
                                value={smtpHost}
                                onChange={(e) => setSmtpHost(e.target.value)}
                                placeholder='smtp.example.com'
                            />
                            <Input
                                id='settings-email-smtp-port'
                                label='Port'
                                value={smtpPort}
                                onChange={(e) => setSmtpPort(e.target.value)}
                                hint='587 for STARTTLS, 465 for implicit TLS.'
                            />
                            <label className='flex items-center gap-2 md:col-span-2'>
                                <input
                                    type='checkbox'
                                    checked={smtpSecure}
                                    onChange={(e) =>
                                        setSmtpSecure(e.target.checked)
                                    }
                                />
                                <span className='text-caption text-label'>
                                    Implicit TLS (port 465). Leave unchecked to
                                    upgrade via STARTTLS when the server offers
                                    it.
                                </span>
                            </label>
                            <Input
                                id='settings-email-smtp-username'
                                label='Username (optional)'
                                value={smtpUsername}
                                onChange={(e) =>
                                    setSmtpUsername(e.target.value)
                                }
                                hint='Leave blank for an unauthenticated relay.'
                            />
                            <Input
                                id='settings-email-smtp-password'
                                label='Password'
                                type='password'
                                value={smtpPassword}
                                onChange={(e) =>
                                    setSmtpPassword(e.target.value)
                                }
                                hint={
                                    smtpPasswordMasked
                                        ? `Leave blank to keep the stored password (${smtpPasswordMasked}).`
                                        : undefined
                                }
                            />
                            <Input
                                id='settings-email-smtp-from'
                                label='From'
                                value={smtpFrom}
                                onChange={(e) => setSmtpFrom(e.target.value)}
                                hint='e.g. "Manyfold <no-reply@your-domain.com>"'
                            />
                            <Input
                                id='settings-email-smtp-reply-to'
                                label='Reply-To (optional)'
                                value={smtpReplyTo}
                                onChange={(e) =>
                                    setSmtpReplyTo(e.target.value)
                                }
                            />
                        </div>
                    )}

                    <div className='border-border mt-4 border-t pt-3'>
                        <div className='flex flex-wrap items-end gap-2'>
                            <div className='min-w-64 flex-1'>
                                <Input
                                    id='settings-email-test-to'
                                    label='Send a test email'
                                    type='email'
                                    value={testTo}
                                    onChange={(e) => setTestTo(e.target.value)}
                                    placeholder='you@example.com'
                                    hint='Uses the saved configuration — save changes first.'
                                />
                            </div>
                            <Button
                                variant='ghost'
                                disabled={testBusy || !testTo.trim()}
                                onClick={() => void sendTest()}
                            >
                                {testBusy ? 'Sending...' : 'Send test'}
                            </Button>
                        </div>
                    </div>

                    <div className='mt-4 flex items-center justify-end gap-2'>
                        {status && (
                            <span className='text-caption-sm text-brand'>
                                {status}
                            </span>
                        )}
                        <Button variant='ghost' onClick={load} disabled={busy}>
                            Reset
                        </Button>
                        <Button
                            variant='primary'
                            disabled={busy}
                            onClick={() => void save()}
                        >
                            Save
                        </Button>
                    </div>
                </Card>
            )}
        </div>
    )
}

export default EmailProviderSettingsPage

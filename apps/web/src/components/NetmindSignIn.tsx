import type { FC, FormEvent } from 'react'
import { useState } from 'react'
import { ShieldAlertIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { GithubMono, GoogleColor, MicrosoftColor } from '@/lib/brandIcons'
import { useI18n } from '@/lib/i18n'
import { isNetmindOAuthConfigured } from '@/lib/netmindAuth/config'
import { useNetmindAuth } from '@/lib/netmindAuth/useNetmindAuth'

interface NetmindSignInProps {
    // What to do with a verified NetMind loginToken — trade it for a session
    // (login page) or link it to the current account (Account settings).
    onToken: (loginToken: string) => Promise<void> | void
    submitLabel: string
    busy?: boolean
}

const OAUTH_PROVIDERS = [
    { key: 'GOOGLE', label: 'Google', Icon: GoogleColor },
    { key: 'MICROSOFT', label: 'Microsoft', Icon: MicrosoftColor },
    { key: 'GITHUB', label: 'GitHub', Icon: GithubMono }
] as const

const ErrorNote: FC<{ message: string }> = ({ message }) => (
    <div
        role='alert'
        className='bg-error-bg flex items-start gap-2.5 rounded-sm px-3 py-2.5'
    >
        <ShieldAlertIcon className='text-error mt-0.5 h-4 w-4 shrink-0' />
        <p className='text-ui text-fg min-w-0'>{message}</p>
    </div>
)

// NetMind email/password + OAuth sign-in surface, shared by the login page and
// the Account "Connect NetMind" card. Renders only the inputs/buttons — the
// parent owns the surrounding card/heading and the post-token outcome.
export const NetmindSignIn: FC<NetmindSignInProps> = ({
    onToken,
    submitLabel,
    busy
}) => {
    const { t } = useI18n()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [bandEmail, setBandEmail] = useState('')
    const [bandCode, setBandCode] = useState('')
    const netmind = useNetmindAuth({ onToken })
    const oauthReady = isNetmindOAuthConfigured()
    const disabled = Boolean(busy) || netmind.loading

    if (netmind.bindInfo) {
        const submitBind = (event: FormEvent): void => {
            event.preventDefault()
            void netmind.submitBind({
                email: bandEmail,
                verifyCode: bandCode
            })
        }
        return (
            <form className='space-y-4' onSubmit={submitBind}>
                <p className='text-ui text-muted'>
                    {t('web.auth.netmindBindPrompt')}
                </p>
                {netmind.bindInfo.bandType === 1 ? (
                    <>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.auth.emailLabel')}
                            </span>
                            <input
                                className='workbench-input'
                                type='email'
                                autoComplete='email'
                                placeholder={t('web.account.emailPlaceholder')}
                                value={bandEmail}
                                onChange={(e) => setBandEmail(e.target.value)}
                            />
                        </label>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.auth.verificationCodeLabel')}
                            </span>
                            <input
                                className='workbench-input'
                                type='text'
                                inputMode='numeric'
                                autoComplete='one-time-code'
                                placeholder={t(
                                    'web.auth.netmindCodePlaceholder'
                                )}
                                value={bandCode}
                                onChange={(e) => setBandCode(e.target.value)}
                            />
                        </label>
                    </>
                ) : null}
                {netmind.error ? <ErrorNote message={netmind.error} /> : null}
                <div className='flex flex-wrap justify-end gap-2 pt-1'>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        onClick={netmind.closeBind}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={disabled}
                    >
                        {netmind.loading ? (
                            <Spinner size={16} className='mr-2' />
                        ) : null}
                        {t('web.auth.netmindConfirm')}
                    </button>
                </div>
            </form>
        )
    }

    const submitEmail = (event: FormEvent): void => {
        event.preventDefault()
        if (disabled || email.trim().length === 0 || password.length === 0)
            return
        void netmind.emailLogin(email.trim(), password)
    }

    return (
        <form className='space-y-4' onSubmit={submitEmail}>
            <label className='block'>
                <span className='workbench-field-label'>
                    {t('web.auth.netmindEmailLabel')}
                </span>
                <input
                    className='workbench-input'
                    type='email'
                    autoComplete='off'
                    placeholder={t('web.account.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                />
            </label>
            <label className='block'>
                <span className='workbench-field-label'>
                    {t('web.auth.netmindPasswordLabel')}
                </span>
                <input
                    className='workbench-input'
                    type='password'
                    autoComplete='off'
                    placeholder={t('web.auth.netmindPasswordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </label>
            {netmind.error ? <ErrorNote message={netmind.error} /> : null}
            <button
                type='submit'
                className='workbench-button-primary w-full'
                disabled={
                    disabled ||
                    email.trim().length === 0 ||
                    password.length === 0
                }
            >
                {netmind.loading ? (
                    <Spinner size={16} className='mr-2' />
                ) : null}
                {netmind.loading
                    ? t('web.auth.netmindConnecting')
                    : submitLabel}
            </button>
            {oauthReady ? (
                <>
                    <div
                        className='flex items-center gap-3'
                        role='separator'
                        aria-label={t('web.auth.netmindOrContinueWith')}
                    >
                        <span className='bg-divider h-px flex-1' />
                        <span className='text-caption text-muted'>
                            {t('web.auth.netmindOrContinueWith')}
                        </span>
                        <span className='bg-divider h-px flex-1' />
                    </div>
                    <div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                        {OAUTH_PROVIDERS.map(({ key, label, Icon }) => (
                            <button
                                key={key}
                                type='button'
                                className='workbench-button-secondary gap-2'
                                disabled={disabled}
                                onClick={() => netmind.startOAuth(key)}
                            >
                                <span
                                    className='text-fg inline-flex shrink-0'
                                    aria-hidden='true'
                                >
                                    <Icon size={15} />
                                </span>
                                {label}
                            </button>
                        ))}
                    </div>
                    <p className='text-caption text-muted'>
                        {t('web.auth.netmindMethodNote')}
                    </p>
                </>
            ) : null}
        </form>
    )
}

import type { AuthIdentitySummary } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { ShieldAlertIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'

/* Atomic change-email: the account always keeps exactly one sign-in email.
   Step 'form' collects the new address plus owner proof — the current
   password for password holders, or a Google re-auth token for password-less
   accounts (those also pick their first password here, so the flow never
   ends with an email nobody can sign in to). Step 'code' confirms the new
   mailbox with the 6-digit code the backend mailed to it. */

interface ChangeEmailStartInput {
    newEmail: string
    currentPassword?: string
    reauthToken?: string
}

interface ChangeEmailDialogProps {
    accountEmail: string
    hasPassword: boolean
    googleLinked: boolean
    // Minted by the Google link-mode round-trip (?reauth=... on return).
    reauthToken: string | null
    // Kick off the Google round-trip (navigates away; the dialog reopens on
    // return with reauthToken set).
    onGoogleReauth: () => Promise<void>
    onStart: (input: ChangeEmailStartInput) => Promise<void>
    onVerify: (input: {
        newEmail: string
        code: string
        newPassword?: string
    }) => Promise<AuthIdentitySummary[]>
    onDone: (items: AuthIdentitySummary[], newEmail: string) => void
    onClose: () => void
}

const MIN_PASSWORD_LENGTH = 8
const CODE_LENGTH = 6

export const ChangeEmailDialog: FC<ChangeEmailDialogProps> = ({
    accountEmail,
    hasPassword,
    googleLinked,
    reauthToken,
    onGoogleReauth,
    onStart,
    onVerify,
    onDone,
    onClose
}) => {
    const { t } = useI18n()
    const [step, setStep] = useState<'form' | 'code'>('form')
    const [newEmail, setNewEmail] = useState('')
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [code, setCode] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [resent, setResent] = useState(false)

    // A Google re-auth token, once present, satisfies re-auth for anyone —
    // it's also the escape hatch for a password holder whose password was set
    // mid-session (the server rejects that password, so the token is the only
    // way through). Without a token: password holders use the current
    // password; password-less accounts must re-auth via Google first.
    const useReauthToken = Boolean(reauthToken)
    const needsGoogleReauth = !hasPassword && !useReauthToken
    const needsCurrentPassword = hasPassword && !useReauthToken
    const needsNewPassword = !hasPassword && useReauthToken

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())
    const sameEmail =
        newEmail.trim().toLowerCase() === accountEmail.toLowerCase()
    const passwordShort =
        newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH
    const passwordMismatch = confirm.length > 0 && confirm !== newPassword
    const formReady =
        emailValid &&
        !sameEmail &&
        !busy &&
        (!needsCurrentPassword || currentPassword.length > 0) &&
        (!needsNewPassword ||
            (newPassword.length >= MIN_PASSWORD_LENGTH &&
                confirm === newPassword))

    const startInput = (): ChangeEmailStartInput => ({
        newEmail: newEmail.trim(),
        ...(useReauthToken
            ? { reauthToken: reauthToken ?? undefined }
            : { currentPassword })
    })

    const submitForm = (event: FormEvent): void => {
        event.preventDefault()
        if (!formReady) return
        setError(null)
        setBusy(true)
        void onStart(startInput())
            .then(() => {
                setStep('code')
                setCode('')
            })
            .catch((err: unknown) => {
                setError(
                    err instanceof Error
                        ? err.message
                        : t('web.account.changeEmailStartFailed')
                )
            })
            .finally(() => setBusy(false))
    }

    const resend = (): void => {
        if (busy) return
        setError(null)
        setBusy(true)
        setResent(false)
        void onStart(startInput())
            .then(() => setResent(true))
            .catch((err: unknown) => {
                setError(
                    err instanceof Error
                        ? err.message
                        : t('web.account.codeResendFailed')
                )
            })
            .finally(() => setBusy(false))
    }

    const submitCode = (event: FormEvent): void => {
        event.preventDefault()
        if (busy || code.trim().length !== CODE_LENGTH) return
        setError(null)
        setBusy(true)
        void onVerify({
            newEmail: newEmail.trim(),
            code: code.trim(),
            ...(needsNewPassword ? { newPassword } : {})
        })
            .then((items) => onDone(items, newEmail.trim()))
            .catch((err: unknown) => {
                setError(
                    err instanceof Error
                        ? err.message
                        : t('web.account.codeVerifyFailed')
                )
            })
            .finally(() => setBusy(false))
    }

    const startGoogle = (): void => {
        setError(null)
        setBusy(true)
        void onGoogleReauth().catch((err: unknown) => {
            setBusy(false)
            setError(
                err instanceof Error
                    ? err.message
                    : t('web.account.changeEmailGoogleStartFailed')
            )
        })
    }

    const errorBox: ReactNode = error ? (
        <div
            role='alert'
            className='bg-error-bg flex items-start gap-2.5 rounded-sm px-3 py-2.5'
        >
            <ShieldAlertIcon className='text-error mt-0.5 h-4 w-4 shrink-0' />
            <p className='text-ui text-fg min-w-0'>{error}</p>
        </div>
    ) : null

    if (step === 'code')
        return (
            <ProductDialog
                title={t('web.account.codeTitle')}
                description={t('web.account.codeSent', {
                    email: newEmail.trim()
                })}
                size='sm'
                onClose={onClose}
                bodyClassName='pb-5'
            >
                <form className='space-y-4' onSubmit={submitCode}>
                    <label className='block'>
                        <span className='workbench-field-label'>
                            {t('web.auth.verificationCodeLabel')}
                        </span>
                        <input
                            className='workbench-input tracking-[0.3em]'
                            inputMode='numeric'
                            autoComplete='one-time-code'
                            placeholder='000000'
                            maxLength={CODE_LENGTH}
                            value={code}
                            onChange={(e) =>
                                setCode(e.target.value.replace(/\D/g, ''))
                            }
                        />
                    </label>
                    {resent ? (
                        <p className='text-caption text-muted'>
                            {t('web.account.codeOnWay')}
                        </p>
                    ) : null}
                    {errorBox}
                    <button
                        type='submit'
                        className='workbench-button-primary w-full'
                        disabled={busy || code.trim().length !== CODE_LENGTH}
                    >
                        {busy ? <Spinner size={16} className='mr-2' /> : null}
                        {busy
                            ? t('web.account.verifying')
                            : t('web.account.changeEmail')}
                    </button>
                    <p className='text-caption text-muted text-center'>
                        {t('web.account.codeMissing')}{' '}
                        <button
                            type='button'
                            className='text-fg underline underline-offset-2'
                            onClick={resend}
                            disabled={busy}
                        >
                            {t('web.account.codeResend')}
                        </button>
                    </p>
                </form>
            </ProductDialog>
        )

    if (needsGoogleReauth)
        return (
            <ProductDialog
                title={t('web.account.changeEmail')}
                description={t('web.account.changeEmailCurrent', {
                    email: accountEmail
                })}
                size='sm'
                onClose={onClose}
                bodyClassName='pb-5'
            >
                <div className='space-y-4'>
                    <p className='text-ui text-muted'>
                        {googleLinked
                            ? t('web.account.changeEmailGoogleProof')
                            : t('web.account.changeEmailNeedsProof')}
                    </p>
                    {errorBox}
                    {googleLinked ? (
                        <button
                            type='button'
                            className='workbench-button-primary w-full'
                            disabled={busy}
                            onClick={startGoogle}
                        >
                            {busy ? (
                                <Spinner size={16} className='mr-2' />
                            ) : null}
                            {t('web.account.verifyWithGoogle')}
                        </button>
                    ) : null}
                </div>
            </ProductDialog>
        )

    return (
        <ProductDialog
            title={t('web.account.changeEmail')}
            description={t('web.account.changeEmailDescription', {
                email: accountEmail
            })}
            size='sm'
            onClose={onClose}
            bodyClassName='pb-5'
        >
            <form className='space-y-4' onSubmit={submitForm}>
                <label className='block'>
                    <span className='workbench-field-label'>
                        {t('web.account.newEmail')}
                    </span>
                    <input
                        className='workbench-input'
                        type='email'
                        autoComplete='email'
                        placeholder={t('web.account.emailPlaceholder')}
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                    />
                    {sameEmail ? (
                        <span className='text-caption text-warning mt-1.5 block'>
                            {t('web.account.sameEmail')}
                        </span>
                    ) : null}
                </label>
                {needsCurrentPassword ? (
                    <label className='block'>
                        <span className='workbench-field-label'>
                            {t('web.account.currentPassword')}
                        </span>
                        <input
                            className='workbench-input'
                            type='password'
                            autoComplete='current-password'
                            placeholder={t(
                                'web.account.currentPasswordPlaceholder'
                            )}
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                        />
                        {googleLinked ? (
                            <button
                                type='button'
                                className='text-caption text-muted hover:text-fg mt-2 underline underline-offset-2'
                                onClick={startGoogle}
                            >
                                {t('web.account.verifyWithGoogleFallback')}
                            </button>
                        ) : null}
                    </label>
                ) : needsNewPassword ? (
                    <>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.account.newPassword')}
                            </span>
                            <input
                                className='workbench-input'
                                type='password'
                                autoComplete='new-password'
                                placeholder={t('web.account.passwordMinimum', {
                                    count: MIN_PASSWORD_LENGTH
                                })}
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                            />
                            {passwordShort ? (
                                <span className='text-caption text-warning mt-1.5 block'>
                                    {t('web.account.passwordMinimum', {
                                        count: MIN_PASSWORD_LENGTH
                                    })}
                                </span>
                            ) : (
                                <span className='text-caption text-muted mt-1.5 block'>
                                    {t('web.account.newEmailPasswordHint')}
                                </span>
                            )}
                        </label>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.account.confirmPassword')}
                            </span>
                            <input
                                className='workbench-input'
                                type='password'
                                autoComplete='new-password'
                                placeholder={t(
                                    'web.account.confirmPasswordPlaceholder'
                                )}
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                            />
                            {passwordMismatch ? (
                                <span className='text-caption text-warning mt-1.5 block'>
                                    {t('web.account.passwordsMismatch')}
                                </span>
                            ) : null}
                        </label>
                    </>
                ) : null}
                {errorBox}
                <button
                    type='submit'
                    className='workbench-button-primary w-full'
                    disabled={!formReady}
                >
                    {busy ? <Spinner size={16} className='mr-2' /> : null}
                    {busy
                        ? t('web.account.sendingCode')
                        : t('web.account.sendVerificationCode')}
                </button>
            </form>
        </ProductDialog>
    )
}

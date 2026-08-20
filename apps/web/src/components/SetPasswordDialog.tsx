import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { ShieldAlertIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'

/* Setting the FIRST password is a two-step verified flow: step 'form'
   collects the password and mails a 6-digit code to the account's sign-in
   email; step 'code' proves inbox control and stores the password. A live
   session alone must not mint a sign-in credential — a hijacked session
   could otherwise set a password and replay it as change-email re-auth.
   Changing an existing password stays single-step: the current password is
   the owner proof. */

interface SetPasswordDialogProps {
    // The account's primary email the password will belong to — always shown
    // so there is no ambiguity about which address gets password sign-in.
    email: string
    requireCurrent?: boolean
    // First-set only: mails the setup code to the account email (the server
    // resolves the address; it is never sent from here).
    onSendCode: () => Promise<void>
    // Resolve on success (parent refreshes the list and closes); throw to keep
    // the dialog open with the error shown inside.
    onSubmit: (input: {
        password: string
        currentPassword?: string
        code?: string
    }) => Promise<void>
    onClose: () => void
}

const MIN_PASSWORD_LENGTH = 8
const CODE_LENGTH = 6

export const SetPasswordDialog: FC<SetPasswordDialogProps> = ({
    email,
    requireCurrent = false,
    onSendCode,
    onSubmit,
    onClose
}) => {
    const { t } = useI18n()
    const [step, setStep] = useState<'form' | 'code'>('form')
    const [current, setCurrent] = useState('')
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [code, setCode] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [resent, setResent] = useState(false)

    const tooShort =
        password.length > 0 && password.length < MIN_PASSWORD_LENGTH
    const mismatch = confirm.length > 0 && confirm !== password
    const formReady =
        password.length >= MIN_PASSWORD_LENGTH &&
        confirm === password &&
        (!requireCurrent || current.length > 0) &&
        !busy

    const fail = (err: unknown, fallback: string): void => {
        setError(err instanceof Error ? err.message : fallback)
    }

    const submitForm = (event: FormEvent): void => {
        event.preventDefault()
        if (!formReady) return
        setError(null)
        setBusy(true)
        if (requireCurrent) {
            void onSubmit({ password, currentPassword: current })
                .catch((err: unknown) =>
                    fail(err, t('web.account.passwordSetFailed'))
                )
                .finally(() => setBusy(false))
            return
        }
        void onSendCode()
            .then(() => {
                setStep('code')
                setCode('')
            })
            .catch((err: unknown) =>
                fail(err, t('web.account.passwordCodeSendFailed'))
            )
            .finally(() => setBusy(false))
    }

    const resend = (): void => {
        if (busy) return
        setError(null)
        setBusy(true)
        setResent(false)
        void onSendCode()
            .then(() => setResent(true))
            .catch((err: unknown) =>
                fail(err, t('web.account.codeResendFailed'))
            )
            .finally(() => setBusy(false))
    }

    const submitCode = (event: FormEvent): void => {
        event.preventDefault()
        if (busy || code.trim().length !== CODE_LENGTH) return
        setError(null)
        setBusy(true)
        void onSubmit({ password, code: code.trim() })
            .catch((err: unknown) =>
                fail(err, t('web.account.passwordSetFailed'))
            )
            .finally(() => setBusy(false))
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
                description={t('web.account.codeSent', { email })}
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
                            ? t('web.account.savingPassword')
                            : t('web.account.setPassword')}
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

    return (
        <ProductDialog
            title={
                requireCurrent
                    ? t('web.account.passwordTitleChange')
                    : t('web.account.passwordTitleSet')
            }
            description={
                requireCurrent
                    ? t('web.account.passwordDescriptionChange', { email })
                    : t('web.account.passwordDescriptionSet', { email })
            }
            size='sm'
            onClose={onClose}
            bodyClassName='pb-5'
        >
            <form className='space-y-4' onSubmit={submitForm}>
                {requireCurrent ? (
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
                            value={current}
                            onChange={(e) => setCurrent(e.target.value)}
                        />
                    </label>
                ) : null}
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
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    {tooShort ? (
                        <span className='text-caption text-warning mt-1.5 block'>
                            {t('web.account.passwordMinimum', {
                                count: MIN_PASSWORD_LENGTH
                            })}
                        </span>
                    ) : null}
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
                    {mismatch ? (
                        <span className='text-caption text-warning mt-1.5 block'>
                            {t('web.account.passwordsMismatch')}
                        </span>
                    ) : null}
                </label>
                {errorBox}
                <button
                    type='submit'
                    className='workbench-button-primary w-full'
                    disabled={!formReady}
                >
                    {busy ? <Spinner size={16} className='mr-2' /> : null}
                    {busy
                        ? requireCurrent
                            ? t('web.account.savingPassword')
                            : t('web.account.sendingCode')
                        : requireCurrent
                          ? t('web.account.setPassword')
                          : t('web.account.sendVerificationCode')}
                </button>
            </form>
        </ProductDialog>
    )
}

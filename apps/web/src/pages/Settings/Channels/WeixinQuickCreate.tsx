import type {
    WeixinRegistrationStatus,
    WeixinRegistrationSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ApiError } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const POLL_MS = 2000

interface WeixinQuickCreateProps {
    agentId: string
    label: string
    onCreated: (channelId: string) => void
    onStateChange: (state: WeixinQuickCreateState) => void
}

export interface WeixinQuickCreateState {
    id: string | null
    status: 'idle' | 'starting' | WeixinRegistrationStatus
}

const WeixinQuickCreate: FC<WeixinQuickCreateProps> = ({
    agentId,
    label,
    onCreated,
    onStateChange
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [registration, setRegistration] =
        useState<WeixinRegistrationSummary | null>(null)
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [verifyCode, setVerifyCode] = useState('')
    const [submittingCode, setSubmittingCode] = useState(false)
    const registrationRef = useRef<WeixinRegistrationSummary | null>(null)
    const mountedRef = useRef(true)
    const completedRef = useRef(false)

    useEffect(() => {
        mountedRef.current = true
        return (): void => {
            mountedRef.current = false
            const current = registrationRef.current
            if (
                current?.status === 'pending' ||
                current?.status === 'need_verify_code'
            )
                void client.channels
                    .cancelWeixinRegistration(current.id)
                    .catch(() => undefined)
        }
    }, [client])

    const lifecycleStatus: WeixinQuickCreateState['status'] = starting
        ? 'starting'
        : (registration?.status ?? 'idle')
    const lifecycleId = starting ? null : (registration?.id ?? null)

    useEffect(() => {
        onStateChange({ id: lifecycleId, status: lifecycleStatus })
    }, [lifecycleId, lifecycleStatus, onStateChange])

    const start = useCallback(async (): Promise<void> => {
        setStarting(true)
        setError(null)
        setVerifyCode('')
        completedRef.current = false
        try {
            const next = await client.channels.startWeixinRegistration({
                agentId,
                label
            })
            if (!mountedRef.current) {
                if (next.status === 'pending')
                    void client.channels
                        .cancelWeixinRegistration(next.id)
                        .catch(() => undefined)
                return
            }
            registrationRef.current = next
            setRegistration(next)
        } catch (err) {
            if (!mountedRef.current) return
            setError(
                err instanceof ApiError &&
                    err.code === 'weixin_registration_unavailable'
                    ? t('web.channels.weixinQuick.unavailable')
                    : apiErrorMessage(err)
            )
        } finally {
            if (mountedRef.current) setStarting(false)
        }
    }, [agentId, client, label, t])

    const registrationId = registration?.id ?? null
    // need_verify_code parks polling: the server will not advance until the
    // pairing code is submitted, so stop hammering the endpoint.
    const shouldPoll =
        registration?.status === 'pending' ||
        registration?.status === 'creating'

    useEffect(() => {
        if (!registrationId || !shouldPoll) return
        let cancelled = false
        let inFlight = false
        const load = async (): Promise<void> => {
            if (inFlight) return
            inFlight = true
            try {
                const next =
                    await client.channels.getWeixinRegistration(registrationId)
                if (cancelled) return
                registrationRef.current = next
                setRegistration(next)
                setError(null)
                if (
                    next.status === 'succeeded' &&
                    next.channelId &&
                    !completedRef.current
                ) {
                    completedRef.current = true
                    onCreated(next.channelId)
                }
            } catch (err) {
                if (!cancelled) setError(apiErrorMessage(err))
            } finally {
                inFlight = false
            }
        }
        void load()
        const poll = window.setInterval(() => {
            if (!document.hidden) void load()
        }, POLL_MS)
        return (): void => {
            cancelled = true
            window.clearInterval(poll)
        }
    }, [client, onCreated, registrationId, shouldPoll])

    const submitVerifyCode = async (): Promise<void> => {
        if (!registrationId || verifyCode.trim().length === 0) return
        setSubmittingCode(true)
        setError(null)
        try {
            const next = await client.channels.submitWeixinVerifyCode(
                registrationId,
                verifyCode.trim()
            )
            registrationRef.current = next
            setRegistration(next)
            setVerifyCode('')
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSubmittingCode(false)
        }
    }

    const canStart = agentId.trim().length > 0 && label.trim().length > 0

    if (!registration)
        return (
            <div className='bg-soft shadow-ring-light space-y-3 rounded-md p-4'>
                <p className='text-ui text-muted'>
                    {t('web.channels.weixinQuick.scanHint')}
                </p>
                {error && <div className='workbench-alert-error'>{error}</div>}
                <button
                    type='button'
                    onClick={() => void start()}
                    disabled={!canStart || starting}
                    className='workbench-button-primary disabled:opacity-40'
                >
                    {starting
                        ? t('web.channels.weixinQuick.waiting')
                        : t('web.channels.weixinQuick.start')}
                </button>
            </div>
        )

    if (
        (registration.status === 'pending' ||
            registration.status === 'need_verify_code') &&
        registration.qrcodeContent
    )
        return (
            <div className='bg-soft shadow-ring-light space-y-4 rounded-md p-4'>
                <div className='flex justify-center'>
                    <div className='rounded-sm bg-white p-3 shadow-ring-light'>
                        <QRCodeSVG
                            value={registration.qrcodeContent}
                            size={200}
                        />
                    </div>
                </div>
                <p className='text-ui text-fg text-center'>
                    {t('web.channels.weixinQuick.scanHint')}
                </p>
                {registration.status === 'need_verify_code' ? (
                    <div className='space-y-2'>
                        <p className='text-ui text-fg text-center'>
                            {t('web.channels.weixinQuick.verifyPrompt')}
                        </p>
                        <div className='flex items-center justify-center gap-2'>
                            <input
                                type='text'
                                inputMode='numeric'
                                className='workbench-input w-32 text-center'
                                value={verifyCode}
                                onChange={(e) => setVerifyCode(e.target.value)}
                                autoComplete='one-time-code'
                            />
                            <button
                                type='button'
                                onClick={() => void submitVerifyCode()}
                                disabled={
                                    submittingCode ||
                                    verifyCode.trim().length === 0
                                }
                                className='workbench-button-primary disabled:opacity-40'
                            >
                                {t('web.channels.weixinQuick.verifySubmit')}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className='flex items-center justify-center gap-2'>
                        <span
                            className='h-2 w-2 rounded-full bg-warning'
                            aria-hidden='true'
                        />
                        <span className='text-caption text-muted'>
                            {t('web.channels.weixinQuick.waiting')}
                        </span>
                    </div>
                )}
                {error && <div className='workbench-alert-error'>{error}</div>}
            </div>
        )

    if (registration.status === 'creating')
        return (
            <div className='bg-soft shadow-ring-light rounded-md p-4'>
                <div className='flex items-center justify-center gap-2'>
                    <span
                        className='h-2 w-2 animate-pulse rounded-full bg-info motion-reduce:animate-none'
                        aria-hidden='true'
                    />
                    <span className='text-ui text-fg'>
                        {t('web.channels.weixinQuick.creating')}
                    </span>
                </div>
                {error && (
                    <div className='workbench-alert-error mt-3'>{error}</div>
                )}
            </div>
        )

    const message =
        registration.status === 'expired'
            ? t('web.channels.weixinQuick.expired')
            : registration.errorCode === 'access_denied'
              ? t('web.channels.weixinQuick.denied')
              : registration.errorCode === 'already_bound'
                ? t('web.channels.weixinQuick.alreadyBound')
                : registration.errorCode === 'channel_create_failed'
                  ? t('web.channels.weixinQuick.createFailed')
                  : t('web.channels.weixinQuick.unavailable')

    return (
        <div className='space-y-3'>
            <div className='workbench-alert-error'>{error ?? message}</div>
            <button
                type='button'
                onClick={() => void start()}
                disabled={!canStart || starting}
                className='workbench-button-secondary disabled:opacity-40'
            >
                {starting
                    ? t('web.channels.weixinQuick.waiting')
                    : t('web.channels.weixinQuick.retry')}
            </button>
        </div>
    )
}

export default WeixinQuickCreate

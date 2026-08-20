import type {
    LarkAppRegion,
    LarkAppRegistrationStatus,
    LarkAppRegistrationSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ApiError } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const POLL_MS = 2000

interface LarkQuickCreateProps {
    agentId: string
    appRegion: LarkAppRegion
    label: string
    botName: string
    onCreated: (channelId: string) => void
    onStateChange: (state: LarkQuickCreateState) => void
}

export interface LarkQuickCreateState {
    id: string | null
    status: 'idle' | 'starting' | LarkAppRegistrationStatus
}

const LarkQuickCreate: FC<LarkQuickCreateProps> = ({
    agentId,
    appRegion,
    label,
    botName,
    onCreated,
    onStateChange
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [registration, setRegistration] =
        useState<LarkAppRegistrationSummary | null>(null)
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const registrationRef = useRef<LarkAppRegistrationSummary | null>(null)
    const mountedRef = useRef(true)
    const completedRef = useRef(false)

    useEffect(() => {
        mountedRef.current = true
        return (): void => {
            mountedRef.current = false
            const current = registrationRef.current
            if (current?.status === 'pending')
                void client.channels
                    .cancelLarkRegistration(current.id)
                    .catch(() => undefined)
        }
    }, [client])

    const lifecycleStatus: LarkQuickCreateState['status'] = starting
        ? 'starting'
        : (registration?.status ?? 'idle')
    const lifecycleId = starting ? null : (registration?.id ?? null)

    useEffect(() => {
        onStateChange({ id: lifecycleId, status: lifecycleStatus })
    }, [lifecycleId, lifecycleStatus, onStateChange])

    const start = useCallback(async (): Promise<void> => {
        setStarting(true)
        setError(null)
        setCopied(false)
        completedRef.current = false
        try {
            const next = await client.channels.startLarkRegistration({
                agentId,
                appRegion,
                label,
                botName
            })
            if (!mountedRef.current) {
                if (next.status === 'pending')
                    void client.channels
                        .cancelLarkRegistration(next.id)
                        .catch(() => undefined)
                return
            }
            registrationRef.current = next
            setRegistration(next)
        } catch (err) {
            if (!mountedRef.current) return
            setError(
                err instanceof ApiError &&
                    err.code === 'lark_registration_unavailable'
                    ? t('web.channels.larkQuick.unavailable')
                    : apiErrorMessage(err)
            )
        } finally {
            if (mountedRef.current) setStarting(false)
        }
    }, [agentId, appRegion, botName, client, label, t])

    const registrationId = registration?.id ?? null
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
                    await client.channels.getLarkRegistration(registrationId)
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

    const copyLink = async (): Promise<void> => {
        if (!registration?.qrUrl) return
        try {
            await navigator.clipboard.writeText(registration.qrUrl)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    const canStart =
        agentId.trim().length > 0 &&
        label.trim().length > 0 &&
        botName.trim().length > 0

    if (!registration)
        return (
            <div className='bg-soft shadow-ring-light space-y-3 rounded-md p-4'>
                <p className='text-ui text-muted'>
                    {t('web.channels.larkQuick.scanHint')}
                </p>
                {error && <div className='workbench-alert-error'>{error}</div>}
                <button
                    type='button'
                    onClick={() => void start()}
                    disabled={!canStart || starting}
                    className='workbench-button-primary disabled:opacity-40'
                >
                    {starting
                        ? t('web.channels.larkQuick.waiting')
                        : t('web.channels.larkQuick.start')}
                </button>
            </div>
        )

    if (registration.status === 'pending' && registration.qrUrl)
        return (
            <div className='bg-soft shadow-ring-light space-y-4 rounded-md p-4'>
                <div className='flex justify-center'>
                    <div className='rounded-sm bg-white p-3 shadow-ring-light'>
                        <QRCodeSVG value={registration.qrUrl} size={200} />
                    </div>
                </div>
                <p className='text-ui text-fg text-center'>
                    {t('web.channels.larkQuick.scanHint')}
                </p>
                <div className='flex items-center justify-center gap-2'>
                    <span
                        className='h-2 w-2 rounded-full bg-warning'
                        aria-hidden='true'
                    />
                    <span className='text-caption text-muted'>
                        {t('web.channels.larkQuick.waiting')}
                    </span>
                </div>
                <div className='flex justify-center'>
                    <button
                        type='button'
                        onClick={() => void copyLink()}
                        className='workbench-button-ghost'
                    >
                        {copied
                            ? t('web.channels.larkQuick.copied')
                            : t('web.channels.larkQuick.copyLink')}
                    </button>
                </div>
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
                        {t('web.channels.larkQuick.creating')}
                    </span>
                </div>
                {error && (
                    <div className='workbench-alert-error mt-3'>{error}</div>
                )}
            </div>
        )

    const message =
        registration.status === 'expired'
            ? t('web.channels.larkQuick.expired')
            : registration.errorCode === 'access_denied'
              ? t('web.channels.larkQuick.denied')
              : registration.errorCode === 'channel_create_failed'
                ? t('web.channels.larkQuick.createFailed')
                : t('web.channels.larkQuick.unavailable')

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
                    ? t('web.channels.larkQuick.waiting')
                    : t('web.channels.larkQuick.retry')}
            </button>
        </div>
    )
}

export default LarkQuickCreate

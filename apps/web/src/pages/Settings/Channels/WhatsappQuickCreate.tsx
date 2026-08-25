import type {
    WhatsappRegistrationStatus,
    WhatsappRegistrationSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

// WhatsApp rotates the QR about every 20s, so the poll has to be brisk enough
// that the code on screen is still the one the phone will accept.
const POLL_MS = 2000

interface WhatsappQuickCreateProps {
    agentId: string
    label: string
    onCreated: (channelId: string) => void
    onStateChange: (state: WhatsappQuickCreateState) => void
}

export interface WhatsappQuickCreateState {
    id: string | null
    status: 'idle' | 'starting' | WhatsappRegistrationStatus
}

const WhatsappQuickCreate: FC<WhatsappQuickCreateProps> = ({
    agentId,
    label,
    onCreated,
    onStateChange
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [registration, setRegistration] =
        useState<WhatsappRegistrationSummary | null>(null)
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const registrationRef = useRef<WhatsappRegistrationSummary | null>(null)
    const mountedRef = useRef(true)
    const completedRef = useRef(false)

    useEffect(() => {
        mountedRef.current = true
        return (): void => {
            mountedRef.current = false
            const current = registrationRef.current
            // Abandoning the dialog must close the pairing socket the server
            // is holding open, not leave it running until the TTL.
            if (current?.status === 'pending')
                void client.channels
                    .cancelWhatsappRegistration(current.id)
                    .catch(() => undefined)
        }
    }, [client])

    const lifecycleStatus: WhatsappQuickCreateState['status'] = starting
        ? 'starting'
        : (registration?.status ?? 'idle')
    const lifecycleId = starting ? null : (registration?.id ?? null)

    useEffect(() => {
        onStateChange({ id: lifecycleId, status: lifecycleStatus })
    }, [lifecycleId, lifecycleStatus, onStateChange])

    const start = useCallback(async (): Promise<void> => {
        setStarting(true)
        setError(null)
        completedRef.current = false
        try {
            const next = await client.channels.startWhatsappRegistration({
                agentId,
                label
            })
            if (!mountedRef.current) {
                if (next.status === 'pending')
                    void client.channels
                        .cancelWhatsappRegistration(next.id)
                        .catch(() => undefined)
                return
            }
            registrationRef.current = next
            setRegistration(next)
        } catch (err) {
            if (!mountedRef.current) return
            setError(apiErrorMessage(err))
        } finally {
            if (mountedRef.current) setStarting(false)
        }
    }, [agentId, client, label])

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
                    await client.channels.getWhatsappRegistration(
                        registrationId
                    )
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

    const canStart = agentId.trim().length > 0 && label.trim().length > 0

    if (!registration)
        return (
            <div className='bg-soft shadow-ring-light space-y-3 rounded-md p-4'>
                <p className='text-ui text-muted'>
                    {t('web.channels.whatsappQuick.scanHint')}
                </p>
                <p className='text-caption text-muted'>
                    {t('web.channels.whatsappQuick.numberWarning')}
                </p>
                {error && <div className='workbench-alert-error'>{error}</div>}
                <button
                    type='button'
                    onClick={() => void start()}
                    disabled={!canStart || starting}
                    className='workbench-button-primary disabled:opacity-40'
                >
                    {starting
                        ? t('web.channels.whatsappQuick.waiting')
                        : t('web.channels.whatsappQuick.start')}
                </button>
            </div>
        )

    if (registration.status === 'pending')
        return (
            <div className='bg-soft shadow-ring-light space-y-4 rounded-md p-4'>
                {registration.qrContent ? (
                    <div className='flex justify-center'>
                        <div className='shadow-ring-light rounded-sm bg-white p-3'>
                            <QRCodeSVG
                                value={registration.qrContent}
                                size={200}
                            />
                        </div>
                    </div>
                ) : null}
                <p className='text-ui text-fg text-center'>
                    {t('web.channels.whatsappQuick.scanHint')}
                </p>
                <div className='flex items-center justify-center gap-2'>
                    <span
                        className='bg-warning h-2 w-2 rounded-full'
                        aria-hidden='true'
                    />
                    <span className='text-caption text-muted'>
                        {t('web.channels.whatsappQuick.waiting')}
                    </span>
                </div>
                <p className='text-caption text-muted'>
                    {t('web.channels.whatsappQuick.numberWarning')}
                </p>
                {error && <div className='workbench-alert-error'>{error}</div>}
            </div>
        )

    if (registration.status === 'creating')
        return (
            <div className='bg-soft shadow-ring-light rounded-md p-4'>
                <div className='flex items-center justify-center gap-2'>
                    <span
                        className='bg-info h-2 w-2 animate-pulse rounded-full motion-reduce:animate-none'
                        aria-hidden='true'
                    />
                    <span className='text-ui text-fg'>
                        {t('web.channels.whatsappQuick.creating')}
                    </span>
                </div>
                {error && (
                    <div className='workbench-alert-error mt-3'>{error}</div>
                )}
            </div>
        )

    const message =
        registration.status === 'expired'
            ? t('web.channels.whatsappQuick.expired')
            : registration.errorCode === 'already_bound'
              ? t('web.channels.whatsappQuick.alreadyBound')
              : registration.errorCode === 'channel_create_failed'
                ? t('web.channels.whatsappQuick.createFailed')
                : t('web.channels.whatsappQuick.unavailable')

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
                    ? t('web.channels.whatsappQuick.waiting')
                    : t('web.channels.whatsappQuick.retry')}
            </button>
        </div>
    )
}

export default WhatsappQuickCreate

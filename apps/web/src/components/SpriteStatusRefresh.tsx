import type { SpriteStatus } from '@manyfold/shared'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@manyfold/i18n'
import { RefreshIcon } from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { tagToneClass } from '@/components/Tag'
import { spriteStatusLabel, spriteStatusTone } from '@/lib/spriteStatus'

// Frantic-click guard: a manual refresh fires at most this often. An in-flight
// refresh additionally blocks any new one.
const MIN_MANUAL_INTERVAL_MS = 1000

type Props = {
    spriteStatus: SpriteStatus | null
    hostId: string
    onRefresh: (hostId: string) => Promise<void>
}

// The sandbox status badge IS the refresh control: it shows the sprites.dev
// lifecycle (active/warm/cold). Freshness comes from the host-update SSE
// stream; this component only reconciles once when the panel opens (the row
// from the last list() may predate the stream) and on manual click.
export const SpriteStatusRefresh: FC<Props> = ({
    spriteStatus,
    hostId,
    onRefresh
}) => {
    const [refreshing, setRefreshing] = useState(false)
    const refreshingRef = useRef(false)
    const lastFireAt = useRef(0)
    // Latest props read through refs so `fire` stays stable.
    const onRefreshRef = useRef(onRefresh)
    onRefreshRef.current = onRefresh
    const hostIdRef = useRef(hostId)
    hostIdRef.current = hostId

    const fire = useCallback((manual: boolean): void => {
        if (refreshingRef.current) return
        const now = Date.now()
        if (manual && now - lastFireAt.current < MIN_MANUAL_INTERVAL_MS) return
        lastFireAt.current = now
        refreshingRef.current = true
        setRefreshing(true)
        void Promise.resolve(onRefreshRef.current(hostIdRef.current))
            .catch(() => {
                // Best-effort: a transient failure just leaves the last known
                // status; the SSE stream or a manual click catches it up.
            })
            .finally(() => {
                refreshingRef.current = false
                setRefreshing(false)
            })
    }, [])

    // One reconcile per panel open. The ref survives StrictMode's dev
    // double-effect, so this stays exactly one request.
    const firedOnMount = useRef(false)
    useEffect(() => {
        if (firedOnMount.current) return
        firedOnMount.current = true
        fire(false)
    }, [fire])

    return (
        <ShortcutTooltip label={t('common.liveStatus')}>
            <button
                type='button'
                onClick={(): void => fire(true)}
                disabled={refreshing}
                aria-label={t('common.sandboxStatusAria', {
                    status: spriteStatusLabel(spriteStatus)
                })}
                className={`tag ${tagToneClass[spriteStatusTone(spriteStatus)]} transition-opacity hover:opacity-80 disabled:cursor-wait`}
            >
                <span className='relative inline-flex h-1.5 w-1.5 shrink-0'>
                    {spriteStatus === 'running' && (
                        <span className='tag-dot absolute inset-0 animate-ping opacity-75' />
                    )}
                    <span className='tag-dot relative' />
                </span>
                {spriteStatusLabel(spriteStatus)}
                <RefreshIcon
                    className={[
                        'h-3 w-3 shrink-0 opacity-70',
                        refreshing ? 'loading-spin' : ''
                    ].join(' ')}
                />
            </button>
        </ShortcutTooltip>
    )
}

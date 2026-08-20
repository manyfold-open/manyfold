import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'

export type TagTone = 'info' | 'success' | 'warning' | 'error' | 'idle'

// Literal class strings, not `tag-${tone}` — Tailwind only emits @layer
// components rules whose class names appear verbatim in the content scan.
export const tagToneClass: Record<TagTone, string> = {
    info: 'tag-info',
    success: 'tag-success',
    warning: 'tag-warning',
    error: 'tag-error',
    idle: 'tag-idle'
}

// Common status-string → tone mapping (DESIGN.md §10.6). Unknown states
// stay quiet (idle) rather than inventing a hue.
const STATUS_TONES: Record<string, TagTone> = {
    running: 'info',
    active: 'info',
    streaming: 'info',
    starting: 'info',
    provisioning: 'info',
    ready: 'success',
    ok: 'success',
    online: 'success',
    enabled: 'success',
    succeeded: 'success',
    sent: 'success',
    completed: 'success',
    connected: 'success',
    healthy: 'success',
    pending: 'warning',
    queued: 'warning',
    paused: 'warning',
    warning: 'warning',
    degraded: 'warning',
    failed: 'error',
    error: 'error',
    blocked: 'error',
    denied: 'error',
    warm: 'info',
    cold: 'idle',
    idle: 'idle',
    disabled: 'idle',
    offline: 'idle',
    stopped: 'idle',
    archived: 'idle'
}

const STATUS_LABEL_KEYS: Record<string, string> = {
    running: 'web.tags.status.running',
    active: 'web.tags.status.active',
    streaming: 'web.tags.status.streaming',
    starting: 'web.tags.status.starting',
    provisioning: 'web.tags.status.provisioning',
    ready: 'web.tags.status.ready',
    ok: 'web.tags.status.ok',
    online: 'web.tags.status.online',
    enabled: 'web.tags.status.enabled',
    succeeded: 'web.tags.status.succeeded',
    sent: 'web.tags.status.sent',
    completed: 'web.tags.status.completed',
    connected: 'web.tags.status.connected',
    healthy: 'web.tags.status.healthy',
    pending: 'web.tags.status.pending',
    queued: 'web.tags.status.queued',
    paused: 'web.tags.status.paused',
    warning: 'web.tags.status.warning',
    degraded: 'web.tags.status.degraded',
    failed: 'web.tags.status.failed',
    error: 'web.tags.status.error',
    blocked: 'web.tags.status.blocked',
    denied: 'web.tags.status.denied',
    warm: 'web.tags.status.warm',
    cold: 'web.tags.status.cold',
    idle: 'web.tags.status.idle',
    disabled: 'web.tags.status.disabled',
    offline: 'web.tags.status.offline',
    stopped: 'web.tags.status.stopped',
    archived: 'web.tags.status.archived'
}

export const statusTone = (status: string): TagTone =>
    STATUS_TONES[status.toLowerCase()] ?? 'idle'

// Tags are Capitalized sans (§8.3) — raw enum values arrive lowercase.
export const statusLabel = (status: string, t: TFn): string => {
    const normalized = status.toLowerCase()
    const key = STATUS_LABEL_KEYS[normalized]
    return key
        ? t(key)
        : normalized.charAt(0).toUpperCase() + normalized.slice(1).replace(/_/g, ' ')
}

export const riskTone: Record<'low' | 'medium' | 'high', TagTone> = {
    low: 'idle',
    medium: 'warning',
    high: 'error'
}

// Severity annotation for permission scopes. Toned but dot-less: the dot
// marks a live state, and a risk level is a fixed property of the scope.
export const RiskTag: FC<{
    danger: 'low' | 'medium' | 'high'
    className?: string
}> = ({ danger, className }): ReactNode => {
    const { t } = useI18n()
    return (
        <span
            className={['tag', tagToneClass[riskTone[danger]], className]
                .filter(Boolean)
                .join(' ')}
        >
            {t(`web.tags.risk.${danger}`)}
        </span>
    )
}

// Status tag — "what is this thing doing right now". Tinted pill with a
// leading currentColor dot; the label is the mandatory non-color signal.
export const StatusTag: FC<{
    tone: TagTone
    label: string
    pulse?: boolean
    className?: string
}> = ({ tone, label, pulse, className }): ReactNode => (
    <span
        className={['tag', tagToneClass[tone], className]
            .filter(Boolean)
            .join(' ')}
    >
        <span className='relative inline-flex h-1.5 w-1.5 shrink-0'>
            {pulse && (
                <span className='tag-dot absolute inset-0 animate-ping opacity-75' />
            )}
            <span className='tag-dot relative' />
        </span>
        {label}
    </span>
)

// Classification / technical tag — "what kind of thing is this". Neutral,
// no dot. Pass mono for technical values (versions, ports, IDs), which
// keep their literal case.
export const Tag: FC<{
    children: ReactNode
    mono?: boolean
    className?: string
}> = ({ children, mono, className }): ReactNode => (
    <span
        className={['tag tag-neutral', mono ? 'font-mono' : '', className]
            .filter(Boolean)
            .join(' ')}
    >
        {children}
    </span>
)
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { ChannelScopeSummary, ChannelSummary } from '@manyfold/shared'
import { AGENT_SEND_PROVIDERS } from '@manyfold/shared'
import {
    ChannelIcon,
    CheckIcon,
    ChevronDownIcon,
    ExternalLinkIcon
} from '@/components/icons'
import { SheenText } from '@/components/Loading'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import { scopeOptionLabel } from './deliveryLabels'

export interface DeliveryValue {
    channelId: string
    // '' = nothing picked yet, 'scope:<scopeKey>' = an existing conversation,
    // 'custom' = an explicit provider chat/user id.
    destination: string
    kind: 'chat' | 'user'
    id: string
}

export const emptyDelivery: DeliveryValue = {
    channelId: '',
    destination: '',
    kind: 'chat',
    id: ''
}

export const deliveryIsIncomplete = (value: DeliveryValue): boolean =>
    value.channelId !== '' &&
    (value.destination === '' ||
        (value.destination === 'custom' && value.id.trim() === ''))

interface DeliveryPickerProps {
    agentId: string
    agentName: string
    channels: ChannelSummary[]
    value: DeliveryValue
    onChange: (next: DeliveryValue) => void
    placement?: 'top' | 'bottom'
}

const DeliveryPicker: FC<DeliveryPickerProps> = ({
    agentId,
    agentName,
    channels,
    value,
    onChange,
    placement = 'top'
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const menuStyle = useAnchoredMenuPosition(open, rootRef, menuRef, {
        align: 'start',
        matchAnchorWidth: false,
        placement
    })
    const [scopes, setScopes] = useState<Record<string, ChannelScopeSummary[]>>(
        {}
    )
    const [loading, setLoading] = useState(false)

    const deliverable = channels.filter(
        (channel) => channel.agentId === agentId && channel.status === 'active'
    )

    useEffect(() => {
        if (!open || deliverable.length === 0) return
        let cancelled = false
        setLoading(true)
        void Promise.all(
            deliverable.map(async (channel) => {
                try {
                    return [
                        channel.id,
                        await client.channels.listScopes(channel.id)
                    ] as const
                } catch {
                    return [channel.id, [] as ChannelScopeSummary[]] as const
                }
            })
        ).then((entries) => {
            if (cancelled) return
            setScopes(Object.fromEntries(entries))
            setLoading(false)
        })
        return () => {
            cancelled = true
        }
    }, [client, open, agentId, deliverable.length])

    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !rootRef.current?.contains(target) &&
                !menuRef.current?.contains(target)
            )
                setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    const channel =
        deliverable.find((entry) => entry.id === value.channelId) ?? null
    const label = ((): string => {
        if (!channel) return t('web.automations.workbenchOnly')
        if (value.destination === 'custom')
            return `${channel.label} · ${value.id.trim() || t('web.automations.customChatUserId')}`
        const scopeKey = value.destination.slice('scope:'.length)
        const scope = (scopes[channel.id] ?? []).find(
            (entry) => entry.scopeKey === scopeKey
        )
        const name = scope?.activeSession?.displayName ?? scope?.scopeName
        return name ? `${channel.label} · ${name}` : channel.label
    })()

    return (
        <div ref={rootRef} className='relative inline-flex min-w-0'>
            <button
                type='button'
                aria-haspopup='dialog'
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
                className='text-ui text-fg bg-soft hover:bg-surface-hover inline-flex h-10 max-w-full items-center gap-2 rounded-sm px-3.5 font-medium transition-colors'
            >
                <ChannelIcon className='text-subtle h-4 w-4 shrink-0' />
                <span className='truncate'>{label}</span>
                <ChevronDownIcon className='text-subtle h-4 w-4 shrink-0' />
            </button>

            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        role='dialog'
                        aria-label={t('web.automations.deliverResults')}
                        className={[
                            'popover-panel shadow-elevated bg-surface-elevated fixed z-[110] max-h-80 w-[min(22rem,calc(100vw-2rem))] overflow-auto overscroll-contain rounded-md p-1 backdrop-blur',
                            menuStyle ? '' : 'invisible'
                        ].join(' ')}
                        style={menuStyle}
                    >
                        <div className='text-body text-placeholder px-2.5 pb-1.5 pt-2 font-medium'>
                            {t('web.automations.deliverResults')}
                        </div>

                        <OptionRow
                            active={value.channelId === ''}
                            label={t('web.automations.workbenchOnly')}
                            onClick={() => {
                                onChange(emptyDelivery)
                                setOpen(false)
                            }}
                        />

                        {deliverable.length === 0 ? (
                            <div className='border-divider/60 mt-1 border-t px-2.5 pb-2 pt-2.5'>
                                <p className='text-ui text-muted'>
                                    {t('web.automations.noChannelForAgent', {
                                        agent: agentName
                                    })}
                                </p>
                                <Link
                                    to={`/agents/${agentId}/settings/channels`}
                                    className='text-ui text-fg mt-2 inline-flex items-center gap-1.5 font-medium hover:underline'
                                >
                                    {t('web.automations.connectChannel')}
                                    <ExternalLinkIcon className='h-3.5 w-3.5' />
                                </Link>
                            </div>
                        ) : (
                            deliverable.map((entry) => {
                                const entryScopes = scopes[entry.id] ?? []
                                const supportsCustomIds =
                                    AGENT_SEND_PROVIDERS.includes(
                                        entry.provider
                                    )
                                return (
                                    <div
                                        key={entry.id}
                                        className='border-divider/60 mt-1 border-t pt-1'
                                    >
                                        <div className='text-caption text-subtle px-2.5 pb-1 pt-1.5 font-medium'>
                                            {entry.label} · {entry.provider}
                                        </div>
                                        {loading &&
                                            entryScopes.length === 0 && (
                                                <div className='text-ui text-muted px-2.5 pb-1.5'>
                                                    <SheenText>
                                                        {t(
                                                            'web.automations.loadingConversations'
                                                        )}
                                                    </SheenText>
                                                </div>
                                            )}
                                        {!loading &&
                                            entryScopes.length === 0 && (
                                                <p className='text-ui text-muted px-2.5 pb-2'>
                                                    {supportsCustomIds
                                                        ? t(
                                                              'web.automations.noConversationsCustom'
                                                          )
                                                        : t(
                                                              'web.automations.noConversations'
                                                          )}
                                                </p>
                                            )}
                                        {entryScopes.map((scope) => {
                                            const destination = `scope:${scope.scopeKey}`
                                            return (
                                                <OptionRow
                                                    key={scope.scopeKey}
                                                    active={
                                                        value.channelId ===
                                                            entry.id &&
                                                        value.destination ===
                                                            destination
                                                    }
                                                    disabled={
                                                        !scope.activeSession
                                                    }
                                                    label={scopeOptionLabel(
                                                        entry.provider,
                                                        scope,
                                                        t
                                                    )}
                                                    onClick={() => {
                                                        onChange({
                                                            channelId: entry.id,
                                                            destination,
                                                            kind: 'chat',
                                                            id: ''
                                                        })
                                                        setOpen(false)
                                                    }}
                                                />
                                            )
                                        })}
                                        {supportsCustomIds && (
                                            <OptionRow
                                                active={
                                                    value.channelId ===
                                                        entry.id &&
                                                    value.destination ===
                                                        'custom'
                                                }
                                                label={t(
                                                    'web.automations.customChatUserId'
                                                )}
                                                onClick={() =>
                                                    onChange({
                                                        channelId: entry.id,
                                                        destination: 'custom',
                                                        kind: value.kind,
                                                        id: value.id
                                                    })
                                                }
                                            />
                                        )}
                                        {value.channelId === entry.id &&
                                            value.destination === 'custom' && (
                                                <div className='space-y-1.5 px-1.5 pb-2 pt-1'>
                                                    <WorkbenchSelect
                                                        ariaLabel={t(
                                                            'web.automations.sendTo'
                                                        )}
                                                        value={value.kind}
                                                        onChange={(next) =>
                                                            onChange({
                                                                ...value,
                                                                kind:
                                                                    next ===
                                                                    'user'
                                                                        ? 'user'
                                                                        : 'chat'
                                                            })
                                                        }
                                                        options={[
                                                            {
                                                                value: 'chat',
                                                                label: t(
                                                                    'web.automations.chatGroup'
                                                                )
                                                            },
                                                            {
                                                                value: 'user',
                                                                label: t(
                                                                    'web.automations.userDm'
                                                                )
                                                            }
                                                        ]}
                                                    />
                                                    <input
                                                        value={value.id}
                                                        onChange={(event) =>
                                                            onChange({
                                                                ...value,
                                                                id: event.target
                                                                    .value
                                                            })
                                                        }
                                                        placeholder={
                                                            value.kind ===
                                                            'chat'
                                                                ? t(
                                                                      'web.automations.providerChatId'
                                                                  )
                                                                : t(
                                                                      'web.automations.providerUserId'
                                                                  )
                                                        }
                                                        className='workbench-input h-9 w-full'
                                                    />
                                                </div>
                                            )}
                                    </div>
                                )
                            })
                        )}
                    </div>,
                    document.body
                )}
        </div>
    )
}

const OptionRow: FC<{
    active: boolean
    disabled?: boolean
    label: string
    onClick: () => void
}> = ({ active, disabled = false, label, onClick }): ReactNode => (
    <button
        type='button'
        disabled={disabled}
        onClick={onClick}
        className={[
            'text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors disabled:opacity-40',
            active ? 'bg-soft text-fg' : ''
        ].join(' ')}
    >
        <span className='min-w-0 flex-1 truncate'>{label}</span>
        {active && <CheckIcon className='text-subtle h-3.5 w-3.5 shrink-0' />}
    </button>
)

export default DeliveryPicker

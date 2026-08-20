import type { ChatSessionSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChannelProviderIcon } from '@/lib/channelMeta'
import { useI18n } from '@/lib/i18n'

interface Props {
    x: number
    y: number
    pinned: boolean
    session: ChatSessionSummary
    onClose: () => void
    onRename: () => void
    onRenameChannel?: () => void
    onShare?: () => void
    onTogglePin: () => void
    onDelete: () => void
}

const MENU_WIDTH = 240
const MENU_OFFSET = 4

const SessionContextMenu: FC<Props> = ({
    x,
    y,
    pinned,
    session,
    onClose,
    onRename,
    onRenameChannel,
    onShare,
    onTogglePin,
    onDelete
}): ReactNode => {
    const { t } = useI18n()
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const onDocClick = (e: MouseEvent): void => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node)
            )
                onClose()
        }
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('mousedown', onDocClick)
        window.addEventListener('keydown', onKey)
        window.addEventListener('blur', onClose)
        return () => {
            document.removeEventListener('mousedown', onDocClick)
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('blur', onClose)
        }
    }, [onClose])

    const channel = session.channel
    const chatTitle = session.title ?? t('web.shell.untitledChat')

    const viewportWidth =
        typeof window !== 'undefined' ? window.innerWidth : 0
    const viewportHeight =
        typeof window !== 'undefined' ? window.innerHeight : 0
    const left = Math.min(x + MENU_OFFSET, viewportWidth - MENU_WIDTH - 8)
    const top = Math.min(y + MENU_OFFSET, viewportHeight - 220)

    const menu = (
        <div
            ref={menuRef}
            role='menu'
            aria-label={t('web.shell.sessionMenu')}
            className='popover-panel bg-surface shadow-card border-divider/80 fixed z-[200] overflow-hidden rounded-md border p-1'
            style={{
                left: Math.max(left, 8),
                top: Math.max(top, 8),
                width: MENU_WIDTH
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
            }}
        >
            <div className='border-divider/60 mx-1 mb-1 border-b px-2 pb-1.5 pt-0.5'>
                {channel && (
                    <div className='text-caption text-muted mb-0.5 flex items-center gap-1.5'>
                        <ChannelProviderIcon
                            provider={channel.provider}
                            className='h-3 w-3 shrink-0'
                        />
                        <span className='truncate'>{channel.label}</span>
                    </div>
                )}
                <div className='text-ui text-fg truncate font-medium'>
                    {chatTitle}
                </div>
            </div>

            <MenuItem
                label={t('web.shell.sessionMenuRename')}
                onSelect={() => {
                    onRename()
                    onClose()
                }}
            />
            {channel && onRenameChannel && (
                <MenuItem
                    label={t('web.shell.sessionMenuRenameChannel')}
                    onSelect={() => {
                        onRenameChannel()
                        onClose()
                    }}
                />
            )}
            {onShare && (
                <MenuItem
                    label={t('web.shell.sessionMenuShare')}
                    onSelect={() => {
                        onShare()
                        onClose()
                    }}
                />
            )}
            <MenuItem
                label={
                    pinned
                        ? t('web.shell.sessionMenuUnpin')
                        : t('web.shell.sessionMenuPin')
                }
                onSelect={() => {
                    onTogglePin()
                    onClose()
                }}
            />
            <MenuItem
                label={t('web.shell.sessionMenuDelete')}
                destructive
                onSelect={() => {
                    onDelete()
                    onClose()
                }}
            />
        </div>
    )

    return createPortal(menu, document.body)
}

interface MenuItemProps {
    label: string
    destructive?: boolean
    onSelect: () => void
}

const MenuItem: FC<MenuItemProps> = ({
    label,
    destructive,
    onSelect
}): ReactNode => (
    <button
        type='button'
        role='menuitem'
        className={[
            'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-ui transition-colors',
            destructive
                ? 'text-workflow-ship hover:bg-danger-hover'
                : 'text-muted hover:text-fg hover:bg-soft'
        ].join(' ')}
        onClick={onSelect}
    >
        <span className='truncate'>{label}</span>
    </button>
)

export default SessionContextMenu

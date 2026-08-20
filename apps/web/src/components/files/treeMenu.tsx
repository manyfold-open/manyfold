import type { CSSProperties, FC, ReactNode } from 'react'
import type { ContextMenuOpenContext } from '@pierre/trees'

export const copyTextToClipboard = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
}

export const menuPositionStyle = (
    rect: ContextMenuOpenContext['anchorRect']
): CSSProperties => {
    const left = Math.min(rect.left, window.innerWidth - 216)
    const top = Math.min(rect.bottom + 4, window.innerHeight - 300)
    return {
        left: `${Math.max(8, left)}px`,
        top: `${Math.max(8, top)}px`
    }
}

// The data-file-tree-context-menu-root attribute is how @pierre/trees tells
// menu-internal clicks apart from outside clicks — without it the menu closes
// before the item's onClick fires.
export const TreeContextMenuPanel: FC<{
    anchorRect: ContextMenuOpenContext['anchorRect']
    title: string
    children: ReactNode
}> = ({ anchorRect, title, children }): ReactNode => (
    <div
        role='menu'
        data-file-tree-context-menu-root='true'
        className='popover-panel border-divider/80 bg-surface-elevated shadow-elevated fixed z-[120] w-52 rounded-md border p-1'
        style={menuPositionStyle(anchorRect)}
    >
        <div className='text-caption text-placeholder truncate px-2 py-1 font-medium'>
            {title}
        </div>
        {children}
    </div>
)

export const TreeMenuItem: FC<{
    disabled?: boolean
    icon: ReactNode
    label: string
    onClick: () => void
    tone?: 'default' | 'danger'
}> = ({
    disabled = false,
    icon,
    label,
    onClick,
    tone = 'default'
}): ReactNode => (
    <button
        type='button'
        role='menuitem'
        disabled={disabled}
        className={[
            'text-ui flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
            tone === 'danger'
                ? 'text-workflow-ship hover:bg-danger-bg'
                : 'text-muted hover:text-fg hover:bg-soft'
        ].join(' ')}
        onClick={onClick}
    >
        <span
            className={[
                'shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5',
                tone === 'danger' ? 'text-workflow-ship' : 'text-muted'
            ].join(' ')}
        >
            {icon}
        </span>
        <span className='min-w-0 flex-1 truncate'>{label}</span>
    </button>
)

import type { CSSProperties, FC, ReactNode } from 'react'
import type { ContextMenuOpenContext } from '@pierre/trees'

const menuPositionStyle = (
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
        className='border-border shadow-elevated fixed z-[120] w-52 rounded border bg-white p-1'
        style={menuPositionStyle(anchorRect)}
    >
        <div className='text-caption-sm text-body truncate px-2 py-1'>
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
        className={`text-caption flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
            tone === 'danger'
                ? 'text-accent-ruby hover:bg-accent-ruby/5'
                : 'text-label hover:bg-surface-muted'
        }`}
        onClick={onClick}
    >
        <span className='shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5'>{icon}</span>
        <span className='min-w-0 flex-1 truncate'>{label}</span>
    </button>
)

export const TreeMenuSeparator: FC = (): ReactNode => (
    <div className='bg-border my-1 h-px' />
)

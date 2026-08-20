import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { BoxIcon, CheckIcon, ChevronDownIcon } from '@/components/icons'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { useI18n } from '@/lib/i18n'

interface AgentPickerProps {
    agents: SdkAgent[]
    selectedAgentId: string
    onSelect: (agentId: string) => void
    placement?: 'top' | 'bottom'
    align?: 'start' | 'end'
    placeholder?: string
    disabled?: boolean
}

const AgentPicker: FC<AgentPickerProps> = ({
    agents,
    selectedAgentId,
    onSelect,
    placement = 'bottom',
    align = 'start',
    placeholder,
    disabled = false
}): ReactNode => {
    const { t } = useI18n()
    const resolvedPlaceholder =
        placeholder ?? t('web.automations.agent')
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const menuStyle = useAnchoredMenuPosition(open, rootRef, menuRef, {
        align,
        matchAnchorWidth: false,
        placement
    })

    const selectedAgent =
        agents.find((agent) => agent.id === selectedAgentId) ?? null

    useEffect(() => {
        if (!open) return

        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !rootRef.current?.contains(target) &&
                !menuRef.current?.contains(target)
            ) {
                setOpen(false)
            }
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

    return (
        <div ref={rootRef} className='relative inline-flex min-w-0'>
            <button
                type='button'
                aria-haspopup='menu'
                aria-expanded={open}
                disabled={disabled}
                onClick={() => setOpen((prev) => !prev)}
                className='text-ui text-fg bg-soft hover:bg-surface-hover inline-flex h-10 max-w-full items-center gap-2 rounded-sm px-3.5 font-medium transition-colors disabled:opacity-40'
            >
                <AgentIcon
                    agent={selectedAgent}
                    size={16}
                    className='h-4 w-4 shrink-0'
                />
                <span className='truncate'>
                    {selectedAgent?.name ?? resolvedPlaceholder}
                </span>
                <ChevronDownIcon className='text-subtle h-4 w-4 shrink-0' />
            </button>

            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        role='menu'
                        aria-label={t('web.automations.agent')}
                        className={[
                            'popover-panel shadow-elevated bg-surface-elevated fixed z-[110] max-h-72 w-[min(18rem,calc(100vw-2rem))] overflow-auto overscroll-contain rounded-md p-1 backdrop-blur',
                            menuStyle ? '' : 'invisible'
                        ].join(' ')}
                        style={menuStyle}
                        onWheel={(event) => event.stopPropagation()}
                        onTouchMove={(event) => event.stopPropagation()}
                    >
                        {agents.map((agent) => {
                            const active = agent.id === selectedAgentId
                            return (
                                <button
                                    key={agent.id}
                                    type='button'
                                    role='menuitem'
                                    onClick={() => {
                                        onSelect(agent.id)
                                        setOpen(false)
                                    }}
                                    className={[
                                        'text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors',
                                        active ? 'bg-soft text-fg' : ''
                                    ].join(' ')}
                                >
                                    <AgentIcon
                                        agent={agent}
                                        size={20}
                                        className='h-5 w-5 shrink-0'
                                    />
                                    <span className='min-w-0 flex-1 truncate'>
                                        {agent.name}
                                    </span>
                                    {active && (
                                        <CheckIcon className='text-subtle h-3.5 w-3.5 shrink-0' />
                                    )}
                                </button>
                            )
                        })}
                    </div>,
                    document.body
                )}
        </div>
    )
}

// `size` drives FrameworkLogo (inline style would beat any h-*/w-* class);
// `className` only sizes the BoxIcon fallback.
const AgentIcon: FC<{
    agent: SdkAgent | null
    size: number
    className?: string
}> = ({ agent, size, className }): ReactNode => {
    if (!agent) {
        return (
            <BoxIcon
                className={['text-subtle', className].filter(Boolean).join(' ')}
            />
        )
    }
    return (
        <FrameworkLogo
            framework={agent.framework}
            size={size}
            className='shrink-0'
        />
    )
}

export default AgentPicker

import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { Spinner } from '@/components/Loading'
import { StatusTag } from '@/components/Tag'
import {
    AgentConnectionIcon,
    LogoutIcon,
    SettingsIcon
} from '@/components/icons'
import type { AgentConnection } from '@/hooks/useAgentConnection'
import type { AgentConnectionState } from '@/lib/agentConnection'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { relative } from '@/lib/relativeTime'

const PANEL_WIDTH = 288
const PANEL_GAP = 6
const PANEL_MARGIN = 8

// Same anatomy as the concurrency and credit chips beside it. Not connected
// is the only state that asks for a click, so it alone drops the filled wash
// for a dashed edge; the other two differ in tone and in the live dot.
const chipToneClass: Record<AgentConnectionState, string> = {
    none: 'text-fg outline-dashed outline-1 -outline-offset-1 outline-subtle/60 hover:bg-rail-hover',
    connected: 'shadow-ring-light bg-idle-bg text-muted hover:text-fg',
    'in-use': 'shadow-ring-light bg-info-bg text-info hover:text-info-strong'
}

const panelRowClass = (danger = false): string =>
    [
        'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-ui transition-colors',
        danger
            ? 'text-workflow-ship hover:bg-danger-hover'
            : 'text-muted hover:bg-soft hover:text-fg'
    ].join(' ')

const AgentConnectionChip: FC<{
    connection: AgentConnection
    collapsed: boolean
    onConnect: (trigger: HTMLButtonElement | null) => void
}> = ({ connection, collapsed, onConnect }): ReactNode => {
    const { t } = useI18n()
    const { summary, disconnect } = connection
    const [open, setOpen] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState<{
        left: number
        top?: number
        bottom?: number
    }>({ left: 0, top: 0 })

    // The chip sits at the foot of the rail, so the panel normally opens
    // upward, anchored by its bottom edge; it only drops below when the rail
    // is short enough that there is more room there.
    const updatePos = useCallback((): void => {
        const rect = btnRef.current?.getBoundingClientRect()
        if (!rect) return
        const left = Math.min(
            rect.left,
            window.innerWidth - PANEL_WIDTH - PANEL_MARGIN
        )
        const natural = panelRef.current?.scrollHeight ?? 0
        const above = rect.top - PANEL_GAP - PANEL_MARGIN
        const below = window.innerHeight - rect.bottom - PANEL_GAP - PANEL_MARGIN
        const flip = natural > above && below > above
        setPos({
            left: Math.max(PANEL_MARGIN, left),
            ...(flip
                ? { top: rect.bottom + PANEL_GAP }
                : { bottom: window.innerHeight - rect.top + PANEL_GAP })
        })
    }, [])

    useLayoutEffect(() => {
        if (!open) return
        updatePos()
        const handle = (): void => updatePos()
        window.addEventListener('resize', handle)
        window.addEventListener('scroll', handle, true)
        return () => {
            window.removeEventListener('resize', handle)
            window.removeEventListener('scroll', handle, true)
        }
    }, [open, updatePos, confirming])

    useEffect(() => {
        if (!open) return
        const onDown = (event: MouseEvent): void => {
            const target = event.target as Node
            if (
                !panelRef.current?.contains(target) &&
                !btnRef.current?.contains(target)
            )
                setOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    useEffect(() => {
        if (open) return
        setConfirming(false)
        setError(null)
    }, [open])

    // Disconnecting the last sign-in turns the chip back into "Connect
    // agent", which has no panel to keep open.
    useEffect(() => {
        if (summary?.state === 'none') setOpen(false)
    }, [summary?.state])

    if (!summary) return null

    const { state, signIns, lastUsedAt, firstSignedInAt } = summary
    const count = signIns.length

    const label =
        state === 'none'
            ? t('web.agentConnection.connect')
            : state === 'in-use'
              ? t('web.agentConnection.inUse')
              : t('web.agentConnection.connected')
    const hint =
        state === 'none'
            ? t('web.agentConnection.connectHint')
            : state === 'in-use'
              ? t('web.agentConnection.inUseHint')
              : t('web.agentConnection.connectedHint')

    const handleClick = (): void => {
        if (state === 'none') {
            onConnect(btnRef.current)
            return
        }
        setOpen((value) => !value)
    }

    const handleDisconnect = async (): Promise<void> => {
        setPending(true)
        setError(null)
        try {
            await disconnect()
            setOpen(false)
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setPending(false)
        }
    }

    const panel =
        open && state !== 'none'
            ? createPortal(
                  <div
                      ref={panelRef}
                      role='dialog'
                      aria-label={t('web.agentConnection.panelTitle')}
                      className='popover-panel bg-surface-elevated shadow-elevated fixed z-[200] flex flex-col rounded-md p-1'
                      style={{
                          left: pos.left,
                          top: pos.top,
                          bottom: pos.bottom,
                          width: PANEL_WIDTH
                      }}
                  >
                      <div className='px-2.5 pb-2 pt-1.5'>
                          <div className='flex items-center justify-between gap-2'>
                              <span className='text-ui text-fg font-medium'>
                                  {t('web.agentConnection.panelTitle')}
                              </span>
                              <StatusTag
                                  tone={state === 'in-use' ? 'info' : 'idle'}
                                  label={label}
                              />
                          </div>
                          <div className='text-caption text-muted mt-1'>
                              {lastUsedAt
                                  ? t('web.agentConnection.lastRequest', {
                                        when: relative(lastUsedAt)
                                    })
                                  : t('web.agentConnection.noRequests')}
                          </div>
                          {firstSignedInAt && (
                              <div className='text-caption text-subtle mt-0.5'>
                                  {t('web.agentConnection.signedIn', {
                                      when: relative(firstSignedInAt)
                                  })}
                                  {count > 1 &&
                                      ` · ${t('web.agentConnection.signInCount', { count })}`}
                              </div>
                          )}
                      </div>
                      <div className='border-divider/60 border-t pt-1'>
                          {confirming ? (
                              <div className='bg-soft/60 rounded-sm p-2.5'>
                                  <p className='text-caption text-fg'>
                                      {count > 1
                                          ? t(
                                                'web.agentConnection.disconnectConfirmMany',
                                                { count }
                                            )
                                          : t(
                                                'web.agentConnection.disconnectConfirm'
                                            )}
                                  </p>
                                  {error && (
                                      <p className='text-caption text-error mt-1.5'>
                                          {error}
                                      </p>
                                  )}
                                  <div className='mt-2 flex justify-end gap-2'>
                                      <button
                                          type='button'
                                          onClick={() => setConfirming(false)}
                                          disabled={pending}
                                          className='workbench-button-secondary text-caption h-7 px-2.5'
                                      >
                                          {t('common.cancel')}
                                      </button>
                                      <button
                                          type='button'
                                          onClick={() => {
                                              void handleDisconnect()
                                          }}
                                          disabled={pending}
                                          aria-busy={pending || undefined}
                                          className='workbench-button-danger text-caption h-7 gap-1.5 px-2.5'
                                      >
                                          {pending && <Spinner size={12} />}
                                          {t('web.agentConnection.disconnect')}
                                      </button>
                                  </div>
                              </div>
                          ) : (
                              <>
                                  <button
                                      type='button'
                                      onClick={() => {
                                          setOpen(false)
                                          onConnect(btnRef.current)
                                      }}
                                      className={panelRowClass()}
                                  >
                                      <AgentConnectionIcon className='h-4 w-4 shrink-0' />
                                      {t('web.agentConnection.connectAnother')}
                                  </button>
                                  <Link
                                      to='/settings/api-tokens'
                                      onClick={() => setOpen(false)}
                                      className={panelRowClass()}
                                  >
                                      <SettingsIcon className='h-4 w-4 shrink-0' />
                                      {t('web.agentConnection.manage')}
                                  </Link>
                                  <button
                                      type='button'
                                      onClick={() => setConfirming(true)}
                                      className={panelRowClass(true)}
                                  >
                                      <LogoutIcon className='h-4 w-4 shrink-0' />
                                      {t('web.agentConnection.disconnect')}
                                  </button>
                              </>
                          )}
                      </div>
                  </div>,
                  document.body
              )
            : null

    return (
        <>
            <ShortcutTooltip label={hint} disabled={open} className='shrink-0'>
                <button
                    ref={btnRef}
                    type='button'
                    onClick={handleClick}
                    aria-label={collapsed ? `${label}. ${hint}` : hint}
                    aria-haspopup='dialog'
                    aria-expanded={state === 'none' ? undefined : open}
                    className={[
                        'rounded-pill text-caption relative inline-flex shrink-0 items-center gap-1 font-medium transition-colors',
                        collapsed ? 'h-6 w-6 justify-center' : 'px-2 py-0.5',
                        chipToneClass[state]
                    ].join(' ')}
                >
                    {state === 'in-use' && (
                        <span
                            aria-hidden='true'
                            className={
                                collapsed
                                    ? 'rounded-pill ring-rail absolute -right-px -top-px h-1.5 w-1.5 bg-current ring-2'
                                    : 'rounded-pill h-1.5 w-1.5 shrink-0 bg-current'
                            }
                        />
                    )}
                    <AgentConnectionIcon className='h-3.5 w-3.5 shrink-0' />
                    {!collapsed && label}
                </button>
            </ShortcutTooltip>
            {panel}
        </>
    )
}

export default AgentConnectionChip

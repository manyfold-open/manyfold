import type { SandboxSummary } from '@manyfold/shared'
import type { FC } from 'react'
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import {
    BoxIcon,
    ChevronDownIcon,
    ExternalLinkIcon,
    ZapIcon
} from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { groupActiveSandboxes } from '@/lib/concurrencySlots'
import { activeHoursSeverity, activeHoursStatus } from '@/lib/activeHoursStatus'
import { formatDuration, formatShortDate } from '@/lib/usageFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { BILLING_SURFACE } from '@/edition-capabilities'

const SPRITES_RELEASE_SEC = 35
const PANEL_WIDTH = 300

type Tone = 'success' | 'warning' | 'error'

const chipToneClass: Record<Tone, string> = {
    success: 'bg-success-bg text-success',
    warning: 'bg-warning-bg text-warning',
    error: 'bg-error-bg text-error'
}

const barFillClass: Record<Tone, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error'
}

const textToneClass: Record<Tone, string> = {
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-error'
}

const bannerClass: Record<'low' | 'exhausted', string> = {
    low: 'bg-warning-bg text-warning',
    exhausted: 'bg-error-bg text-error'
}

const hoursToHms = (hours: number): string =>
    hours <= 0 ? '0h' : formatDuration(hours * 3_600_000)

interface Props {
    agents: SdkAgent[]
    sandboxes: SandboxSummary[]
    limit: number | null
    planName?: string | null
    releasingIds?: ReadonlySet<string>
    activeHoursThisPeriod?: number | null
    activeHoursLimit?: number | null
    usagePeriodEnd?: string | null
    onSetKeepAlive?: (runtimeId: string, enabled: boolean) => Promise<void>
}

const ConcurrencyIndicator: FC<Props> = ({
    agents,
    sandboxes,
    limit,
    planName,
    releasingIds,
    activeHoursThisPeriod,
    activeHoursLimit,
    usagePeriodEnd,
    onSetKeepAlive
}) => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const [expandedRuntimeId, setExpandedRuntimeId] = useState<string | null>(
        null
    )
    const [pendingRuntimeId, setPendingRuntimeId] = useState<string | null>(
        null
    )
    const [keepAliveError, setKeepAliveError] = useState<string | null>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState<{ left: number; top: number }>({
        left: 0,
        top: 0
    })

    const updatePos = useCallback((): void => {
        const rect = btnRef.current?.getBoundingClientRect()
        if (typeof window === 'undefined' || !rect) return
        const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)
        setPos({ left: Math.max(8, left), top: rect.bottom + 6 })
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
    }, [open, updatePos])

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
        setExpandedRuntimeId(null)
        setKeepAliveError(null)
    }, [open])

    if (limit == null || limit <= 0) return null

    const releasing = releasingIds ?? new Set<string>()
    const slots = groupActiveSandboxes(agents, sandboxes, releasing)
    const active = slots.length
    const releasingCount = slots.filter((slot) => slot.releasing).length
    const full = active >= limit
    const hours = activeHoursStatus(
        activeHoursThisPeriod ?? null,
        activeHoursLimit ?? null
    )
    const severity = Math.max(
        activeHoursSeverity(hours.status),
        full ? 1 : 0
    ) as 0 | 1 | 2
    const tone: Tone =
        severity === 2 ? 'error' : severity === 1 ? 'warning' : 'success'
    const hasReleasing = releasingCount > 0

    const handleTurnOffKeepAlive = async (runtimeId: string): Promise<void> => {
        if (!onSetKeepAlive || pendingRuntimeId) return
        setPendingRuntimeId(runtimeId)
        setKeepAliveError(null)
        try {
            await onSetKeepAlive(runtimeId, false)
            setExpandedRuntimeId(null)
        } catch (e) {
            setKeepAliveError(apiErrorMessage(e))
        } finally {
            setPendingRuntimeId(null)
        }
    }

    const describe = full
        ? t('web.shell.slotsFull', { sec: SPRITES_RELEASE_SEC })
        : hours.status !== 'unlimited' && hours.remainingHours != null
          ? t('web.shell.slotsTitleWithHours', {
                used: active,
                max: limit,
                hours: hoursToHms(hours.remainingHours)
            })
          : t('web.shell.slotsTitle', { used: active, max: limit })

    const tip = full
        ? t('web.shell.slotsFull', { sec: SPRITES_RELEASE_SEC })
        : t('web.shell.slotsHint')

    const panel = open
        ? createPortal(
              <div
                  ref={panelRef}
                  role='dialog'
                  aria-label={t('web.shell.slotsPanelTitle')}
                  className='popover-panel bg-surface-elevated shadow-elevated fixed z-[200] flex flex-col rounded-md p-1'
                  style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH }}
              >
                  <div className='px-2.5 pb-2 pt-1.5'>
                      <div className='flex items-baseline justify-between gap-2'>
                          <span className='text-ui text-fg font-medium'>
                              {t('web.shell.slotsPanelTitle')}
                          </span>
                          <span
                              className={`text-ui font-mono font-medium tabular-nums ${textToneClass[tone]}`}
                          >
                              {active}/{limit}
                          </span>
                      </div>
                      {planName && (
                          <div className='text-caption text-muted mt-0.5'>
                              {t('web.shell.slotsPlan', { plan: planName })}
                          </div>
                      )}
                      <div className='mt-2 flex gap-[3px]'>
                          {Array.from({ length: limit }).map((_, index) => {
                              const filled = index < active
                              const isReleasingBar =
                                  filled && index >= active - releasingCount
                              return (
                                  <span
                                      key={index}
                                      className={`h-2 flex-1 rounded-[3px] ${filled ? barFillClass[tone] : 'bg-soft'}${isReleasingBar ? 'animate-pulse opacity-60' : ''}`}
                                  />
                              )
                          })}
                      </div>
                  </div>

                  <div className='border-divider/60 max-h-64 overflow-y-auto border-t pt-1'>
                      {slots.length === 0 ? (
                          <div className='text-caption text-muted px-2.5 py-2'>
                              {t('web.shell.slotsNone')}
                          </div>
                      ) : (
                          slots.map((slot) => {
                              const keepAliveRuntimeId =
                                  slot.keepAliveRuntimeIds[0]
                              const hasKeepAlive =
                                  !slot.releasing && !!keepAliveRuntimeId
                              const isExpanded =
                                  hasKeepAlive &&
                                  expandedRuntimeId === keepAliveRuntimeId
                              const keepAliveTagTone =
                                  hours.status === 'low' ||
                                  hours.status === 'exhausted'
                                      ? 'tag-warning'
                                      : 'tag-info'
                              return (
                                  <div
                                      key={slot.key}
                                      className='rounded-sm px-2.5 py-1.5'
                                  >
                                      <div className='flex items-center gap-2'>
                                          <span className='text-ui text-fg min-w-0 flex-1 truncate'>
                                              {slot.name}
                                          </span>
                                          {slot.releasing ? (
                                              <span className='text-caption text-subtle shrink-0'>
                                                  {t('web.shell.slotReleasing')}
                                              </span>
                                          ) : hasKeepAlive ? (
                                              <button
                                                  type='button'
                                                  onClick={() =>
                                                      setExpandedRuntimeId(
                                                          (id) =>
                                                              id ===
                                                              keepAliveRuntimeId
                                                                  ? null
                                                                  : (keepAliveRuntimeId ??
                                                                    null)
                                                      )
                                                  }
                                                  aria-expanded={isExpanded}
                                                  className={`tag ${keepAliveTagTone} shrink-0 transition-opacity hover:opacity-80`}
                                              >
                                                  <ZapIcon className='h-3 w-3' />
                                                  {t('web.shell.keepAliveTag')}
                                                  <ChevronDownIcon
                                                      className={[
                                                          'h-3 w-3 transition-transform',
                                                          isExpanded
                                                              ? ''
                                                              : '-rotate-90'
                                                      ].join(' ')}
                                                  />
                                              </button>
                                          ) : (
                                              <span className='text-caption text-subtle shrink-0'>
                                                  {t('web.shell.slotActive')}
                                              </span>
                                          )}
                                      </div>
                                      {slot.agents.length === 0 ? (
                                          <div className='text-caption text-subtle mt-0.5'>
                                              {t('web.shell.slotNoAgents')}
                                          </div>
                                      ) : (
                                          slot.agents.map((agent) => (
                                              <div
                                                  key={agent.id}
                                                  className='text-caption text-subtle mt-0.5 flex items-center gap-1.5'
                                              >
                                                  <span
                                                      className='inline-flex shrink-0'
                                                      role='img'
                                                      aria-label={frameworkLabel(
                                                          agent.framework
                                                      )}
                                                  >
                                                      <FrameworkLogo
                                                          framework={
                                                              agent.framework
                                                          }
                                                          size={14}
                                                      />
                                                  </span>
                                                  <span className='truncate'>
                                                      {agent.name}
                                                  </span>
                                              </div>
                                          ))
                                      )}
                                      {isExpanded && keepAliveRuntimeId && (
                                          <div className='bg-soft/60 mt-1.5 animate-[keep-alive-panel-rise_0.16s_ease-out] rounded-sm p-2.5'>
                                              <p className='text-caption text-fg'>
                                                  {slot.activeSecondsThisPeriod !=
                                                  null
                                                      ? t(
                                                            'web.shell.keepAliveUsage',
                                                            {
                                                                duration:
                                                                    formatDuration(
                                                                        slot.activeSecondsThisPeriod *
                                                                            1000
                                                                    )
                                                            }
                                                        )
                                                      : t(
                                                            'web.shell.keepAliveDescription'
                                                        )}
                                              </p>
                                              <p className='text-caption text-muted mt-0.5'>
                                                  {t('web.shell.keepAliveHint')}
                                              </p>
                                              <div className='mt-2 flex items-center gap-3'>
                                                  <button
                                                      type='button'
                                                      disabled={
                                                          pendingRuntimeId ===
                                                          keepAliveRuntimeId
                                                      }
                                                      onClick={() =>
                                                          void handleTurnOffKeepAlive(
                                                              keepAliveRuntimeId
                                                          )
                                                      }
                                                      className='bg-surface hover:bg-surface-hover shadow-ring-light text-caption text-fg inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                                                  >
                                                      {pendingRuntimeId ===
                                                          keepAliveRuntimeId && (
                                                          <Spinner size={12} />
                                                      )}
                                                      {pendingRuntimeId ===
                                                      keepAliveRuntimeId
                                                          ? t(
                                                                'web.shell.keepAliveTurningOff'
                                                            )
                                                          : t(
                                                                'web.shell.keepAliveTurnOff'
                                                            )}
                                                  </button>
                                                  <Link
                                                      to={`/settings/runtimes/${keepAliveRuntimeId}`}
                                                      onClick={() =>
                                                          setOpen(false)
                                                      }
                                                      className='text-caption text-muted hover:text-fg inline-flex items-center gap-1 transition-colors'
                                                  >
                                                      {t(
                                                          'web.shell.keepAliveViewRuntime'
                                                      )}
                                                      <ExternalLinkIcon className='h-3 w-3' />
                                                  </Link>
                                              </div>
                                              {keepAliveError && (
                                                  <p className='text-caption text-error mt-1.5'>
                                                      {keepAliveError}
                                                  </p>
                                              )}
                                          </div>
                                      )}
                                  </div>
                              )
                          })
                      )}
                  </div>

                  {full && (
                      <div className='border-divider/60 text-caption text-muted border-t px-2.5 pb-1 pt-2'>
                          {t('web.shell.slotsFull', {
                              sec: SPRITES_RELEASE_SEC
                          })}
                      </div>
                  )}

                  <div className='border-divider/60 mt-1 border-t px-2.5 pb-1.5 pt-2'>
                      <div className='flex items-baseline justify-between gap-2'>
                          <span className='text-ui text-fg font-medium'>
                              {t('web.shell.activeHoursTitle')}
                          </span>
                          {hours.status === 'unlimited' ? (
                              <span className='text-caption text-muted'>
                                  {t('web.shell.activeHoursUnlimited')}
                              </span>
                          ) : (
                              <span className='text-caption font-mono font-medium tabular-nums'>
                                  <span className='text-muted'>
                                      {t('web.shell.activeHoursUsed', {
                                          used: hoursToHms(hours.usedHours),
                                          limit: hoursToHms(
                                              hours.limitHours ?? 0
                                          )
                                      })}
                                  </span>
                                  <span
                                      className={`ml-1 ${
                                          hours.status === 'ok'
                                              ? 'text-muted'
                                              : textToneClass[
                                                    hours.status ===
                                                    'exhausted'
                                                        ? 'error'
                                                        : 'warning'
                                                ]
                                      }`}
                                  >
                                      ·{' '}
                                      {t('web.shell.activeHoursRemaining', {
                                          remaining: hoursToHms(
                                              hours.remainingHours ?? 0
                                          )
                                      })}
                                  </span>
                              </span>
                          )}
                      </div>
                      {hours.status !== 'unlimited' && (
                          <>
                              <div className='bg-soft rounded-pill mt-2 h-1 w-full overflow-hidden'>
                                  <div
                                      className={`rounded-pill h-full ${
                                          hours.status === 'ok'
                                              ? 'bg-success'
                                              : barFillClass[
                                                    hours.status === 'exhausted'
                                                        ? 'error'
                                                        : 'warning'
                                                ]
                                      }`}
                                      style={{
                                          width: `${Math.min(
                                              100,
                                              hours.limitHours
                                                  ? (hours.usedHours /
                                                        hours.limitHours) *
                                                        100
                                                  : 0
                                          )}%`
                                      }}
                                  />
                              </div>
                              {usagePeriodEnd && (
                                  <div className='text-caption text-muted mt-1'>
                                      {t('web.shell.activeHoursResets', {
                                          date: formatShortDate(usagePeriodEnd)
                                      })}
                                  </div>
                              )}
                          </>
                      )}
                      {(hours.status === 'low' ||
                          hours.status === 'exhausted') && (
                          <div
                              className={`text-caption mt-2 rounded-sm px-2 py-1.5 ${bannerClass[hours.status]}`}
                          >
                              {hours.status === 'exhausted'
                                  ? t('web.shell.activeHoursExhaustedWarning')
                                  : t('web.shell.activeHoursLowWarning')}
                              {/* The warning still stands without a plan to
                                  upgrade to; only the call to action goes. */}
                              {BILLING_SURFACE && (
                                  <>
                                      {' '}
                                      <Link
                                          to='/settings/plan-and-billing/pricing'
                                          onClick={() => setOpen(false)}
                                          className='font-medium underline hover:no-underline'
                                      >
                                          {t('web.shell.activeHoursUpgrade')}
                                      </Link>
                                  </>
                              )}
                          </div>
                      )}
                  </div>
              </div>,
              document.body
          )
        : null

    return (
        <>
            <ShortcutTooltip label={tip} disabled={open} className='shrink-0'>
                <button
                    ref={btnRef}
                    type='button'
                    onClick={() => setOpen((value) => !value)}
                    aria-label={describe}
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    className={`shadow-ring-light rounded-pill text-caption inline-flex shrink-0 items-center gap-1 px-2 py-0.5 font-mono font-medium tabular-nums transition-colors ${chipToneClass[tone]}${hasReleasing ? 'animate-pulse' : ''}`}
                >
                    <BoxIcon className='h-3.5 w-3.5' />
                    {active}/{limit}
                </button>
            </ShortcutTooltip>
            {panel}
        </>
    )
}

export default ConcurrencyIndicator

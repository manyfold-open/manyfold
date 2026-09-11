import { Suspense, useEffect, useRef, useState } from 'react'
import type { FC, ReactNode } from 'react'
import type {
    AgentRuntimeSummary,
    RuntimeAccountUsage,
    RuntimeAccountUsageWindow,
    RuntimeAccountView,
    RuntimeAuthListView,
    RuntimeAuthOperationView,
    RuntimeAuthProfileView
} from '@manyfold/shared'
import { Link } from 'react-router-dom'
import { Spinner } from '@/components/Loading'
import OverflowMenu, { type OverflowMenuEntry } from '@/components/OverflowMenu'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ProductDialog from '@/components/ProductDialog'
import { NoticeRow, relative } from '@/components/RuntimeDetailPanel'
import type { TagTone } from '@/components/Tag'
import { CheckIcon, PlusIcon } from '@/components/icons'
import { hostApiKeyEnvFor } from '@/lib/agentCreate/providerSource'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n, type TFn } from '@/lib/i18n'
import { wakeRefusalKind, type WakeRefusal } from '@/lib/wakeRefusal'
import { BILLING_SURFACE } from '@/edition-capabilities'
import { lazyChunk } from '@/lib/lazyChunk'
import {
    credentialTag,
    formatResetsIn,
    hostAccountHeadline,
    hostAccountSubline,
    signInNeeded,
    usageTone,
    usageWindowLabelKey
} from '@/lib/runtimeAccount'
import {
    profileBindable,
    profileDisplayName,
    profileNeedsSignIn,
    profileStatusTag,
    profileSubline
} from '@/lib/runtimeAuth'
import { updatesPath } from '@/lib/updateCenter'
import { formatDuration } from '@/lib/usageFormat'

const RuntimeSignInTerminal = lazyChunk(
    () => import('@/components/RuntimeSignInTerminal')
)

// The account's login/logout/remove all run as operations the host journals;
// the API settles the ones this surface started when the shell closes, but
// that settlement races the surface's own reload, so wait for it to leave
// the running states before reading the list back.
// Measured on a local daemon [2026-09-09]: the post-close reconcile takes one
// auth.operation + one auth.inspect round trip, well under a second.
const SETTLE_POLL_MS = 500
const SETTLE_POLL_LIMIT = 20

const operationSettled = (op: RuntimeAuthOperationView): boolean =>
    op.status !== 'pending' && op.status !== 'running'

// Literal class names on purpose: Tailwind only emits utilities it can see
// verbatim in the source (the Tag.tsx precedent).
const BAR_TONE: Record<TagTone, string> = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    idle: 'bg-idle'
}

// The create form's runtime-card status: a dot and quiet text, no pill.
const AccountStatus: FC<{ tone: TagTone; label: string }> = ({
    tone,
    label
}): ReactNode => (
    <span className='text-subtle text-caption inline-flex shrink-0 items-center gap-1.5'>
        <span
            className={[
                'h-1.5 w-1.5 shrink-0 rounded-full',
                BAR_TONE[tone]
            ].join(' ')}
        />
        {label}
    </span>
)

// One line under the bars explaining why usage is thin or absent. Silent
// when the usage simply loaded.
const usageNote = (
    view: RuntimeAccountView,
    usage: RuntimeAccountUsage | null,
    t: TFn
): string | null => {
    const error = usage?.error
    if (error) {
        if (error.kind === 'stale-token')
            return t('web.runtimeDetails.account.usageStale')
        if (error.kind === 'unauthorized')
            return t('web.runtimeDetails.account.usageUnauthorized')
        if (error.kind === 'rate-limited')
            return t('web.runtimeDetails.account.usageRateLimited', {
                time: error.retryAfterSeconds
                    ? formatDuration(error.retryAfterSeconds * 1000)
                    : '—'
            })
        if (error.kind === 'network')
            return t('web.runtimeDetails.account.usageNetwork')
        return error.message
            ? `${t('web.runtimeDetails.account.usageUnexpected')} (${error.message})`
            : t('web.runtimeDetails.account.usageUnexpected')
    }
    if (usage) return null
    if (view.tokenSource === 'keychain-unread')
        return t('web.runtimeDetails.account.keychainUnread')
    if (
        view.credentialStatus === 'valid' &&
        (view.credentialReason === 'api-key' ||
            view.credentialReason === 'env-token')
    )
        return t('web.runtimeDetails.account.usageApiKey')
    return null
}

// The list's parts, for a surface that lays them out itself (the create
// form's provider section puts the cards in one grid beside the saved
// providers and the add chips in one row beside "Add model provider").
export interface AccountListParts {
    cards: ReactNode
    // Runner / upgrade / list-error lines that belong under the cards.
    notices: ReactNode
    // The dashed add chips, without a wrapper.
    actions: ReactNode
    // The inline API-key form when it is open.
    extra: ReactNode
}

// What the terminal dialog is signing in: the host's own CLI login (no
// operation to read back; the host is re-probed on close) or a profile's
// login operation.
interface SignInTarget {
    operationId?: string
    profileId?: string
    title: string
    description: string
}

interface AccountSelection {
    // '' = the host sign-in (the inherited binding).
    profileId: string
    // Whether this list is the picked source at all; rows only show a check
    // when it is.
    active: boolean
    onSelect: (profileId: string) => void
}

// The create form's runtime-target card, for an account, kept to two lines:
// the name and its status (and, in a picker, the check); under them one grey
// line of context and the account's own controls pinned to the bottom-right.
// In a picker the WHOLE card is the pick target — a transparent button under
// the content, which lets clicks through except at the controls — so nothing
// interactive nests and the hit area matches the runtime cards.
const accountCardClass = (
    selected: boolean,
    disabled: boolean,
    pickable: boolean
): string =>
    [
        'shadow-ring-light relative flex w-full flex-col rounded-md px-3.5 py-3 text-left transition-[color,background-color,box-shadow]',
        disabled
            ? 'bg-surface text-muted opacity-55'
            : selected
              ? 'bg-info-bg text-fg ring-link/40 ring-2'
              : pickable
                ? 'bg-surface text-muted hover:bg-surface-hover hover:text-fg'
                : 'bg-surface text-fg'
    ].join(' ')

const AccountCard: FC<{
    // The framework mark, boxed like a provider card's brand mark.
    lead?: ReactNode
    headline: string
    copy: string | null
    status: ReactNode
    controls?: ReactNode
    children?: ReactNode
    pick?: { selected: boolean; disabled: boolean; onSelect: () => void }
}> = ({
    lead,
    headline,
    copy,
    status,
    controls,
    children,
    pick
}): ReactNode => (
    <div
        className={accountCardClass(
            pick?.selected ?? false,
            pick?.disabled ?? false,
            pick !== undefined
        )}
    >
        {pick && (
            <button
                type='button'
                aria-label={headline}
                aria-pressed={pick.selected}
                disabled={pick.disabled}
                onClick={pick.onSelect}
                className='focus-visible:shadow-focus absolute inset-0 rounded-md transition-[box-shadow] focus:outline-none disabled:cursor-not-allowed'
            />
        )}
        <div
            className={[
                'relative flex min-h-0 flex-1 gap-2.5',
                pick ? 'pointer-events-none' : ''
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {lead && (
                <span className='shadow-ring-light bg-surface flex h-7 w-7 shrink-0 items-center justify-center rounded-sm'>
                    {lead}
                </span>
            )}
            <div className='flex min-w-0 flex-1 flex-col'>
                <div className='flex items-center justify-between gap-2'>
                    <span className='text-fg text-ui min-w-0 flex-1 truncate font-medium'>
                        {headline}
                    </span>
                    <span className='flex shrink-0 items-center gap-2'>
                        {status}
                        {pick?.selected && (
                            <CheckIcon className='text-link h-4 w-4 shrink-0' />
                        )}
                    </span>
                </div>
                {copy && (
                    <div className='text-caption text-muted mt-1 truncate'>
                        {copy}
                    </div>
                )}
                {children}
                {controls && (
                    <div className='pointer-events-none mt-auto flex items-center justify-end gap-2 pt-1.5 [&>*]:pointer-events-auto'>
                        {controls}
                    </div>
                )}
            </div>
        </div>
    </div>
)

// The account's own sign-in, as a quiet link so the card stays two lines.
const SignInLink: FC<{ busy?: boolean; onClick: () => void }> = ({
    busy = false,
    onClick
}): ReactNode => {
    const { t } = useI18n()
    return (
        <button
            type='button'
            className='text-caption text-link hover:text-fg disabled:text-muted inline-flex items-center gap-1 font-medium disabled:cursor-not-allowed'
            disabled={busy}
            onClick={onClick}
        >
            {busy && <Spinner size={12} />}
            {t('web.runtimeDetails.account.signIn')}
        </button>
    )
}

// The host account's usage windows, one per line: in a half-width card two
// abreast truncates every label.
const UsageWindows: FC<{
    windows: RuntimeAccountUsageWindow[]
    note: string | null
    // When the vendor last answered; the kept answer can be minutes old.
    fetchedAt: string | null
}> = ({ windows, note, fetchedAt }): ReactNode => {
    const { t } = useI18n()
    const now = Date.now()
    return (
        <div className='mt-2'>
            {windows.length > 0 && (
                <div className='grid gap-y-1.5'>
                    {windows.map((window) => {
                        const labelKey = usageWindowLabelKey(window.key)
                        const label = [
                            labelKey ? t(labelKey) : window.key,
                            window.scope
                        ]
                            .filter((part): part is string => Boolean(part))
                            .join(' · ')
                        const resetsIn = formatResetsIn(window.resetsAt, now)
                        return (
                            <div
                                key={`${window.key}:${window.scope ?? ''}`}
                                className='min-w-0'
                            >
                                <div className='text-caption flex items-baseline justify-between gap-3'>
                                    <span className='text-muted truncate'>
                                        {label}
                                    </span>
                                    <span className='text-muted shrink-0 tabular-nums'>
                                        {`${window.usedPercent}%`}
                                        {resetsIn && (
                                            <span className='text-subtle'>
                                                {' · '}
                                                {t(
                                                    'web.runtimeDetails.account.resetsIn',
                                                    { time: resetsIn }
                                                )}
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div
                                    role='progressbar'
                                    aria-label={label}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={window.usedPercent}
                                    className='bg-surface-subtle rounded-pill mt-1 h-1 w-full overflow-hidden'
                                >
                                    <div
                                        className={[
                                            'rounded-pill h-full',
                                            BAR_TONE[
                                                usageTone(window.usedPercent)
                                            ]
                                        ].join(' ')}
                                        style={{
                                            width: `${window.usedPercent}%`
                                        }}
                                    />
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
            {note && (
                <p
                    className={[
                        'text-caption text-muted',
                        windows.length > 0 ? 'mt-2' : ''
                    ].join(' ')}
                >
                    {note}
                </p>
            )}
            {fetchedAt && (
                <p className='text-caption text-subtle mt-1'>
                    {t('web.runtimeDetails.checked', {
                        time: relative(fetchedAt)
                    })}
                </p>
            )}
        </div>
    )
}

// The create form's dashed "add" chip.
export const AddChip: FC<{
    label: string
    busy?: boolean
    disabled?: boolean
    pressed?: boolean
    onClick: () => void
}> = ({
    label,
    busy = false,
    disabled = false,
    pressed,
    onClick
}): ReactNode => (
    <button
        type='button'
        aria-pressed={pressed}
        className='text-caption text-muted hover:text-fg hover:bg-surface-hover border-divider inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-55'
        disabled={disabled || busy}
        onClick={onClick}
    >
        {busy ? (
            <Spinner size={12} />
        ) : (
            <PlusIcon className='h-3.5 w-3.5 shrink-0' />
        )}
        {label}
    </button>
)

// Every account a runtime's CLI can run under, as the create form's runtime
// cards, two to a line: the host sign-in first (who the machine itself is
// signed in as), then the accounts added on the runtime, then the dashed
// chips that add one. The runtime page and the create
// form's Local group render this same component — the rows, the sign-in
// shell, the account menu and the API-key form are identical on both; the
// create form only adds the pick.
export const RuntimeAccountList: FC<{
    runtime: Pick<AgentRuntimeSummary, 'id' | 'kind' | 'hostId' | 'framework'>
    list: RuntimeAuthListView
    loading: boolean
    reload: (opts?: { wake?: boolean }) => Promise<RuntimeAuthListView | null>
    // The surface's own host probe when it has a fresher one than the list's
    // ambient row (the runtime page reads the host directly and keeps its
    // usage); the list's row is the fallback.
    host?: RuntimeAccountView | null
    usage?: RuntimeAccountUsage | null
    // Runs after the host's own sign-in shell closes, on top of the reload.
    onHostSignedIn?: () => void
    // Re-reads usage from the vendor (the host card's menu); only the surface
    // that shows usage offers it.
    onRefreshUsage?: () => void
    selection?: AccountSelection
    // The runtime's framework mark on every card. The create form shows it,
    // where the cards sit beside provider cards with brand marks; the runtime
    // page, already headed by the framework, leaves it out.
    lead?: ReactNode
    // Lay the parts out instead of the default card grid + footer.
    layout?: (parts: AccountListParts) => ReactNode
    // The surface asked the API to start this runtime's runner already; while
    // that is in flight the asleep row reads as progress, not as a button.
    prewarming?: boolean
    // A token for "add an account as soon as you can": the create form sets
    // it after preparing a bare sandbox's runtime for exactly that, so the
    // user's one click carries through to the sign-in. Runs once per value.
    autoAdd?: string | null
    // The surface's wake was refused by the plan (its hours used up, or the
    // wake failed): the runner line says why instead of offering a start.
    wakeRefusal?: WakeRefusal | null
    onRetryWake?: () => void
}> = ({
    runtime,
    list,
    loading,
    reload,
    host: hostProbe = null,
    usage = null,
    onHostSignedIn,
    onRefreshUsage,
    selection,
    lead,
    layout,
    prewarming = false,
    autoAdd = null,
    wakeRefusal = null,
    onRetryWake
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [error, setError] = useState<string | null>(null)
    const [signIn, setSignIn] = useState<SignInTarget | null>(null)
    const [busyProfile, setBusyProfile] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const [enablingTerminal, setEnablingTerminal] = useState(false)
    const [keyFormOpen, setKeyFormOpen] = useState(false)
    const [keyLabel, setKeyLabel] = useState('')
    const [keyValue, setKeyValue] = useState('')
    const [savingKey, setSavingKey] = useState(false)

    const host =
        hostProbe && hostProbe.status === 'ok'
            ? hostProbe
            : list.availability === 'ok' && list.ambient?.status === 'ok'
              ? list.ambient
              : null
    const pickable = selection !== undefined
    const selected = (id: string): boolean =>
        pickable && selection.active && selection.profileId === id

    const settleOperation = async (
        operationId: string
    ): Promise<RuntimeAuthOperationView | null> => {
        let last: RuntimeAuthOperationView | null = null
        for (let i = 0; i < SETTLE_POLL_LIMIT; i += 1) {
            try {
                last = await client.runtimeAuth.operation(operationId)
            } catch (e) {
                setError(apiErrorMessage(e))
                return null
            }
            if (operationSettled(last)) return last
            await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
        }
        return last
    }

    const reportFailure = (op: RuntimeAuthOperationView | null): void => {
        if (!op || op.status !== 'failed') return
        setError(
            t('web.runtimeAuth.signInFailed', {
                reason: op.error ?? op.resultCode ?? op.status
            })
        )
    }

    const startProfileSignIn = async (
        profileId: string,
        title: string
    ): Promise<void> => {
        setBusyProfile(profileId)
        setError(null)
        try {
            const op = await client.runtimeAuth.login(runtime.id, profileId, {
                wake: true
            })
            setSignIn({
                operationId: op.id,
                profileId,
                title,
                description: t('web.runtimeAuth.signInBody')
            })
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
        }
    }

    const handleAdd = async (): Promise<void> => {
        setAdding(true)
        setError(null)
        try {
            const profile = await client.runtimeAuth.create(runtime.id, {
                authMethod: 'subscription',
                wake: true
            })
            await reload()
            await startProfileSignIn(
                profile.id,
                t('web.runtimeAuth.addAccount')
            )
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setAdding(false)
        }
    }

    const autoAddedRef = useRef<string | null>(null)
    useEffect(() => {
        if (!autoAdd || autoAddedRef.current === autoAdd) return
        autoAddedRef.current = autoAdd
        void handleAdd()
        // handleAdd closes over the client and runtime id, both stable for the
        // life of this list; the token is the only trigger.
    }, [autoAdd])

    // The host's own sign-in runs in a shell on the runtime; a sandbox whose
    // terminal is off needs the user's consent to turn it on first.
    const handleHostSignIn = async (
        view: RuntimeAccountView
    ): Promise<void> => {
        if (
            runtime.kind === 'sprites' &&
            runtime.hostId &&
            view.host &&
            !view.host.terminalEnabled
        ) {
            if (
                !(await confirm({
                    title: t('web.terminal.enablePromptTitle'),
                    description: t('web.terminal.enablePromptBody'),
                    confirmLabel: t('web.terminal.enablePromptConfirm')
                }))
            )
                return
            setEnablingTerminal(true)
            setError(null)
            try {
                await client.sandboxes.setTerminal(runtime.hostId, true)
            } catch (e) {
                setError(apiErrorMessage(e))
                return
            } finally {
                setEnablingTerminal(false)
            }
        }
        setSignIn({
            title: t('web.runtimeDetails.account.signIn'),
            description: t('web.runtimeDetails.account.signInBody')
        })
    }

    // Closing the terminal is the only signal that the sign-in ended; the
    // operation row says whether it succeeded, and the refetched list says
    // whether the account is one an agent can be pointed at. The host's own
    // login has no operation: re-read the host the shell just kept awake.
    const handleSignInDone = async (): Promise<void> => {
        const pending = signIn
        setSignIn(null)
        if (!pending) return
        if (!pending.operationId) {
            await reload({ wake: true })
            onHostSignedIn?.()
            return
        }
        reportFailure(await settleOperation(pending.operationId))
        const next = await reload()
        const profile = next?.profiles.find((p) => p.id === pending.profileId)
        if (profile && profileBindable(profile)) selection?.onSelect(profile.id)
    }

    const handleSignOut = async (
        profile: RuntimeAuthProfileView
    ): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.runtimeAuth.signOutConfirmTitle', {
                    account: profileDisplayName(profile)
                }),
                description: t('web.runtimeAuth.signOutConfirmBody'),
                confirmLabel: t('web.runtimeAuth.signOut')
            }))
        )
            return
        setBusyProfile(profile.id)
        setError(null)
        try {
            const op = await client.runtimeAuth.logout(runtime.id, profile.id, {
                wake: true
            })
            if (!operationSettled(op)) await settleOperation(op.id)
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
            await reload()
        }
    }

    const handleRemove = async (
        profile: RuntimeAuthProfileView
    ): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.runtimeAuth.removeConfirmTitle', {
                    account: profileDisplayName(profile)
                }),
                description: t('web.runtimeAuth.removeConfirmBody'),
                confirmLabel: t('web.runtimeAuth.remove'),
                tone: 'danger'
            }))
        )
            return
        setBusyProfile(profile.id)
        setError(null)
        try {
            const op = await client.runtimeAuth.remove(runtime.id, profile.id, {
                wake: true
            })
            if (!operationSettled(op)) await settleOperation(op.id)
            // A removed row cannot stay picked.
            if (selection?.profileId === profile.id) selection.onSelect('')
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
            await reload()
        }
    }

    const handleSetDefault = async (
        profileId: string | null
    ): Promise<void> => {
        setBusyProfile(profileId ?? list.defaultProfileId)
        setError(null)
        try {
            await client.runtimeAuth.setDefault(runtime.id, { profileId })
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
            await reload()
        }
    }

    // The key goes to the API once and on to the runtime; the row that comes
    // back is complete, so a picker takes it straight away. Not a <form>: the
    // create form wraps this list, and nested forms collapse into the outer
    // one, which would submit the agent instead of the key.
    const handleSaveKey = async (): Promise<void> => {
        if (savingKey || keyValue.trim().length < 10) return
        setSavingKey(true)
        setError(null)
        try {
            const profile = await client.runtimeAuth.create(runtime.id, {
                authMethod: 'api-key',
                apiKey: keyValue.trim(),
                label: keyLabel.trim() || undefined,
                wake: true
            })
            setKeyValue('')
            setKeyLabel('')
            setKeyFormOpen(false)
            await reload()
            selection?.onSelect(profile.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSavingKey(false)
        }
    }

    const pickFor = (
        id: string,
        disabled = false
    ):
        | { selected: boolean; disabled: boolean; onSelect: () => void }
        | undefined =>
        pickable
            ? {
                  selected: selected(id),
                  disabled,
                  onSelect: () => selection.onSelect(id)
              }
            : undefined

    // The host sign-in card: who the machine is signed in as and the probe's
    // verdict, with the sign-in as the card's control when one is needed; the
    // runtime page's usage sits under it. A host that cannot be read right
    // now keeps the generic title and one quiet tag.
    const hostCard = (): ReactNode => {
        if (!host) {
            const tag =
                list.availability === 'daemon-offline'
                    ? t('web.tags.status.offline')
                    : t('web.runtimeDetails.account.unknownStatus')
            return (
                <AccountCard
                    lead={lead}
                    headline={t('web.runtimeAuth.hostSignIn')}
                    copy={null}
                    status={<AccountStatus tone='idle' label={tag} />}
                    pick={pickFor('')}
                />
            )
        }
        const tag = credentialTag(host, t)
        const note = usageNote(host, usage, t)
        const windows = usage?.windows ?? []
        return (
            <AccountCard
                lead={lead}
                headline={hostAccountHeadline(host, t)}
                copy={hostAccountSubline(host, t)}
                status={<AccountStatus tone={tag.tone} label={tag.label} />}
                controls={
                    (signInNeeded(host) && !signIn) || onRefreshUsage ? (
                        <>
                            {signInNeeded(host) && !signIn && (
                                <SignInLink
                                    busy={enablingTerminal}
                                    onClick={(): void => {
                                        void handleHostSignIn(host)
                                    }}
                                />
                            )}
                            {onRefreshUsage && (
                                <OverflowMenu
                                    ariaLabel={`${hostAccountHeadline(host, t)} · ${t('common.moreActions')}`}
                                    compact
                                    items={[
                                        {
                                            label: t(
                                                'web.runtimeDetails.account.refreshUsage'
                                            ),
                                            onSelect: onRefreshUsage
                                        }
                                    ]}
                                />
                            )}
                        </>
                    ) : undefined
                }
                pick={pickFor('')}
            >
                {(windows.length > 0 || note) && (
                    <UsageWindows
                        windows={windows}
                        note={note}
                        fetchedAt={usage?.fetchedAt ?? null}
                    />
                )}
            </AccountCard>
        )
    }

    const profileCard = (profile: RuntimeAuthProfileView): ReactNode => {
        const tag = profileStatusTag(profile, t)
        const headline = profileDisplayName(profile)
        const busy = busyProfile === profile.id
        const removable = profile.lifecycle !== 'deleting'
        // A stored key has no interactive sign-in (a new key is a new row); an
        // account that needs one gets the button on the row, so the menu only
        // offers a fresh sign-in for an account that is already in.
        const canSignIn =
            profile.authMethod !== 'api-key' &&
            removable &&
            list.capabilities.manage
        const signInOnRow = canSignIn && profileNeedsSignIn(profile)
        const items: OverflowMenuEntry[] = [
            ...(canSignIn && !signInOnRow
                ? [
                      {
                          label: t('web.runtimeDetails.account.signIn'),
                          onSelect: (): void => {
                              void startProfileSignIn(
                                  profile.id,
                                  t('web.runtimeDetails.account.signIn')
                              )
                          },
                          disabled: busy
                      }
                  ]
                : []),
            profile.isDefault
                ? {
                      label: t('web.runtimeAuth.clearDefault'),
                      onSelect: (): void => {
                          void handleSetDefault(null)
                      },
                      disabled: busy
                  }
                : {
                      label: t('web.runtimeAuth.makeDefault'),
                      onSelect: (): void => {
                          void handleSetDefault(profile.id)
                      },
                      disabled: busy || !removable
                  },
            { separator: true },
            {
                label: t('web.runtimeAuth.signOut'),
                onSelect: (): void => {
                    void handleSignOut(profile)
                },
                disabled: busy || !removable || profileNeedsSignIn(profile)
            },
            {
                label: t('web.runtimeAuth.remove'),
                onSelect: (): void => {
                    void handleRemove(profile)
                },
                danger: true,
                disabled: busy || !removable || profile.agentCount > 0,
                disabledReason:
                    profile.agentCount > 0
                        ? t('web.runtimeAuth.removeBlocked', {
                              count: profile.agentCount
                          })
                        : undefined
            }
        ]
        return (
            <AccountCard
                key={profile.id}
                lead={lead}
                headline={headline}
                copy={profileSubline(profile, t)}
                status={<AccountStatus tone={tag.tone} label={tag.label} />}
                controls={
                    signInOnRow || list.capabilities.manage ? (
                        <>
                            {signInOnRow && (
                                <SignInLink
                                    busy={busy}
                                    onClick={(): void => {
                                        void startProfileSignIn(
                                            profile.id,
                                            t(
                                                'web.runtimeDetails.account.signIn'
                                            )
                                        )
                                    }}
                                />
                            )}
                            {list.capabilities.manage &&
                                (busy && !signInOnRow ? (
                                    <Spinner size={12} />
                                ) : (
                                    <OverflowMenu
                                        ariaLabel={`${headline} · ${t('common.moreActions')}`}
                                        compact
                                        items={items}
                                    />
                                ))}
                        </>
                    ) : undefined
                }
                pick={pickFor(
                    profile.id,
                    !profileBindable(profile) || !list.capabilities.execute
                )}
            />
        )
    }

    const wakeButton = (label: string): ReactNode => (
        <button
            type='button'
            className='workbench-button-secondary'
            disabled={loading}
            onClick={(): void => {
                void reload({ wake: true })
            }}
        >
            {loading && <Spinner size={12} />}
            {label}
        </button>
    )

    const updatesLink = (
        <Link
            to={updatesPath('cli')}
            className='text-link hover:text-fg font-medium'
        >
            {t('web.updates.reviewCta')}
        </Link>
    )

    // What the runtime's runner can do right now, as one notice under the
    // cards. A sprite's runner answers only while the VM is awake, so
    // starting it is the user's click — that click spends running time.
    const runnerNotice = (): ReactNode => {
        if (
            list.availability === 'host-unavailable' ||
            list.availability === 'sandbox-asleep'
        ) {
            // While the surface is starting the runner itself, that progress
            // is the surface's to show (the create form puts it on its
            // button); no second line here says the same thing.
            if (prewarming) return null
            // The surface asked and was refused: the plan's active hours are
            // used up (nothing wakes until they reset — the plan is the way
            // out), or the wake failed. Said plainly, with the one action
            // that applies; never a start button that would fail the same.
            if (wakeRefusal) {
                const kind = wakeRefusalKind(wakeRefusal.code)
                return (
                    <NoticeRow
                        tone='danger'
                        title={
                            kind === 'hours'
                                ? t('web.shell.activeHoursExhaustedWarning')
                                : wakeRefusal.message
                        }
                        action={
                            kind === 'hours' ? (
                                // The plan is the way out only where one is
                                // sold; the self-hosted edition just states
                                // the limit.
                                BILLING_SURFACE ? (
                                    <Link
                                        to='/settings/plan-and-billing/pricing'
                                        className='workbench-button-secondary'
                                    >
                                        {t('web.shell.activeHoursUpgrade')}
                                    </Link>
                                ) : undefined
                            ) : onRetryWake ? (
                                <button
                                    type='button'
                                    className='workbench-button-secondary'
                                    onClick={onRetryWake}
                                >
                                    {t('common.retry')}
                                </button>
                            ) : undefined
                        }
                    />
                )
            }
            return (
                <NoticeRow
                    title={
                        list.availability === 'host-unavailable'
                            ? t('web.runtimeAuth.hostUnavailable')
                            : t('web.runtimeAuth.runnerAsleep')
                    }
                    action={
                        list.kind === 'sprites'
                            ? wakeButton(t('web.runtimeAuth.startRunner'))
                            : undefined
                    }
                />
            )
        }
        if (list.availability === 'sandbox-limit')
            return (
                <NoticeRow
                    title={t('web.runtimeDetails.account.sandboxLimit')}
                    action={wakeButton(t('web.runtimeAuth.checkAgain'))}
                />
            )
        if (list.availability === 'daemon-offline')
            return (
                <NoticeRow
                    tone='danger'
                    title={t('web.runtimeDetails.account.daemonOffline')}
                />
            )
        if (list.availability === 'daemon-upgrade-required')
            return (
                <NoticeRow
                    title={t('web.runtimeAuth.upgradeRequired')}
                    action={
                        <Link
                            to={updatesPath('cli')}
                            className='workbench-button-secondary'
                        >
                            {t('web.updates.reviewCta')}
                        </Link>
                    }
                />
            )
        return null
    }

    const listed = list.availability === 'ok'
    const profiles = listed
        ? list.profiles.filter((profile) => profile.lifecycle !== 'deleted')
        : []
    const parts: AccountListParts = {
        cards: (
            <>
                {hostCard()}
                {profiles.map(profileCard)}
            </>
        ),
        notices: (
            <>
                {runnerNotice()}
                {listed && list.error && (
                    <p className='text-caption text-error'>
                        {t('web.runtimeAuth.listFailed')} ({list.error})
                    </p>
                )}
                {listed &&
                    profiles.length > 0 &&
                    !list.capabilities.execute && (
                        <p className='text-caption text-muted'>
                            {t('web.runtimeAuth.executeUnsupported')}{' '}
                            {updatesLink}
                        </p>
                    )}
            </>
        ),
        actions: listed ? (
            // A runner without the api-key capability has no key chip and no
            // nag: the capability ships with the mf release that carries it,
            // so "update" would name nothing to update to.
            <>
                <AddChip
                    label={t('web.runtimeAuth.addAccount')}
                    busy={adding}
                    disabled={!list.capabilities.manage}
                    onClick={(): void => {
                        void handleAdd()
                    }}
                />
                {list.capabilities.apiKey && (
                    <AddChip
                        label={t('web.runtimeAuth.addApiKey')}
                        disabled={!list.capabilities.manage}
                        pressed={keyFormOpen}
                        onClick={(): void => setKeyFormOpen((open) => !open)}
                    />
                )}
            </>
        ) : null,
        extra:
            listed && keyFormOpen && list.capabilities.apiKey ? (
                <div
                    role='group'
                    aria-label={t('web.agentNew.runtimeApiKeyTitle')}
                    className='shadow-ring-light bg-soft space-y-3 rounded-md p-4'
                >
                    <div>
                        <span className='workbench-field-label'>
                            {t('web.agentNew.runtimeApiKeyTitle')}
                        </span>
                        <p className='workbench-hint'>
                            {t('web.agentNew.runtimeApiKeyHint')}
                        </p>
                    </div>
                    <div className='grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]'>
                        <input
                            type='text'
                            maxLength={80}
                            value={keyLabel}
                            onChange={(e) => setKeyLabel(e.target.value)}
                            placeholder={t(
                                'web.agentNew.runtimeApiKeyLabelPlaceholder'
                            )}
                            className='workbench-input'
                        />
                        <input
                            type='password'
                            autoComplete='off'
                            autoFocus
                            minLength={10}
                            maxLength={4096}
                            value={keyValue}
                            onChange={(e) => setKeyValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter') return
                                e.preventDefault()
                                void handleSaveKey()
                            }}
                            placeholder={hostApiKeyEnvFor(runtime.framework)}
                            className='workbench-input font-mono'
                        />
                        <button
                            type='button'
                            disabled={savingKey || keyValue.trim().length < 10}
                            aria-busy={savingKey}
                            onClick={(): void => {
                                void handleSaveKey()
                            }}
                            className='workbench-button-secondary h-9 shrink-0'
                        >
                            {savingKey && <Spinner size={12} />}
                            {t('web.agentNew.runtimeApiKeySave')}
                        </button>
                    </div>
                </div>
            ) : null
    }
    return (
        <>
            {layout ? (
                layout(parts)
            ) : (
                <div className='space-y-2'>
                    <div className='grid gap-2 sm:grid-cols-2'>
                        {parts.cards}
                    </div>
                    {parts.notices}
                    {parts.actions && (
                        <div className='flex flex-wrap gap-2'>
                            {parts.actions}
                        </div>
                    )}
                    {parts.extra}
                </div>
            )}
            {error && <p className='workbench-alert-error'>{error}</p>}
            {confirmDialog}
            {signIn && (
                <ProductDialog
                    size='lg'
                    title={signIn.title}
                    description={signIn.description}
                    closeOnBackdrop={false}
                    onClose={(): void => {
                        void handleSignInDone()
                    }}
                >
                    <Suspense
                        fallback={
                            <div className='flex h-72 items-center justify-center'>
                                <Spinner />
                            </div>
                        }
                    >
                        <RuntimeSignInTerminal
                            runtimeId={runtime.id}
                            framework={runtime.framework}
                            operationId={signIn.operationId}
                            onDone={(): void => {
                                void handleSignInDone()
                            }}
                        />
                    </Suspense>
                </ProductDialog>
            )}
        </>
    )
}

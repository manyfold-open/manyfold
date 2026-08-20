import type {
    AccountProfileSummary,
    AuthIdentityProvider,
    AuthIdentitySummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore
} from 'react'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import {
    analyticsConsent,
    setAnalyticsConsent,
    subscribeAnalyticsConsent
} from '@/lib/analyticsConsent'
import { analyticsConfigured } from '@/lib/googleAnalytics'
import { useI18n, type TFn } from '@/lib/i18n'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { ChangeEmailDialog } from '@/components/ChangeEmailDialog'
import { NetmindSignInDialog } from '@/components/NetmindSignInDialog'
import { SetPasswordDialog } from '@/components/SetPasswordDialog'
import {
    CameraIcon,
    CheckIcon,
    CloseIcon,
    EditIcon,
    ShieldAlertIcon,
    TrashIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { Spinner } from '@/components/Loading'
import { useAppAuth } from '@/lib/auth'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useNetmindConfigured } from '@/lib/netmindAuth/config'
import { patchCachedCurrentUser, useCurrentUser } from '@/lib/useCurrentUser'
import { ProviderLogo } from '@/lib/brandMarks'

const providerLabel = (provider: AuthIdentityProvider, t: TFn): string => {
    switch (provider) {
        case 'email':
            return t('web.account.providerEmailPassword')
        case 'google':
            return t('web.account.providerGoogle')
        case 'oidc':
            return t('web.account.providerSso')
        case 'netmind':
            return t('web.account.providerNetmind')
    }
}

const disconnectDescription = (
    provider: AuthIdentityProvider,
    email: string,
    t: TFn
): string | null => {
    switch (provider) {
        case 'netmind':
            return t('web.account.disconnectNetmindDescription', { email })
        case 'google':
            return t('web.account.disconnectGoogleDescription', { email })
        case 'oidc':
            return t('web.account.disconnectSsoDescription', { email })
        case 'email':
            return null
    }
}

const identityKey = (identity: AuthIdentitySummary): string =>
    `${identity.provider}:${identity.subject}`

// Two letters, ChatGPT-style — one letter reads as a placeholder, two read
// as an identity. Double initials from a two-word name, else the first two
// characters of the name or the email's local part.
const avatarInitials = (name: string | null, email: string): string => {
    const source = (name ?? '').trim() || email.trim().split('@')[0]
    const words = source.split(/\s+/).filter(Boolean)
    const pair =
        words.length >= 2
            ? `${words[0].charAt(0)}${words[1].charAt(0)}`
            : source.slice(0, 2)
    return (pair || 'A').toUpperCase()
}

const AVATAR_SIDE = 256

// Client-side square crop + downscale so the backend stores a small,
// uniform image and never needs image processing of its own.
const processAvatarFile = async (file: File): Promise<Blob> => {
    const bitmap = await createImageBitmap(file)
    try {
        const side = Math.min(bitmap.width, bitmap.height)
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIDE
        canvas.height = AVATAR_SIDE
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas unavailable')
        ctx.drawImage(
            bitmap,
            (bitmap.width - side) / 2,
            (bitmap.height - side) / 2,
            side,
            side,
            0,
            0,
            AVATAR_SIDE,
            AVATAR_SIDE
        )
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/webp', 0.85)
        )
        if (!blob) throw new Error('image encoding failed')
        return blob
    } finally {
        bitmap.close()
    }
}

type RowState = 'connected' | 'password-missing' | 'disconnected'

interface Row {
    key: string
    provider: AuthIdentityProvider
    state: RowState
    identity?: AuthIdentitySummary
}

const Account: FC = (): ReactNode => {
    const client = useApiClient()
    const auth = useAppAuth()
    const { t } = useI18n()
    const consent = useSyncExternalStore(
        subscribeAnalyticsConsent,
        analyticsConsent
    )
    const { confirm, confirmDialog } = useProductConfirm()
    const netmindConfigured = useNetmindConfigured()
    const [items, setItems] = useState<AuthIdentitySummary[]>([])
    const [planName, setPlanName] = useState<string | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [banner, setBanner] = useState<string | null>(null)
    const [netmindOpen, setNetmindOpen] = useState(false)
    const [passwordOpen, setPasswordOpen] = useState(false)
    const [changeEmailOpen, setChangeEmailOpen] = useState(false)
    const [reauthToken, setReauthToken] = useState<string | null>(null)
    const [googleBusy, setGoogleBusy] = useState(false)
    const { user: currentUser } = useCurrentUser()
    const [profile, setProfile] = useState<AccountProfileSummary | null>(null)
    const [profileError, setProfileError] = useState<string | null>(null)
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
    const [avatarBusy, setAvatarBusy] = useState(false)
    const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
    const [nameEditing, setNameEditing] = useState(false)
    const [nameDraft, setNameDraft] = useState('')
    const [nameBusy, setNameBusy] = useState(false)
    const avatarFileRef = useRef<HTMLInputElement | null>(null)
    // Mirrors avatarUrl so the unmount cleanup can revoke the live object URL
    // (the replace-pattern frees prior ones during the mount's lifetime, but
    // the last one would otherwise leak until the tab closes).
    const avatarUrlRef = useRef<string | null>(null)

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setItems(await client.identities.list())
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoaded(true)
        }
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    // Plan tier for the profile badge. Best effort: no plan, no badge —
    // never a wrong or placeholder tier.
    useEffect(() => {
        let cancelled = false
        client.runtimeAccess
            .summary()
            .then((summary) => {
                if (!cancelled) setPlanName(summary.plan?.name ?? null)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [client])

    // Seed the editable profile from /auth/me once; afterwards the PATCH /
    // upload responses are the source of truth for this page.
    useEffect(() => {
        if (currentUser)
            setProfile((prev) =>
                prev === null
                    ? {
                          displayName: currentUser.displayName ?? null,
                          avatarUpdatedAt: currentUser.avatarUpdatedAt ?? null
                      }
                    : prev
            )
    }, [currentUser])

    // Initial avatar load. Uploads set the object URL directly from the
    // just-processed blob, so this only runs for the server-known avatar.
    const hasRemoteAvatar = Boolean(currentUser?.avatarUpdatedAt)
    useEffect(() => {
        if (!hasRemoteAvatar) return
        let cancelled = false
        void client.profile
            .fetchAvatar()
            .then((blob) => {
                if (cancelled || !blob) return
                const url = URL.createObjectURL(blob)
                setAvatarUrl((prev) => {
                    if (prev) URL.revokeObjectURL(prev)
                    return url
                })
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [client, hasRemoteAvatar])

    useEffect(() => {
        avatarUrlRef.current = avatarUrl
    }, [avatarUrl])
    useEffect(
        () => () => {
            if (avatarUrlRef.current) URL.revokeObjectURL(avatarUrlRef.current)
        },
        []
    )

    const applyProfile = useCallback((summary: AccountProfileSummary): void => {
        setProfile(summary)
        patchCachedCurrentUser({
            displayName: summary.displayName,
            avatarUpdatedAt: summary.avatarUpdatedAt
        })
    }, [])

    const pickAvatarFile = useCallback((): void => {
        setAvatarMenuOpen(false)
        avatarFileRef.current?.click()
    }, [])

    const uploadAvatar = useCallback(
        async (file: File): Promise<void> => {
            setProfileError(null)
            setAvatarBusy(true)
            try {
                const blob = await processAvatarFile(file).catch(() => {
                    throw new Error(t('web.account.avatarReadFailed'))
                })
                const summary = await client.profile
                    .uploadAvatar(blob)
                    .catch((err: unknown) => {
                        throw new Error(apiErrorMessage(err))
                    })
                applyProfile(summary)
                const url = URL.createObjectURL(blob)
                setAvatarUrl((prev) => {
                    if (prev) URL.revokeObjectURL(prev)
                    return url
                })
            } catch (err) {
                setProfileError(
                    err instanceof Error
                        ? err.message
                        : t('web.account.avatarUpdateFailed')
                )
            } finally {
                setAvatarBusy(false)
            }
        },
        [applyProfile, client, t]
    )

    const removeAvatar = useCallback(async (): Promise<void> => {
        setAvatarMenuOpen(false)
        setProfileError(null)
        setAvatarBusy(true)
        try {
            await client.profile.removeAvatar()
            setAvatarUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev)
                return null
            })
            setProfile((prev) =>
                prev ? { ...prev, avatarUpdatedAt: null } : prev
            )
            patchCachedCurrentUser({ avatarUpdatedAt: null })
        } catch (err) {
            setProfileError(apiErrorMessage(err))
        } finally {
            setAvatarBusy(false)
        }
    }, [client])

    const startNameEdit = useCallback((): void => {
        setNameDraft(profile?.displayName ?? '')
        setProfileError(null)
        setNameEditing(true)
    }, [profile])

    const saveName = useCallback(
        async (event: FormEvent): Promise<void> => {
            event.preventDefault()
            if (nameBusy) return
            setProfileError(null)
            setNameBusy(true)
            try {
                const summary = await client.profile.update({
                    displayName: nameDraft.trim() || null
                })
                applyProfile(summary)
                setNameEditing(false)
            } catch (err) {
                setProfileError(apiErrorMessage(err))
            } finally {
                setNameBusy(false)
            }
        },
        [applyProfile, client, nameBusy, nameDraft]
    )

    // The Google link flow returns via redirect, so its outcome arrives in the
    // query string. Surface it once, then scrub the URL so refreshes stay clean.
    // A reauth token means the round-trip was a change-email verification, not
    // a connect — reopen that dialog instead of showing the connect banner.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const linked = params.get('linked')
        const linkError = params.get('link_error')
        const reauth = params.get('reauth')
        if (!linked && !linkError) return
        if (linked === 'google' && reauth) {
            setReauthToken(reauth)
            setChangeEmailOpen(true)
        } else if (linked === 'google') {
            setBanner(t('web.account.googleConnected'))
        }
        if (linkError)
            setError(
                linkError === 'identity_in_use'
                    ? t('web.account.googleIdentityInUse')
                    : t('web.account.googleConnectFailed')
            )
        window.history.replaceState(null, '', window.location.pathname)
    }, [t])

    const bindNetmindToken = useCallback(
        async (loginToken: string): Promise<void> => {
            setError(null)
            setBanner(null)
            try {
                const next = await client.identities.bindNetmind({ loginToken })
                setItems(next)
                setBanner(t('web.account.netmindConnected'))
                setNetmindOpen(false)
            } catch (err) {
                // Re-throw so the message shows inside the dialog (NetmindSignIn
                // renders the thrown error); the dialog stays open to retry.
                throw new Error(apiErrorMessage(err))
            }
        },
        [client, t]
    )

    const connectGoogle = useCallback(async (): Promise<void> => {
        setError(null)
        setBanner(null)
        setGoogleBusy(true)
        try {
            const { url } = await client.identities.googleLinkStart()
            window.location.assign(url)
        } catch (err) {
            setError(apiErrorMessage(err))
            setGoogleBusy(false)
        }
    }, [client])

    const setPassword = useCallback(
        async (input: {
            password: string
            currentPassword?: string
            code?: string
        }): Promise<void> => {
            setBanner(null)
            try {
                const next = await client.identities.setPassword({
                    password: input.password,
                    ...(input.currentPassword
                        ? { currentPassword: input.currentPassword }
                        : {}),
                    ...(input.code ? { code: input.code } : {})
                })
                setItems(next)
                setBanner(
                    input.currentPassword
                        ? t('web.account.passwordUpdated')
                        : t('web.account.passwordSet')
                )
                setPasswordOpen(false)
            } catch (err) {
                throw new Error(apiErrorMessage(err))
            }
        },
        [client, t]
    )

    const sendPasswordCode = useCallback(async (): Promise<void> => {
        try {
            await client.identities.setPasswordStart()
        } catch (err) {
            throw new Error(apiErrorMessage(err))
        }
    }, [client])

    const changeEmailStart = useCallback(
        async (input: {
            newEmail: string
            currentPassword?: string
            reauthToken?: string
        }): Promise<void> => {
            try {
                await client.identities.changeEmailStart(input)
            } catch (err) {
                throw new Error(apiErrorMessage(err))
            }
        },
        [client]
    )

    const changeEmailVerify = useCallback(
        async (input: {
            newEmail: string
            code: string
            newPassword?: string
        }): Promise<AuthIdentitySummary[]> => {
            try {
                return await client.identities.changeEmailVerify(input)
            } catch (err) {
                throw new Error(apiErrorMessage(err))
            }
        },
        [client]
    )

    const disconnect = useCallback(
        async (identity: AuthIdentitySummary): Promise<void> => {
            const description = disconnectDescription(
                identity.provider,
                identity.email,
                t
            )
            if (!description) return
            const ok = await confirm({
                title: t('web.account.disconnectTitle', {
                    provider: providerLabel(identity.provider, t)
                }),
                description,
                confirmLabel: t('web.account.disconnect'),
                cancelLabel: t('common.cancel')
            })
            if (!ok) return
            setError(null)
            setBanner(null)
            try {
                await client.identities.unlink(
                    identity.provider,
                    identity.subject
                )
                await refresh()
            } catch (err) {
                setError(apiErrorMessage(err))
            }
        },
        [client, confirm, refresh, t]
    )

    // The email identity is the sign-in email (kept in step with the account's
    // primary email by the change-email swap); auth.user can lag until the
    // next full reload after a change.
    const emailIdentity = items.find((item) => item.provider === 'email')
    const accountEmail = emailIdentity?.email ?? auth.user?.email ?? ''
    const hasPassword = Boolean(emailIdentity?.hasPassword)
    const googleLinked = items.some((item) => item.provider === 'google')
    const methods = auth.methods
    // A password-less email identity can't sign in, so it doesn't count as a
    // usable method — without this, disconnecting Google on a Google-only
    // account would lock the user out behind a password-less email row.
    const usableMethods =
        items.filter((item) => item.provider !== 'email').length +
        (hasPassword ? 1 : 0)
    const lastMethod = usableMethods <= 1

    // Fixed directory order: NetMind first (the parent platform), then Google,
    // then email; other identities (SSO) append when present.
    const rows: Row[] = []
    const push = (provider: AuthIdentityProvider, available: boolean): void => {
        const owned = items.filter((item) => item.provider === provider)
        for (const identity of owned)
            rows.push({
                key: identityKey(identity),
                provider,
                identity,
                state: 'connected'
            })
        if (owned.length === 0 && available && loaded)
            rows.push({ key: provider, provider, state: 'disconnected' })
    }
    push('netmind', netmindConfigured)
    push('google', methods?.google !== false)
    // Email is never "not connected" — the account always has a primary
    // email; the only variable is whether a password is set for it.
    if (methods?.password !== false && loaded) {
        if (emailIdentity?.hasPassword)
            rows.push({
                key: identityKey(emailIdentity),
                provider: 'email',
                identity: emailIdentity,
                state: 'connected'
            })
        else
            rows.push({
                key: 'email',
                provider: 'email',
                identity: emailIdentity,
                state: 'password-missing'
            })
    }
    for (const identity of items)
        if (!['netmind', 'google', 'email'].includes(identity.provider))
            rows.push({
                key: identityKey(identity),
                provider: identity.provider,
                identity,
                state: 'connected'
            })

    const connectButton = (row: Row): ReactNode => {
        if (row.provider === 'netmind')
            return (
                <button
                    type='button'
                    className='workbench-button-secondary h-8 shrink-0 px-3'
                    onClick={() => setNetmindOpen(true)}
                >
                    {t('web.account.connect')}
                </button>
            )
        if (row.provider === 'google')
            return (
                <button
                    type='button'
                    className='workbench-button-secondary h-8 shrink-0 px-3'
                    disabled={googleBusy}
                    onClick={() => void connectGoogle()}
                >
                    {googleBusy ? <Spinner size={16} className='mr-2' /> : null}
                    {t('web.account.connect')}
                </button>
            )
        return (
            <button
                type='button'
                className='workbench-button-secondary h-8 shrink-0 px-3'
                onClick={() => setPasswordOpen(true)}
            >
                {t('web.account.setPassword')}
            </button>
        )
    }

    return (
        <div className='settings-page'>
            <SettingsPageHeader title={t('web.account.title')} />

            {banner ? (
                <div
                    role='status'
                    className='bg-success-bg mb-5 flex items-start gap-2.5 rounded-sm px-3.5 py-2.5'
                >
                    <CheckIcon className='text-success mt-0.5 h-4 w-4 shrink-0' />
                    <p className='text-ui text-fg min-w-0 flex-1'>{banner}</p>
                    <button
                        type='button'
                        className='text-muted hover:bg-surface-hover rounded-pill -mr-1 flex h-6 w-6 shrink-0 items-center justify-center transition-colors'
                        aria-label={t('common.dismiss')}
                        onClick={() => setBanner(null)}
                    >
                        <CloseIcon className='h-3.5 w-3.5' />
                    </button>
                </div>
            ) : null}
            {error ? (
                <div
                    role='alert'
                    className='bg-error-bg mb-5 flex items-start gap-2.5 rounded-sm px-3.5 py-2.5'
                >
                    <ShieldAlertIcon className='text-error mt-0.5 h-4 w-4 shrink-0' />
                    <p className='text-ui text-fg min-w-0 flex-1'>{error}</p>
                    <button
                        type='button'
                        className='text-muted hover:bg-surface-hover rounded-pill -mr-1 flex h-6 w-6 shrink-0 items-center justify-center transition-colors'
                        aria-label={t('common.dismiss')}
                        onClick={() => setError(null)}
                    >
                        <CloseIcon className='h-3.5 w-3.5' />
                    </button>
                </div>
            ) : null}

            {/* Identity moment, not a form row: centred on the page floor
                (no card — it annotates the page, it isn't a control). The
                block itself is the editor: the avatar is a button, the name
                is click-to-edit in place. */}
            <section className='settings-section'>
                <div className='flex flex-col items-center pb-2 pt-6 text-center'>
                    <div className='relative'>
                        <button
                            type='button'
                            className='rounded-pill group relative block'
                            aria-label={t('web.account.profilePhotoChange')}
                            disabled={avatarBusy}
                            onClick={() =>
                                avatarUrl
                                    ? setAvatarMenuOpen((open) => !open)
                                    : pickAvatarFile()
                            }
                        >
                            <span className='shadow-ring-light bg-avatar-bg text-avatar-fg flex h-20 w-20 items-center justify-center overflow-hidden rounded-full text-[1.75rem] font-medium tracking-wide'>
                                {avatarUrl ? (
                                    <img
                                        src={avatarUrl}
                                        alt=''
                                        className='h-full w-full object-cover'
                                    />
                                ) : (
                                    avatarInitials(
                                        profile?.displayName ?? null,
                                        accountEmail
                                    )
                                )}
                            </span>
                            <span
                                className={[
                                    'absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white transition-opacity',
                                    avatarBusy
                                        ? 'opacity-100'
                                        : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
                                ].join(' ')}
                            >
                                {avatarBusy ? (
                                    <Spinner size={20} />
                                ) : (
                                    <CameraIcon className='h-5 w-5' />
                                )}
                            </span>
                        </button>
                        {avatarMenuOpen ? (
                            <>
                                <div
                                    className='fixed inset-0 z-40'
                                    onClick={() => setAvatarMenuOpen(false)}
                                />
                                <div
                                    role='menu'
                                    className='shadow-elevated bg-surface-elevated/95 popover-panel absolute left-1/2 top-full z-50 mt-2 w-44 -translate-x-1/2 rounded-md p-1 text-left backdrop-blur'
                                >
                                    <button
                                        type='button'
                                        role='menuitem'
                                        className='text-ui text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 transition-colors'
                                        onClick={pickAvatarFile}
                                    >
                                        <CameraIcon className='text-muted h-4 w-4' />
                                        {t('web.account.profilePhotoChange')}
                                    </button>
                                    <button
                                        type='button'
                                        role='menuitem'
                                        className='text-ui text-fg hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 transition-colors'
                                        onClick={() => void removeAvatar()}
                                    >
                                        <TrashIcon className='text-muted h-4 w-4' />
                                        {t('web.account.profilePhotoRemove')}
                                    </button>
                                </div>
                            </>
                        ) : null}
                    </div>
                    <input
                        ref={avatarFileRef}
                        type='file'
                        accept='image/png,image/jpeg,image/webp'
                        className='hidden'
                        onChange={(e) => {
                            const file = e.target.files?.[0]
                            e.target.value = ''
                            if (file) void uploadAvatar(file)
                        }}
                    />

                    {nameEditing ? (
                        <form
                            className='mt-4 flex w-full items-center justify-center gap-2'
                            onSubmit={(e) => void saveName(e)}
                        >
                            <input
                                autoFocus
                                className='workbench-input h-9 w-64 text-center'
                                value={nameDraft}
                                maxLength={50}
                                placeholder={t(
                                    'web.account.profileNamePlaceholder'
                                )}
                                onChange={(e) => setNameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape')
                                        setNameEditing(false)
                                }}
                            />
                            <button
                                type='submit'
                                className='workbench-button-secondary h-9 w-9 shrink-0 !px-0'
                                aria-label={t('web.account.profileNameSave')}
                                disabled={nameBusy}
                            >
                                {nameBusy ? (
                                    <Spinner size={16} />
                                ) : (
                                    <CheckIcon className='h-4 w-4' />
                                )}
                            </button>
                            <button
                                type='button'
                                className='workbench-button-secondary h-9 w-9 shrink-0 !px-0'
                                aria-label={t('common.cancel')}
                                onClick={() => setNameEditing(false)}
                            >
                                <CloseIcon className='h-4 w-4' />
                            </button>
                        </form>
                    ) : (
                        /* Fixed slots, nothing swaps between states: this
                           line is always the NAME (a placeholder-toned "Add
                           name" when unset), the row below is always the
                           email. Stable positions beat clever promotion. */
                        <ShortcutTooltip
                            label={
                                profile?.displayName
                                    ? t('web.account.profileNameEdit')
                                    : t('web.account.profileNameAdd')
                            }
                            className='mt-4 min-w-0 max-w-full'
                        >
                            <button
                                type='button'
                                className='group relative min-w-0 max-w-full'
                                onClick={startNameEdit}
                            >
                                <span
                                    className={[
                                        'text-h2 block truncate px-7 font-medium',
                                        profile?.displayName
                                            ? 'text-fg'
                                            : 'text-placeholder'
                                    ].join(' ')}
                                >
                                    {loaded
                                        ? profile?.displayName ||
                                          t('web.account.profileNameAdd')
                                        : t('common.loading')}
                                </span>
                                {/* Absolutely placed so the name itself stays on
                                the avatar's centre axis. */}
                                <EditIcon className='text-muted absolute right-1 top-1/2 h-4 w-4 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100' />
                            </button>
                        </ShortcutTooltip>
                    )}
                    {/* Metadata register, ChatGPT's "@handle · Plus" line:
                        always email + plan. Display only — changing the
                        email lives on its sign-in method row below. */}
                    <div className='mt-1.5 flex w-full items-center justify-center gap-2'>
                        {loaded && accountEmail ? (
                            <span className='text-ui text-muted min-w-0 truncate'>
                                {accountEmail}
                            </span>
                        ) : null}
                        {planName ? (
                            <span className='tag tag-neutral shrink-0'>
                                {planName}
                            </span>
                        ) : null}
                    </div>
                    {profileError ? (
                        <p className='text-caption text-error mt-2.5'>
                            {profileError}
                        </p>
                    ) : null}
                </div>
            </section>

            <section>
                <div className='settings-card-label mb-3'>
                    {t('web.account.signInMethods')}
                </div>
                {rows.length === 0 ? (
                    <p className='text-ui text-muted'>
                        {loaded
                            ? t('web.account.noSignInMethods')
                            : t('common.loading')}
                    </p>
                ) : (
                    <ul className='workbench-panel divide-divider divide-y overflow-hidden'>
                        {rows.map((row) => (
                            <li
                                key={row.key}
                                className='flex items-center gap-3.5 px-4 py-3.5 sm:px-5'
                            >
                                <ShortcutTooltip
                                    label={
                                        row.state === 'connected' &&
                                        row.provider !== 'email' &&
                                        lastMethod
                                            ? t('web.account.onlySignInMethod')
                                            : undefined
                                    }
                                    className='w-full items-center gap-3.5'
                                >
                                    <span
                                        className={`rounded-pill flex h-9 w-9 shrink-0 items-center justify-center ${
                                            row.state === 'connected'
                                                ? 'bg-soft text-fg'
                                                : 'border-divider text-placeholder border border-dashed'
                                        }`}
                                    >
                                        <ProviderLogo
                                            provider={row.provider}
                                            size={18}
                                            mono={row.state !== 'connected'}
                                        />
                                    </span>
                                    <div className='min-w-0 flex-1'>
                                        <p
                                            className={`text-ui font-medium ${
                                                row.state === 'connected'
                                                    ? 'text-fg'
                                                    : 'text-placeholder'
                                            }`}
                                        >
                                            {providerLabel(row.provider, t)}
                                        </p>
                                        <p
                                            className={`text-caption truncate ${
                                                row.state === 'connected'
                                                    ? 'text-muted'
                                                    : 'text-placeholder'
                                            }`}
                                        >
                                            {row.state === 'disconnected'
                                                ? t('web.account.notConnected')
                                                : row.state ===
                                                    'password-missing'
                                                  ? row.identity?.email ||
                                                    accountEmail ||
                                                    t(
                                                        'web.account.noPasswordSet'
                                                    )
                                                  : row.identity?.email}
                                        </p>
                                    </div>
                                    {/* No standing tags: the button label
                                    carries the password state, and a
                                    non-removable method simply offers
                                    nothing (the row tooltip explains). */}
                                    {row.state === 'disconnected' ? (
                                        connectButton(row)
                                    ) : row.provider === 'email' ? (
                                        <>
                                            <button
                                                type='button'
                                                className='workbench-button-secondary h-8 shrink-0 px-3'
                                                onClick={() =>
                                                    setPasswordOpen(true)
                                                }
                                            >
                                                {row.state ===
                                                'password-missing'
                                                    ? t(
                                                          'web.account.setPassword'
                                                      )
                                                    : t(
                                                          'web.account.changePassword'
                                                      )}
                                            </button>
                                            <button
                                                type='button'
                                                className='workbench-button-secondary h-8 shrink-0 px-3'
                                                onClick={() =>
                                                    setChangeEmailOpen(true)
                                                }
                                            >
                                                {t('web.account.changeEmail')}
                                            </button>
                                        </>
                                    ) : lastMethod ? null : (
                                        <button
                                            type='button'
                                            className='workbench-button-danger h-8 shrink-0 px-3'
                                            onClick={() =>
                                                void disconnect(row.identity!)
                                            }
                                        >
                                            {t('web.account.disconnect')}
                                        </button>
                                    )}
                                </ShortcutTooltip>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {analyticsConfigured ? (
                <section>
                    <div className='settings-card-label mb-3'>
                        {t('web.consent.settingsTitle')}
                    </div>
                    <p className='text-ui text-muted mb-3'>
                        {t('web.consent.settingsDescription')}
                    </p>
                    <div className='flex items-center gap-3'>
                        <span className='text-ui text-fg'>
                            {consent === 'granted'
                                ? t('web.consent.statusGranted')
                                : consent === 'denied'
                                  ? t('web.consent.statusDenied')
                                  : t('web.consent.statusUnset')}
                        </span>
                        <button
                            type='button'
                            className='workbench-button-secondary h-8 shrink-0 px-3'
                            onClick={() =>
                                setAnalyticsConsent(
                                    consent === 'granted' ? 'denied' : 'granted'
                                )
                            }
                        >
                            {consent === 'granted'
                                ? t('web.consent.disable')
                                : t('web.consent.enable')}
                        </button>
                    </div>
                </section>
            ) : null}

            {netmindOpen && (
                <NetmindSignInDialog
                    title={t('web.account.connectNetmindTitle')}
                    description={t('web.account.connectNetmindDescription')}
                    submitLabel={t('web.account.connect')}
                    onToken={bindNetmindToken}
                    onClose={() => setNetmindOpen(false)}
                />
            )}
            {passwordOpen && (
                <SetPasswordDialog
                    email={accountEmail}
                    requireCurrent={hasPassword}
                    onSendCode={sendPasswordCode}
                    onSubmit={setPassword}
                    onClose={() => setPasswordOpen(false)}
                />
            )}
            {changeEmailOpen && (
                <ChangeEmailDialog
                    accountEmail={accountEmail}
                    hasPassword={hasPassword}
                    googleLinked={googleLinked}
                    reauthToken={reauthToken}
                    onGoogleReauth={connectGoogle}
                    onStart={changeEmailStart}
                    onVerify={changeEmailVerify}
                    onDone={(next, newEmail) => {
                        setItems(next)
                        // Keep the session-scoped cache honest so the sidebar
                        // account menu (which falls back to the email when no
                        // display name is set) doesn't show the retired one.
                        patchCachedCurrentUser({ email: newEmail })
                        setChangeEmailOpen(false)
                        setReauthToken(null)
                        setBanner(
                            t('web.account.emailChanged', {
                                newEmail,
                                oldEmail: accountEmail
                            })
                        )
                    }}
                    onClose={() => {
                        setChangeEmailOpen(false)
                        setReauthToken(null)
                    }}
                />
            )}
            {confirmDialog}
        </div>
    )
}

export default Account

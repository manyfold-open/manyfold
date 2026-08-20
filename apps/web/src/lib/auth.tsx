import {
    AuthRegisterResponse,
    AuthSessionResponse,
    PublicAuthConfig,
    apiPaths
} from '@manyfold/shared'
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type FC,
    type FormEvent,
    type ReactNode
} from 'react'
import { t } from '@manyfold/i18n'
import { attributionTokens, withAttributionParams } from '@/lib/attribution'
import { safeRedirect } from '@/lib/safeRedirect'
import { useI18n } from '@/lib/i18n'
import { isMarketingPath } from '@/seo/pages'
import { clearSession, getSession, storeSession } from '@/lib/session'
import BootScreen from '@/components/BootScreen'
import { NetmindSignInDialog } from '@/components/NetmindSignInDialog'
import { GoogleColor } from '@/lib/brandIcons'
import { NetmindMark } from '@/lib/brandMarks'
import { setNetmindConfig } from '@/lib/netmindAuth/config'

type AuthProviderKind = 'native'

type AuthMethods = {
    password: boolean
    google: boolean
    oidc: boolean
    netmind: boolean
}

interface AuthUser {
    id: string | null
    email?: string | null
}

interface SignOutOptions {
    redirectUrl?: string
}

interface AuthContextValue {
    provider: AuthProviderKind | null
    isLoaded: boolean
    isSignedIn: boolean
    setupRequired: boolean
    sessionKey: string | null
    user: AuthUser | null
    methods?: AuthMethods
    emailVerificationRequired?: boolean
    oidcButtonLabel?: string | null
    oauthError?: string | null
    getToken: () => Promise<string>
    signIn: (redirectUrl?: string) => void
    signOut: (opts?: SignOutOptions) => void
    refreshConfig: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const devBearerToken: string | undefined = import.meta.env.DEV
    ? (import.meta.env.VITE_DEV_BEARER_TOKEN as string | undefined)?.trim() ||
      undefined
    : undefined

const devForceSignedOut: boolean = import.meta.env.DEV
    ? (import.meta.env.VITE_DEV_FORCE_SIGNED_OUT as string | undefined)
          ?.trim()
          .toLowerCase() === 'true'
    : false

const MockSignedOutAuthProvider: FC<{ children: ReactNode }> = ({
    children
}) => {
    const value = useMemo<AuthContextValue>(
        () => ({
            provider: null,
            isLoaded: true,
            isSignedIn: false,
            setupRequired: false,
            sessionKey: null,
            user: null,
            getToken: async () => '',
            signIn: () => {
                window.location.assign('/login')
            },
            signOut: () => {},
            refreshConfig: async () => {}
        }),
        []
    )
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const AppAuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
    if (devForceSignedOut) {
        return <MockSignedOutAuthProvider>{children}</MockSignedOutAuthProvider>
    }
    if (devBearerToken) {
        return (
            <DevTokenAuthProvider token={devBearerToken}>
                {children}
            </DevTokenAuthProvider>
        )
    }
    return <RemoteAuthProvider>{children}</RemoteAuthProvider>
}

const RemoteAuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const [config, setConfig] = useState<PublicAuthConfig | null>(null)
    const [error, setError] = useState<string | null>(null)

    const refreshConfig = useCallback(async (): Promise<void> => {
        setError(null)
        try {
            setConfig(await fetchAuthConfig())
        } catch (err) {
            setError(authErrorMessage(err))
        }
    }, [])

    useEffect(() => {
        void refreshConfig()
    }, [refreshConfig])

    // Indexable marketing URLs must not wait for /api/auth/config: they render
    // immediately with a null config (NativeAuthProvider handles it), and the
    // same provider instance picks the config up when it arrives — no remount,
    // so the visible landing content never resets mid-read. Decided from the
    // initial URL: while the gate below is active no router exists to
    // navigate, and once bypassed the provider stays bypassed.
    const marketingBypass = useState(() =>
        isMarketingPath(window.location.pathname)
    )[0]

    // A marketing visitor with the API briefly down should still get a page;
    // keep retrying quietly so sign-in recovers without a manual reload.
    useEffect(() => {
        if (!marketingBypass || !error) return
        const timer = window.setTimeout(() => void refreshConfig(), 8000)
        return () => window.clearTimeout(timer)
    }, [marketingBypass, error, refreshConfig])

    if (!marketingBypass) {
        if (error)
            return (
                <AuthShellMessage
                    title={t('web.auth.unavailableTitle')}
                    body={error}
                />
            )

        if (!config) return <BootScreen />
    }

    if (config && !config.configured)
        return (
            <UnconfiguredAuthProvider refreshConfig={refreshConfig}>
                {children}
            </UnconfiguredAuthProvider>
        )

    return (
        <NativeAuthProvider
            config={config && config.configured ? config : null}
            refreshConfig={refreshConfig}
        >
            {children}
        </NativeAuthProvider>
    )
}

export const useAppAuth = (): AuthContextValue => {
    const value = useContext(AuthContext)
    if (!value) throw new Error('useAppAuth used without AppAuthProvider')
    return value
}

export const SignedIn: FC<{ children: ReactNode }> = ({ children }) => {
    const auth = useAppAuth()
    return auth.isLoaded && auth.isSignedIn ? <>{children}</> : null
}

export const SignedOut: FC<{ children: ReactNode }> = ({ children }) => {
    const auth = useAppAuth()
    return auth.isLoaded && !auth.isSignedIn ? <>{children}</> : null
}

export type AuthFormMode = 'sign-in' | 'sign-up'

export const AuthSignIn: FC<{
    redirectUrl: string
    path?: string
    appearance?: unknown
    initialMode?: AuthFormMode
    lockMode?: boolean
    prefillEmail?: string
}> = ({ redirectUrl, initialMode, lockMode, prefillEmail }) => {
    const auth = useAppAuth()
    const { t } = useI18n()
    if (auth.setupRequired)
        return (
            <div className='shadow-card border-divider bg-surface w-full rounded-md border p-6'>
                <div className='space-y-1'>
                    <h1 className='text-fg text-h2'>
                        {t('web.auth.setupRequired')}
                    </h1>
                    <p className='text-muted text-sm'>
                        {t('web.auth.adminNeedsToConfigure')}
                    </p>
                </div>
            </div>
        )
    return (
        <NativeCredentialForm
            redirectUrl={redirectUrl}
            initialMode={initialMode}
            lockMode={lockMode}
            prefillEmail={prefillEmail}
        />
    )
}

const UnconfiguredAuthProvider: FC<{
    children: ReactNode
    refreshConfig: () => Promise<void>
}> = ({ children, refreshConfig }) => {
    const value = useMemo<AuthContextValue>(
        () => ({
            provider: null,
            isLoaded: true,
            isSignedIn: false,
            setupRequired: true,
            sessionKey: null,
            user: null,
            getToken: async () => '',
            signIn: () => {
                window.location.assign('/login')
            },
            signOut: () => {},
            refreshConfig
        }),
        [refreshConfig]
    )
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

const DevTokenAuthProvider: FC<{
    token: string
    children: ReactNode
}> = ({ token, children }) => {
    const [user, setUser] = useState<AuthUser | null>(null)
    const [loaded, setLoaded] = useState(false)

    useEffect(() => {
        let cancelled = false
        fetch(`${apiBase()}${apiPaths.AUTH_ME}`, {
            headers: { Authorization: `Bearer ${token}` }
        })
            .then(async (res) =>
                res.ok
                    ? (res.json() as Promise<{
                          id?: string
                          email?: string
                      }>)
                    : null
            )
            .then((data) => {
                if (cancelled) return
                if (data) {
                    setUser({
                        id: data.id ?? null,
                        email: data.email ?? null
                    })
                }
                setLoaded(true)
            })
            .catch(() => {
                if (!cancelled) setLoaded(true)
            })
        return () => {
            cancelled = true
        }
    }, [token])

    // Dev-token mode skips RemoteAuthProvider, which is where the NetMind
    // public config normally gets stashed — fetch it here too so surfaces
    // gated on isNetmindConfigured() behave like a real session.
    useEffect(() => {
        let cancelled = false
        void fetchAuthConfig()
            .then((config) => {
                if (!cancelled && config.configured)
                    setNetmindConfig(config.netmind)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [])

    const value = useMemo<AuthContextValue>(
        () => ({
            provider: null,
            isLoaded: loaded,
            isSignedIn: true,
            setupRequired: false,
            sessionKey: user?.id ?? 'dev-token',
            user,
            getToken: async () => token,
            signIn: () => {
                window.location.assign('/login')
            },
            signOut: () => {
                window.location.reload()
            },
            refreshConfig: async () => {}
        }),
        [loaded, token, user]
    )

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// `config` is null while the auth config is still loading (or unreachable)
// behind the marketing bypass. The session boot below never needed the
// config — it only needs the stored token — so sign-in state resolves
// independently and the provider upgrades in place when the config lands.
const NativeAuthProvider: FC<{
    children: ReactNode
    config: Extract<PublicAuthConfig, { configured: true }> | null
    refreshConfig: () => Promise<void>
}> = ({ children, config, refreshConfig }) => {
    const [user, setUser] = useState<AuthUser | null>(null)
    const [isSignedIn, setIsSignedIn] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [oauthError, setOauthError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        // Only a genuine 401/403 (expired/invalid/revoked token) clears the
        // session. Transient failures — cold-start 5xx, network/CORS errors —
        // retry with a short backoff and otherwise RETAIN the token, so an
        // unreachable API can no longer wipe a still-valid login. Clearing on
        // any non-200 was the old "keeps logging me out" bug.
        const loadMe = async (token: string): Promise<void> => {
            const delays = [0, 500, 1500]
            for (let attempt = 0; attempt < delays.length; attempt++) {
                if (delays[attempt] > 0) await sleep(delays[attempt])
                if (cancelled) return
                let res: Response
                try {
                    res = await fetch(`${apiBase()}${apiPaths.AUTH_ME}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    })
                } catch {
                    continue
                }
                if (res.status === 401 || res.status === 403) {
                    clearSession()
                    if (!cancelled) {
                        setIsSignedIn(false)
                        setLoaded(true)
                    }
                    return
                }
                if (!res.ok) continue
                const data = (await res.json().catch(() => null)) as {
                    id?: string
                    email?: string
                } | null
                if (cancelled) return
                setUser({ id: data?.id ?? null, email: data?.email ?? null })
                setIsSignedIn(true)
                setLoaded(true)
                return
            }
            // Every attempt hit a transient failure: keep the token and treat
            // the user as signed in. The next request or reload re-validates.
            if (!cancelled) {
                setIsSignedIn(true)
                setLoaded(true)
            }
        }
        const boot = async (): Promise<void> => {
            const fragment = parseAuthFragment()
            // A NarraNexus → Manyfold hand-off (#nmtoken=) is AUTHORITATIVE:
            // trade the NetMind token for our session, replacing any stale one.
            // On failure we sign OUT rather than fall through to an existing
            // session — that would silently authenticate the previous user.
            if (fragment.nmtoken) {
                scrubFragment()
                try {
                    const res = await postAuth<AuthSessionResponse>(
                        apiPaths.AUTH_NETMIND,
                        { loginToken: fragment.nmtoken }
                    )
                    storeSession(res.token)
                    await loadMe(res.token)
                } catch {
                    clearSession()
                    if (!cancelled) {
                        setOauthError(t('web.auth.oauthError'))
                        setIsSignedIn(false)
                        setLoaded(true)
                    }
                }
                return
            }
            if (fragment.token) {
                storeSession(fragment.token)
                scrubFragment()
            }
            if (fragment.error) {
                setOauthError(t('web.auth.oauthError'))
                scrubFragment()
            }
            const token = getSession()
            if (!token) {
                if (!cancelled) {
                    setIsSignedIn(false)
                    setLoaded(true)
                }
                return
            }
            await loadMe(token)
        }
        void boot()
        return () => {
            cancelled = true
        }
    }, [])

    useEffect(() => {
        if (config) setNetmindConfig(config.netmind)
    }, [config])

    const value = useMemo<AuthContextValue>(
        () => ({
            provider: 'native',
            isLoaded: loaded,
            isSignedIn,
            setupRequired: false,
            sessionKey: user?.id ?? null,
            user,
            methods: config?.methods,
            emailVerificationRequired: config?.emailVerificationRequired,
            oidcButtonLabel: config?.oidcButtonLabel,
            oauthError,
            getToken: async () => getSession() ?? '',
            signIn: (redirectUrl = '/workspace') => {
                window.location.assign(
                    `/login?redirect_url=${encodeURIComponent(redirectUrl)}`
                )
            },
            signOut: (opts) => {
                const token = getSession()
                if (token) {
                    void fetch(`${apiBase()}${apiPaths.AUTH_LOGOUT}`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` }
                    }).catch(() => {})
                }
                clearSession()
                window.location.assign(opts?.redirectUrl ?? '/login')
            },
            refreshConfig
        }),
        [loaded, isSignedIn, user, config, oauthError, refreshConfig]
    )
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

type FormMode = 'sign-in' | 'sign-up' | 'forgot' | 'reset'

const NativeCredentialForm: FC<{
    redirectUrl: string
    initialMode?: AuthFormMode
    lockMode?: boolean
    prefillEmail?: string
}> = ({
    redirectUrl,
    initialMode = 'sign-in',
    lockMode = false,
    prefillEmail
}) => {
    const { t } = useI18n()
    const auth = useAppAuth()
    const methods = auth.methods ?? {
        password: true,
        google: false,
        oidc: false,
        netmind: false
    }
    const [mode, setMode] = useState<FormMode>(initialMode)
    const [netmindOpen, setNetmindOpen] = useState(false)
    const [email, setEmail] = useState(prefillEmail ?? '')
    const [password, setPassword] = useState('')
    const [verificationCode, setVerificationCode] = useState('')
    const [pendingVerification, setPendingVerification] = useState(false)
    const [error, setError] = useState<string | null>(auth.oauthError ?? null)
    const [notice, setNotice] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const emailLocked = lockMode && Boolean(prefillEmail)

    const completeSession = (res: AuthSessionResponse): void => {
        storeSession(res.token)
        window.location.assign(safeRedirect(redirectUrl) ?? '/workspace')
    }

    const netmindLogin = async (loginToken: string): Promise<void> => {
        const res = await postAuth<AuthSessionResponse>(apiPaths.AUTH_NETMIND, {
            loginToken,
            ...attributionTokens()
        })
        completeSession(res)
    }

    const startOauth = (provider: 'google' | 'oidc'): void => {
        const target = safeRedirect(redirectUrl) ?? '/workspace'
        const path =
            provider === 'google'
                ? apiPaths.AUTH_OAUTH_GOOGLE_START
                : apiPaths.AUTH_OAUTH_OIDC_START
        // Touch tokens ride the start URL: the API resolves and parks them in
        // oauth_states so attribution survives the IdP round trip.
        window.location.href = withAttributionParams(
            `${apiBase()}${path}?redirect_url=${encodeURIComponent(target)}`
        )
    }

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault()
        setSubmitting(true)
        setError(null)
        setNotice(null)
        try {
            if (mode === 'sign-in') {
                const res = await postAuth<AuthSessionResponse>(
                    apiPaths.AUTH_LOGIN,
                    { email: email.trim(), password, ...attributionTokens() }
                )
                completeSession(res)
                return
            }
            if (mode === 'forgot') {
                await postAuth(apiPaths.AUTH_FORGOT_PASSWORD, {
                    email: email.trim()
                })
                setMode('reset')
                setNotice(t('web.auth.checkYourEmailBody'))
                return
            }
            if (mode === 'reset') {
                const res = await postAuth<AuthSessionResponse>(
                    apiPaths.AUTH_RESET_PASSWORD,
                    {
                        email: email.trim(),
                        code: verificationCode.trim(),
                        password
                    }
                )
                completeSession(res)
                return
            }
            // sign-up
            if (pendingVerification) {
                // Tokens re-sent here: register() keeps nothing server-side
                // while the address is unproven, and verification completing
                // is the account_created moment the API attributes.
                const res = await postAuth<AuthSessionResponse>(
                    apiPaths.AUTH_VERIFY_EMAIL,
                    {
                        email: email.trim(),
                        code: verificationCode.trim(),
                        ...attributionTokens()
                    }
                )
                completeSession(res)
                return
            }
            const res = await postAuth<AuthRegisterResponse>(
                apiPaths.AUTH_REGISTER,
                { email: email.trim(), password, ...attributionTokens() }
            )
            if ('pendingVerification' in res) {
                setPendingVerification(true)
                setNotice(t('web.auth.checkYourEmailBody'))
                return
            }
            completeSession(res)
        } catch (err) {
            setError(authErrorMessage(err))
        } finally {
            setSubmitting(false)
        }
    }

    const resend = async (): Promise<void> => {
        setError(null)
        try {
            await postAuth(apiPaths.AUTH_RESEND_CODE, { email: email.trim() })
            setNotice(t('web.auth.codeResent'))
        } catch (err) {
            setError(authErrorMessage(err))
        }
    }

    const goMode = (next: FormMode): void => {
        setMode(next)
        setError(null)
        setNotice(null)
        setPendingVerification(false)
        setVerificationCode('')
        setPassword('')
    }

    const title =
        mode === 'forgot'
            ? t('web.auth.forgotPasswordTitle')
            : mode === 'reset'
              ? t('web.auth.resetPasswordTitle')
              : mode === 'sign-up'
                ? pendingVerification
                    ? t('web.auth.verifyEmailTitle')
                    : t('web.auth.signUpTitle')
                : t('web.auth.signInTitle')
    const subtitle =
        mode === 'forgot'
            ? t('web.auth.forgotPasswordBody')
            : mode === 'reset'
              ? t('web.auth.resetPasswordBody')
              : mode === 'sign-up'
                ? t('web.auth.createWorkspaceAccount')
                : t('web.auth.useWorkspaceAccount')
    const cta =
        mode === 'forgot'
            ? t('web.auth.sendResetCode')
            : mode === 'reset'
              ? t('web.auth.resetPasswordCta')
              : mode === 'sign-up'
                ? pendingVerification
                    ? t('web.auth.verifyEmailTitle')
                    : t('web.auth.signUpTitle')
                : t('web.auth.signInTitle')

    const showSocial =
        (mode === 'sign-in' || mode === 'sign-up') &&
        (methods.google || methods.oidc || methods.netmind)
    const showPasswordForm =
        methods.password || mode === 'forgot' || mode === 'reset'

    return (
        <div className='shadow-card border-divider bg-surface w-full rounded-md border p-6'>
            <div className='mb-5 space-y-1'>
                <h1 className='text-fg text-h2'>{title}</h1>
                <p className='text-muted text-sm'>{subtitle}</p>
            </div>

            {showSocial && (
                <>
                    <div className='space-y-2.5'>
                        {methods.google && (
                            <button
                                type='button'
                                disabled={submitting}
                                onClick={() => startOauth('google')}
                                className='text-ui border-divider bg-surface hover:bg-surface-hover text-fg inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border px-4 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                            >
                                <span
                                    aria-hidden='true'
                                    className='inline-flex shrink-0'
                                >
                                    <GoogleColor size={18} />
                                </span>
                                {t('web.auth.continueWithGoogle')}
                            </button>
                        )}
                        {methods.netmind && (
                            <button
                                type='button'
                                disabled={submitting}
                                onClick={() => setNetmindOpen(true)}
                                className='text-ui border-divider bg-surface hover:bg-surface-hover text-fg inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border px-4 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                            >
                                <NetmindMark size={18} className='shrink-0' />
                                {t('web.auth.continueWithNetmind')}
                            </button>
                        )}
                        {methods.oidc && (
                            <button
                                type='button'
                                disabled={submitting}
                                onClick={() => startOauth('oidc')}
                                className='text-ui border-divider bg-surface hover:bg-surface-hover text-fg inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border px-4 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                            >
                                {auth.oidcButtonLabel ||
                                    t('web.auth.continueWithSso')}
                            </button>
                        )}
                    </div>
                    {showPasswordForm && (
                        <div
                            className='my-5 flex items-center gap-3'
                            role='separator'
                        >
                            <span className='bg-divider h-px flex-1' />
                            <span className='text-caption text-muted'>
                                {t('web.auth.orUseEmail')}
                            </span>
                            <span className='bg-divider h-px flex-1' />
                        </div>
                    )}
                </>
            )}

            {showPasswordForm && (
                <form onSubmit={submit} className='space-y-4'>
                    <label className='block space-y-1.5'>
                        <span className='text-ui text-fg font-medium'>
                            {t('web.auth.emailLabel')}
                        </span>
                        <input
                            type='email'
                            required
                            autoComplete='email'
                            value={email}
                            disabled={pendingVerification || emailLocked}
                            onChange={(event) => setEmail(event.target.value)}
                            className='workbench-input h-10 w-full'
                        />
                    </label>

                    {(mode === 'reset' || pendingVerification) && (
                        <label className='block space-y-1.5'>
                            <span className='text-ui text-fg font-medium'>
                                {t('web.auth.verificationCodeLabel')}
                            </span>
                            <input
                                type='text'
                                required
                                inputMode='numeric'
                                autoComplete='one-time-code'
                                value={verificationCode}
                                onChange={(event) =>
                                    setVerificationCode(event.target.value)
                                }
                                className='workbench-input h-10 w-full'
                            />
                        </label>
                    )}

                    {mode !== 'forgot' && !pendingVerification && (
                        <label className='block space-y-1.5'>
                            <span className='text-ui text-fg font-medium'>
                                {mode === 'reset'
                                    ? t('web.auth.newPasswordLabel')
                                    : t('web.auth.passwordLabel')}
                            </span>
                            <input
                                type='password'
                                required
                                autoComplete={
                                    mode === 'sign-in'
                                        ? 'current-password'
                                        : 'new-password'
                                }
                                value={password}
                                onChange={(event) =>
                                    setPassword(event.target.value)
                                }
                                className='workbench-input h-10 w-full'
                            />
                        </label>
                    )}

                    {notice && (
                        <p className='text-ui border-divider bg-surface-hover text-muted rounded-md border px-3 py-2'>
                            {notice}
                        </p>
                    )}
                    {error && (
                        <p className='text-ui rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700'>
                            {error}
                        </p>
                    )}

                    <button
                        type='submit'
                        disabled={submitting}
                        className='workbench-button-primary h-10 w-full justify-center px-4 disabled:cursor-not-allowed disabled:opacity-60'
                    >
                        {submitting ? t('web.auth.pleaseWait') : cta}
                    </button>
                </form>
            )}

            {netmindOpen && (
                <NetmindSignInDialog
                    title={t('web.auth.continueWithNetmind')}
                    submitLabel={t('web.auth.continueWithNetmind')}
                    onToken={netmindLogin}
                    onClose={() => setNetmindOpen(false)}
                />
            )}

            {mode === 'sign-in' && methods.password && (
                <button
                    type='button'
                    onClick={() => goMode('forgot')}
                    className='text-ui text-link hover:text-link-hover mt-4 w-full text-center font-medium'
                >
                    {t('web.auth.forgotPasswordCta')}
                </button>
            )}

            {mode === 'sign-up' && pendingVerification && (
                <button
                    type='button'
                    onClick={() => void resend()}
                    className='text-ui text-link hover:text-link-hover mt-4 w-full text-center font-medium'
                >
                    {t('web.auth.resendCodeCta')}
                </button>
            )}

            {!lockMode && methods.password && (
                <button
                    type='button'
                    onClick={() =>
                        goMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
                    }
                    className='text-ui text-link hover:text-link-hover mt-4 w-full text-center font-medium'
                >
                    {mode === 'sign-in'
                        ? t('web.auth.createAccount')
                        : mode === 'sign-up'
                          ? t('web.auth.useExistingAccount')
                          : t('web.auth.backToSignIn')}
                </button>
            )}
        </div>
    )
}

const apiBase = (): string =>
    (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

class AuthError extends Error {
    code: string
    constructor(code: string, message: string) {
        super(message)
        this.code = code
    }
}

const postAuth = async <T,>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${apiBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    const data = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string }
    } | null
    if (!res.ok) {
        const err = data?.error
        throw new AuthError(
            err?.code ?? 'error',
            err?.message ?? `${res.status} ${res.statusText}`
        )
    }
    return data as T
}

interface AuthFragment {
    token?: string
    error?: string
    nmtoken?: string
}

const parseAuthFragment = (): AuthFragment => {
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return {}
    const params = new URLSearchParams(hash)
    return {
        token: params.get('session') ?? undefined,
        error: params.get('error') ?? undefined,
        // NarraNexus → Manyfold hand-off: a NetMind loginToken to exchange for a
        // session. In the fragment (not the query) so it never hits server logs.
        nmtoken: params.get('nmtoken') ?? undefined
    }
}

const scrubFragment = (): void => {
    window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.search
    )
}


const authErrorMessage = (error: unknown): string => {
    if (error instanceof AuthError) return error.message
    if (error instanceof Error) return error.message
    return t('web.auth.errorAuthFailed')
}

const fetchAuthConfig = async (): Promise<PublicAuthConfig> => {
    const res = await fetch(`${apiBase()}${apiPaths.AUTH_CONFIG}`)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`${res.status} ${res.statusText}: ${text}`)
    }
    return res.json() as Promise<PublicAuthConfig>
}

const AuthShellMessage: FC<{ title: string; body: string }> = ({
    title,
    body
}) => (
    <div className='login-shell text-fg flex min-h-screen items-center justify-center p-5'>
        <div className='shadow-card border-divider bg-surface w-full max-w-sm rounded-md border p-6'>
            <h1 className='text-fg text-h2'>{title}</h1>
            <p className='text-muted mt-2 text-sm'>{body}</p>
        </div>
    </div>
)

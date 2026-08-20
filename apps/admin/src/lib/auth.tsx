import {
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
import { clearSession, getSession, storeSession } from '@/lib/session'
import { adminRoutes } from '@/routes'

type AuthProviderKind = 'native'

type AuthMethods = { password: boolean; google: boolean; oidc: boolean }

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
    oidcButtonLabel?: string | null
    oauthError?: string | null
    getToken: () => Promise<string>
    signIn: (redirectUrl?: string) => void
    signOut: (opts?: SignOutOptions) => void
    refreshConfig: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const AppAuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
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

    if (error)
        return (
            <AuthShellMessage
                title='Authentication unavailable'
                body={error}
            />
        )

    if (!config)
        return (
            <AuthShellMessage
                title='Loading authentication'
                body='Preparing login configuration...'
            />
        )

    if (!config.configured)
        return (
            <UnconfiguredAuthProvider refreshConfig={refreshConfig}>
                {children}
            </UnconfiguredAuthProvider>
        )

    return (
        <NativeAuthProvider config={config} refreshConfig={refreshConfig}>
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

export const AuthSignIn: FC<{
    redirectUrl: string
    path?: string
    appearance?: unknown
}> = ({ redirectUrl }) => {
    const auth = useAppAuth()
    if (auth.setupRequired)
        return (
            <div className='border-border shadow-elevated w-full rounded-lg border bg-white p-6'>
                <div className='space-y-1'>
                    <h1 className='text-h3 text-heading font-light tracking-tight'>
                        Setup required
                    </h1>
                    <p className='text-caption text-body'>
                        Configure a login provider before signing in.
                    </p>
                </div>
                <button
                    type='button'
                    className='bg-brand text-caption hover:bg-brand-hover mt-4 inline-flex h-10 w-full items-center justify-center rounded px-4 font-medium text-white transition-colors'
                    onClick={() =>
                        window.location.assign(adminRoutes.setup)
                    }
                >
                    Open setup
                </button>
            </div>
        )
    return <NativeCredentialForm redirectUrl={redirectUrl} />
}

export const AuthUserButton: FC = () => {
    const auth = useAppAuth()
    const label = auth.user?.email || auth.user?.id || 'Account'
    return (
        <button
            type='button'
            className='text-caption text-heading hover:bg-surface-muted inline-flex h-8 max-w-48 items-center gap-2 rounded px-2.5 font-normal transition-colors'
            onClick={() =>
                auth.signOut({ redirectUrl: adminRoutes.login })
            }
            title='Sign out'
        >
            <AuthAvatar label={label} className='h-5 w-5 text-[0.65rem]' />
            <span className='min-w-0 truncate'>{label}</span>
        </button>
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
                window.location.assign(adminRoutes.setup)
            },
            signOut: () => {},
            refreshConfig
        }),
        [refreshConfig]
    )
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

const NativeAuthProvider: FC<{
    children: ReactNode
    config: Extract<PublicAuthConfig, { configured: true }>
    refreshConfig: () => Promise<void>
}> = ({ children, config, refreshConfig }) => {
    const [user, setUser] = useState<AuthUser | null>(null)
    const [isSignedIn, setIsSignedIn] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [oauthError, setOauthError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        const boot = async (): Promise<void> => {
            const fragment = parseAuthFragment()
            if (fragment.token) {
                storeSession(fragment.token)
                scrubFragment()
            }
            if (fragment.error) {
                setOauthError('Sign-in could not be completed. Try again.')
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
            try {
                const res = await fetch(`${apiBase()}${apiPaths.AUTH_ME}`, {
                    headers: { Authorization: `Bearer ${token}` }
                })
                if (!res.ok) throw new Error(String(res.status))
                const data = (await res.json()) as {
                    id?: string
                    email?: string
                }
                if (cancelled) return
                setUser({ id: data.id ?? null, email: data.email ?? null })
                setIsSignedIn(true)
                setLoaded(true)
            } catch {
                clearSession()
                if (!cancelled) {
                    setIsSignedIn(false)
                    setLoaded(true)
                }
            }
        }
        void boot()
        return () => {
            cancelled = true
        }
    }, [])

    const value = useMemo<AuthContextValue>(
        () => ({
            provider: 'native',
            isLoaded: loaded,
            isSignedIn,
            setupRequired: false,
            sessionKey: user?.id ?? null,
            user,
            methods: config.methods,
            oidcButtonLabel: config.oidcButtonLabel,
            oauthError,
            getToken: async () => getSession() ?? '',
            signIn: (redirectUrl = adminRoutes.dashboard) => {
                window.location.assign(
                    `${adminRoutes.login}?redirect_url=${encodeURIComponent(redirectUrl)}`
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
                window.location.assign(
                    opts?.redirectUrl ?? adminRoutes.login
                )
            },
            refreshConfig
        }),
        [loaded, isSignedIn, user, config, oauthError, refreshConfig]
    )
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

type FormMode = 'sign-in' | 'forgot' | 'reset'

const NativeCredentialForm: FC<{ redirectUrl: string }> = ({ redirectUrl }) => {
    const auth = useAppAuth()
    const methods = auth.methods ?? {
        password: true,
        google: false,
        oidc: false
    }
    const [mode, setMode] = useState<FormMode>('sign-in')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [verificationCode, setVerificationCode] = useState('')
    const [error, setError] = useState<string | null>(auth.oauthError ?? null)
    const [notice, setNotice] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)

    const completeSession = (res: AuthSessionResponse): void => {
        storeSession(res.token)
        window.location.assign(safeRedirect(redirectUrl) ?? '/')
    }

    // OAuth is brokered server-side and lands back on THIS app's /login via the
    // `#session=` fragment, so we pass our absolute origin as redirect_url.
    const startOauth = (provider: 'google' | 'oidc'): void => {
        const path =
            provider === 'google'
                ? apiPaths.AUTH_OAUTH_GOOGLE_START
                : apiPaths.AUTH_OAUTH_OIDC_START
        const back = `${window.location.origin}/`
        window.location.href = `${apiBase()}${path}?redirect_url=${encodeURIComponent(
            back
        )}`
    }

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault()
        setSubmitting(true)
        setError(null)
        setNotice(null)
        try {
            if (mode === 'sign-in') {
                completeSession(
                    await postAuth<AuthSessionResponse>(apiPaths.AUTH_LOGIN, {
                        email: email.trim(),
                        password
                    })
                )
                return
            }
            if (mode === 'forgot') {
                await postAuth(apiPaths.AUTH_FORGOT_PASSWORD, {
                    email: email.trim()
                })
                setMode('reset')
                setNotice('We sent a reset code to your email.')
                return
            }
            completeSession(
                await postAuth<AuthSessionResponse>(
                    apiPaths.AUTH_RESET_PASSWORD,
                    {
                        email: email.trim(),
                        code: verificationCode.trim(),
                        password
                    }
                )
            )
        } catch (err) {
            setError(authErrorMessage(err))
        } finally {
            setSubmitting(false)
        }
    }

    const goMode = (next: FormMode): void => {
        setMode(next)
        setError(null)
        setNotice(null)
        setVerificationCode('')
        setPassword('')
    }

    const title =
        mode === 'forgot'
            ? 'Reset your password'
            : mode === 'reset'
              ? 'Set a new password'
              : 'Sign in'
    const subtitle =
        mode === 'forgot'
            ? 'Enter your email and we will send a reset code.'
            : mode === 'reset'
              ? 'Enter the code from your email and a new password.'
              : 'Use your admin account.'
    const cta =
        mode === 'forgot'
            ? 'Send reset code'
            : mode === 'reset'
              ? 'Update password'
              : 'Sign in'

    return (
        <div className='border-border shadow-elevated w-full rounded-lg border bg-white p-6'>
            {mode === 'sign-in' && (methods.google || methods.oidc) && (
                <>
                    {methods.google && (
                        <button
                            type='button'
                            disabled={submitting}
                            onClick={() => startOauth('google')}
                            className='border-border text-caption text-heading hover:bg-surface-muted mb-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded border bg-white px-4 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                        >
                            <span
                                aria-hidden='true'
                                className='inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-sm font-semibold text-[#4285f4]'
                            >
                                G
                            </span>
                            Continue with Google
                        </button>
                    )}
                    {methods.oidc && (
                        <button
                            type='button'
                            disabled={submitting}
                            onClick={() => startOauth('oidc')}
                            className='border-border text-caption text-heading hover:bg-surface-muted mb-4 inline-flex h-10 w-full items-center justify-center rounded border bg-white px-4 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                        >
                            {auth.oidcButtonLabel || 'Continue with SSO'}
                        </button>
                    )}
                    {methods.password && (
                        <div className='border-border mb-4 border-t' />
                    )}
                </>
            )}

            {!methods.password && error && (
                <p className='text-caption rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700'>
                    {error}
                </p>
            )}

            {methods.password && (
            <form onSubmit={submit} className='space-y-4'>
                <div className='space-y-1'>
                    <h1 className='text-h3 text-heading font-light tracking-tight'>
                        {title}
                    </h1>
                    <p className='text-caption text-body'>{subtitle}</p>
                </div>

                <label className='block space-y-1.5'>
                    <span className='text-caption text-heading font-medium'>
                        Email
                    </span>
                    <input
                        type='email'
                        required
                        autoComplete='email'
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        className='border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-3 transition-colors focus:ring-1 focus:outline-none'
                    />
                </label>

                {mode === 'reset' && (
                    <label className='block space-y-1.5'>
                        <span className='text-caption text-heading font-medium'>
                            Verification code
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
                            className='border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-3 transition-colors focus:ring-1 focus:outline-none'
                        />
                    </label>
                )}

                {mode !== 'forgot' && (
                    <label className='block space-y-1.5'>
                        <span className='text-caption text-heading font-medium'>
                            {mode === 'reset' ? 'New password' : 'Password'}
                        </span>
                        <input
                            type='password'
                            required
                            autoComplete={
                                mode === 'reset'
                                    ? 'new-password'
                                    : 'current-password'
                            }
                            value={password}
                            onChange={(event) =>
                                setPassword(event.target.value)
                            }
                            className='border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-3 transition-colors focus:ring-1 focus:outline-none'
                        />
                    </label>
                )}

                {notice && (
                    <p className='text-caption border-border text-body rounded border bg-gray-50 px-3 py-2'>
                        {notice}
                    </p>
                )}
                {error && (
                    <p className='text-caption rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700'>
                        {error}
                    </p>
                )}

                <button
                    type='submit'
                    disabled={submitting}
                    className='bg-brand text-caption hover:bg-brand-hover inline-flex h-10 w-full items-center justify-center rounded px-4 font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                >
                    {submitting ? 'Please wait...' : cta}
                </button>
            </form>
            )}

            {methods.password && (
                <button
                    type='button'
                    onClick={() =>
                        goMode(mode === 'sign-in' ? 'forgot' : 'sign-in')
                    }
                    className='text-caption text-brand hover:text-brand-hover mt-4 w-full text-center font-medium'
                >
                    {mode === 'sign-in' ? 'Forgot password?' : 'Back to sign in'}
                </button>
            )}
        </div>
    )
}

const apiBase = (): string =>
    (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

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
    const data = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null
    if (!res.ok) {
        const err = data?.error
        throw new AuthError(
            err?.code ?? 'error',
            err?.message ?? `${res.status} ${res.statusText}`
        )
    }
    return data as T
}

const safeRedirect = (value: string | null | undefined): string | null => {
    if (!value) return null
    if (!value.startsWith('/') || value.startsWith('//')) return null
    return value
}

const parseAuthFragment = (): { token?: string; error?: string } => {
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return {}
    const params = new URLSearchParams(hash)
    return {
        token: params.get('session') ?? undefined,
        error: params.get('error') ?? undefined
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
    if (error instanceof Error) return error.message
    return 'Authentication failed'
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
    <div className='flex min-h-screen items-center justify-center bg-white p-4'>
        <div className='border-border shadow-elevated w-full max-w-sm rounded-lg border bg-white p-6'>
            <h1 className='text-h3 text-heading font-light tracking-tight'>
                {title}
            </h1>
            <p className='text-caption text-body mt-2'>{body}</p>
        </div>
    </div>
)

const AuthAvatar: FC<{
    label: string
    className?: string
}> = ({ label, className }) => {
    const fallback = label.trim().charAt(0).toUpperCase() || 'A'
    return (
        <span
            aria-hidden='true'
            className={[
                'bg-brand-subtle text-brand inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium',
                className ?? ''
            ].join(' ')}
        >
            {fallback}
        </span>
    )
}
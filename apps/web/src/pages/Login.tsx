import { useEffect, type FC, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { BrandMark } from '@/components/Brand'
import { PreferenceControls } from '@/components/PreferenceControls'
import { AuthSignIn, SignedIn, useAppAuth } from '@/lib/auth'
import { useI18n } from '@/lib/i18n'

const isAbsoluteUrl = (value: string): boolean => /^https?:\/\//i.test(value)

const isDashboardUrl = (value: string): boolean => {
    try {
        const url = new URL(value)
        return /-dashboard\.manyfold\.ai$/i.test(url.hostname)
    } catch {
        return false
    }
}

const apiBase = (): string =>
    (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '')

// Plant an apex-scoped `mf_dashboard` cookie so the dashboard
// subdomain's nginx auth-url subrequest succeeds — the session token
// itself lives in localStorage, which subdomains can't read.
const mintDashboardTicket = async (
    rd: string,
    token: string
): Promise<boolean> => {
    try {
        const res = await fetch(
            `${apiBase()}/agent-runtimes/dashboard-ticket`,
            {
                method: 'POST',
                credentials: 'include',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ rd })
            }
        )
        return res.ok
    } catch {
        return false
    }
}

const LOOP_GUARD_KEY = '__mf_dashboard_bounce'
const LOOP_GUARD_TTL_MS = 10_000

const ExternalRedirect: FC<{ to: string }> = ({ to }) => {
    const auth = useAppAuth()
    useEffect(() => {
        let recentlyBounced = false
        try {
            const raw = window.sessionStorage.getItem(LOOP_GUARD_KEY)
            if (raw) {
                const prev = JSON.parse(raw) as {
                    url?: string
                    at?: number
                }
                if (
                    prev.url === to &&
                    typeof prev.at === 'number' &&
                    Date.now() - prev.at < LOOP_GUARD_TTL_MS
                )
                    recentlyBounced = true
            }
            window.sessionStorage.setItem(
                LOOP_GUARD_KEY,
                JSON.stringify({ url: to, at: Date.now() })
            )
        } catch {}
        if (recentlyBounced) {
            window.location.assign('/workspace')
            return
        }
        if (!isDashboardUrl(to)) {
            window.location.assign(to)
            return
        }
        void (async () => {
            const token = await auth.getToken()
            if (!token) {
                window.location.assign(to)
                return
            }
            const ok = await mintDashboardTicket(to, token)
            window.location.assign(ok ? to : '/workspace')
        })()
    }, [to, auth])
    return null
}

const Login: FC = (): ReactNode => {
    const { t } = useI18n()
    const [params] = useSearchParams()
    // Prefer the `rd` parameter (auto-appended by nginx-ingress when the
    // dashboard auth-signin redirect fires) since it carries the full
    // origin (e.g. `https://agent-<id>-dashboard.manyfold.ai/`); fall back
    // to `redirect_url` for in-app flows that only pass an internal path.
    const redirectUrl =
        safeRedirect(params.get('rd')) ??
        safeRedirect(params.get('redirect_url')) ??
        '/workspace'
    // Invite-redemption links land here pre-marked for sign-up with the
    // invited email locked in; everyone else gets the plain sign-in form.
    const isInvite = params.get('invite') === 'true'
    const inviteEmail = params.get('email')?.trim() || undefined

    return (
        <div className='login-shell text-fg flex min-h-screen flex-col px-5 py-5 md:px-8'>
            <SignedIn>
                {isAbsoluteUrl(redirectUrl) ? (
                    <ExternalRedirect to={redirectUrl} />
                ) : (
                    <Navigate to={redirectUrl} replace />
                )}
            </SignedIn>

            <header className='mx-auto flex w-full max-w-5xl items-center justify-between gap-3'>
                <Link
                    to='/'
                    aria-label={t('common.appName')}
                    className='text-fg inline-flex items-center gap-1 text-[19px] font-medium tracking-[-0.015em] transition-opacity hover:opacity-80'
                >
                    <BrandMark className='block h-7 w-auto' />
                    <span>{t('common.appName')}</span>
                </Link>
                <PreferenceControls />
            </header>

            <main className='flex flex-1 items-center justify-center py-10'>
                <div className='w-full max-w-[28rem]'>
                    <AuthSignIn
                        path='/login'
                        redirectUrl={redirectUrl}
                        initialMode={isInvite ? 'sign-up' : 'sign-in'}
                        lockMode={isInvite}
                        prefillEmail={inviteEmail}
                    />
                </div>
            </main>
        </div>
    )
}

const safeRedirect = (value: string | null): string | null => {
    if (!value) return null
    if (value.startsWith('/') && !value.startsWith('//')) return value
    // Allow absolute URLs that point at a sibling subdomain under our zone
    // (e.g. Hermes dashboard at agent-<id>-dashboard.manyfold.ai) so the
    // nginx auth-signin redirect's `rd` parameter round-trips. Anything
    // else is rejected to avoid an open redirect.
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        const host = url.hostname
        if (host !== 'manyfold.ai' && !host.endsWith('.manyfold.ai'))
            return null
        if (url.protocol === 'http:') url.protocol = 'https:'
        return url.toString()
    } catch {
        return null
    }
}

export default Login

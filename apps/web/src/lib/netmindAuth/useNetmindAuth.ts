import { useCallback, useEffect, useState } from 'react'
import { baseRequestParams } from './constants'
import { getNetmindConfig } from './config'
import { encryptPassword, generateRandomString } from './crypto'
import { netmindPost } from './request'
import type { AuthBindInfo, NetmindLoginPayload } from './types'

type OAuthType = 'GOOGLE' | 'MICROSOFT' | 'GITHUB'

interface Options {
    // Called with a verified NetMind loginToken. The caller exchanges it — for
    // login by trading it for a session, for binding by linking the identity.
    onToken: (loginToken: string) => Promise<void> | void
}

// NetMind credential orchestration: email/password and OAuth (popup +
// postMessage) both converge on a loginToken handed to onToken. Shared by the
// login page (Surface A) and the Account "Connect NetMind" card. Mirrors
// NarraNexus's useNetmindAuth but never mints a session itself.
export const useNetmindAuth = ({ onToken }: Options) => {
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [bindInfo, setBindInfo] = useState<AuthBindInfo | null>(null)

    const emailLogin = useCallback(
        async (email: string, password: string) => {
            setLoading(true)
            setError('')
            try {
                const signStr = generateRandomString()
                const data = await netmindPost<NetmindLoginPayload>(
                    '/user/emailLogin',
                    {
                        ...baseRequestParams(),
                        email,
                        password: encryptPassword(password, signStr),
                        signStr,
                        ckType: 2
                    }
                )
                if (!data.loginToken) throw new Error('Login failed')
                await onToken(data.loginToken)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Login failed')
            } finally {
                setLoading(false)
            }
        },
        [onToken]
    )

    const startOAuth = useCallback((type: OAuthType) => {
        const { accountsUrl, authApi } = getNetmindConfig()
        sessionStorage.setItem('nm-oauth-type', type)
        window.open(
            `${accountsUrl}/auth.html?authApi=${authApi}/user/loginMsg/${type}`,
            '',
            'popup=1,width=600,height=650'
        )
    }, [])

    const handleAuthCallback = useCallback(
        async (code: string, state: string) => {
            setLoading(true)
            setError('')
            try {
                const data = await netmindPost<
                    NetmindLoginPayload & AuthBindInfo
                >('/user/userCallBack', {
                    ...baseRequestParams(),
                    authCallbackStr: JSON.stringify({ code, state }),
                    oauthType: sessionStorage.getItem('nm-oauth-type') || ''
                })
                if (data.loginToken) await onToken(data.loginToken)
                else setBindInfo(data as AuthBindInfo)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'OAuth failed')
            } finally {
                setLoading(false)
            }
        },
        [onToken]
    )

    const submitBind = useCallback(
        async (extra: { email?: string; verifyCode?: string } = {}) => {
            if (!bindInfo) return
            setLoading(true)
            setError('')
            try {
                const params: Record<string, unknown> = {
                    ...baseRequestParams(),
                    bandType: bindInfo.bandType,
                    identifyCode: bindInfo.identifyCode,
                    email: bindInfo.thirdEmail || bindInfo.canBandEmail
                }
                if (bindInfo.bandType === 1) {
                    params.email = extra.email
                    params.verifyCode = extra.verifyCode
                }
                const data = await netmindPost<NetmindLoginPayload>(
                    '/user/userCallBack',
                    params
                )
                if (!data.loginToken) throw new Error('Bind failed')
                setBindInfo(null)
                await onToken(data.loginToken)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Bind failed')
            } finally {
                setLoading(false)
            }
        },
        [bindInfo, onToken]
    )

    const closeBind = useCallback(() => setBindInfo(null), [])

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            // Only trust messages from the NetMind accounts popup origin — a
            // forged postMessage from any other window must not drive the OAuth
            // callback (which would let an attacker inject code/state).
            let expectedOrigin = ''
            try {
                const { accountsUrl } = getNetmindConfig()
                expectedOrigin = accountsUrl ? new URL(accountsUrl).origin : ''
            } catch {
                expectedOrigin = ''
            }
            if (!expectedOrigin || event.origin !== expectedOrigin) return
            if (
                event.data?.type === 'auth' &&
                event.data.code &&
                event.data.state
            )
                void handleAuthCallback(event.data.code, event.data.state)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
    }, [handleAuthCallback])

    return {
        loading,
        error,
        bindInfo,
        emailLogin,
        startOAuth,
        submitBind,
        closeBind,
        setError
    }
}
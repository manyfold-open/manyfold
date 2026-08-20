import { ApiError } from '@manyfold/sdk'
import {
    isGrantableScope,
    type CliLoginPollResponse,
    type GrantableScope
} from '@manyfold/shared'
import {
    clearPendingLogin,
    loadPendingLogin,
    saveConfig,
    type PendingLogin
} from '@/config'
import { createCliClient } from '@/transport'

export type ResumeResult =
    | {
          status: 'completed'
          token: string
          scopes: GrantableScope[]
          userEmail: string | null
      }
    | { status: 'pending'; pending: PendingLogin }
    | { status: 'expired' }
    | { status: 'none' }

export const resumePendingLogin = async (
    apiUrl: string,
    pollFn?: (deviceCode: string) => Promise<CliLoginPollResponse>,
    nowFn: () => number = () => Date.now()
): Promise<ResumeResult> => {
    const pending = await loadPendingLogin()
    if (!pending) return { status: 'none' }
    if (pending.apiUrl !== apiUrl) return { status: 'none' }
    if (new Date(pending.expiresAt).getTime() <= nowFn()) {
        await clearPendingLogin()
        return { status: 'expired' }
    }

    const poll =
        pollFn ??
        ((deviceCode: string) => {
            const client = createCliClient({ baseUrl: apiUrl })
            return client.auth.pollCliLogin({ deviceCode })
        })

    let res: CliLoginPollResponse
    try {
        res = await poll(pending.deviceCode)
    } catch (error) {
        if (isNotFoundError(error)) {
            await clearPendingLogin()
            return { status: 'expired' }
        }
        throw error
    }

    if (res.status === 'approved') {
        await saveConfig({ apiUrl, token: res.token })
        await clearPendingLogin()
        return {
            status: 'completed',
            token: res.token,
            scopes: res.scopes.filter(isGrantableScope),
            userEmail: res.userEmail
        }
    }
    if (res.status === 'expired') {
        await clearPendingLogin()
        return { status: 'expired' }
    }
    return { status: 'pending', pending }
}

const isNotFoundError = (error: unknown): boolean =>
    (error instanceof ApiError && error.status === 404) ||
    (error instanceof Error && /^404\b/.test(error.message))

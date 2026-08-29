import type { ApiTokenSummary } from '@manyfold/shared'

export type ApiTokenStatus = 'active' | 'expired' | 'revoked'

// Revocation wins over expiry: a token that was revoked and has since passed
// its expiry is still, to the person reading the list, a token they revoked.
export const apiTokenStatus = (
    token: Pick<ApiTokenSummary, 'revokedAt' | 'expiresAt'>,
    now: Date = new Date()
): ApiTokenStatus => {
    if (token.revokedAt) return 'revoked'
    if (token.expiresAt && new Date(token.expiresAt) <= now) return 'expired'
    return 'active'
}

export const API_TOKEN_STATUS_DOT: Record<ApiTokenStatus, string> = {
    active: 'bg-success',
    expired: 'bg-warning',
    revoked: 'bg-idle'
}

export const apiTokenStatusLabelKey = (status: ApiTokenStatus): string =>
    status === 'revoked'
        ? 'web.apiTokens.statusRevoked'
        : status === 'expired'
          ? 'web.apiTokens.statusExpired'
          : 'web.apiTokens.statusActive'

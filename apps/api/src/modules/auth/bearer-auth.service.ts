import { Injectable, UnauthorizedException } from '@nestjs/common'
import { type AuthPrincipal } from './auth-principal'
import { ApiTokenService, isApiToken } from './api-token.service'
import { AuthService } from './auth.service'
import { SessionService, isSessionToken } from './session.service'

@Injectable()
export class BearerAuthService {
    constructor(
        private readonly apiTokens: ApiTokenService,
        private readonly sessions: SessionService,
        private readonly auth: AuthService
    ) {}

    async verifyBearerToken(token: string): Promise<AuthPrincipal> {
        // `nca_` api/runtime tokens short-circuit first (machine credentials),
        // then `mfs_` human session tokens. Anything else — including a stale
        // Clerk JWT from before the native-auth cutover — is rejected so the
        // browser re-authenticates.
        if (isApiToken(token)) return this.apiTokens.verify(token)
        if (isSessionToken(token)) {
            const principal = await this.sessions.verify(token)
            if (!principal)
                throw new UnauthorizedException('invalid or expired session')
            return principal
        }
        throw new UnauthorizedException('invalid bearer token')
    }

    async getUserEmail(userId: string): Promise<string | undefined> {
        const local = await this.auth.getUser(userId)
        return local?.email ?? undefined
    }
}

import { SetMetadata } from '@nestjs/common'

export const REQUIRE_AUTH_SESSION_META = 'require_auth_session'

export const RequireAuthSession = (): MethodDecorator =>
    SetMetadata(REQUIRE_AUTH_SESSION_META, true)

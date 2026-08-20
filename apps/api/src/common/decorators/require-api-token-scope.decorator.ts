import type { ApiTokenScope } from '@manyfold/shared'
import { SetMetadata } from '@nestjs/common'

export const REQUIRED_API_TOKEN_SCOPES_META = 'required_api_token_scopes'

export const RequireApiTokenScope = (
    ...scopes: ApiTokenScope[]
): MethodDecorator => SetMetadata(REQUIRED_API_TOKEN_SCOPES_META, scopes)

import { runtimeProviderKinds, type RuntimeProviderKind } from '@manyfold/shared'
import {
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Length,
    Matches,
    Max,
    Min
} from 'class-validator'

export class CreateRuntimeProviderDto {
    @IsIn(runtimeProviderKinds)
    kind!: RuntimeProviderKind

    @IsString()
    @Length(1, 64)
    @Matches(/^[a-z0-9][a-z0-9_.-]*$/i)
    name!: string

    // A sprites `<orgSlug>/<orgId>/<tokenId>/<tokenValue>` credential or a
    // kubeconfig; encrypted server-side, never returned.
    @IsString()
    @Length(16, 65_536)
    credential!: string

    @IsOptional()
    @IsString()
    @Length(0, 64)
    region?: string

    @IsOptional()
    @IsInt()
    @Min(-1000)
    @Max(1000)
    priority?: number

    @IsOptional()
    @IsObject()
    config?: Record<string, unknown>
}

export class UpdateRuntimeProviderDto {
    @IsOptional()
    @IsString()
    @Length(1, 64)
    @Matches(/^[a-z0-9][a-z0-9_.-]*$/i)
    name?: string

    @IsOptional()
    @IsIn(['enabled', 'disabled'])
    status?: 'enabled' | 'disabled'

    @IsOptional()
    @IsInt()
    @Min(-1000)
    @Max(1000)
    priority?: number

    @IsOptional()
    @IsString()
    @Length(0, 64)
    region?: string | null

    @IsOptional()
    @IsObject()
    config?: Record<string, unknown>

    @IsOptional()
    @IsString()
    @Length(16, 65_536)
    credential?: string
}

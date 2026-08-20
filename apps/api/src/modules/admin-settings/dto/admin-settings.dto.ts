import type {
    AgentFramework,
    BuiltinSkillRepoInput,
    ConfigurableFrameworkRuntimeDefault,
    FeatureToggleKey,
    FrameworkBlockedVersionRange,
    FrameworkRuntimeChoice,
    UpdateA2aTurnTimeoutsSettingsBody,
    UpdateAutomationRetentionSettingsBody,
    UpdateBuiltinSkillReposSettingsBody,
    UpdateChatExecTimeoutsSettingsBody,
    UpdateCliMinimumVersionSettingsBody,
    UpdateFeatureToggleBody,
    UpdateFrameworkDefaultVersionsSettingsBody,
    UpdateFrameworkRuntimeDefaultsSettingsBody,
    UpdateSpritesWholesaleCapSettingsBody
} from '@manyfold/shared'
import { Type } from 'class-transformer'
import {
    IsArray,
    IsBoolean,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Max,
    Min,
    ValidateIf,
    ValidateNested
} from 'class-validator'

export class UpdateSpritesWholesaleCapSettingsDto implements UpdateSpritesWholesaleCapSettingsBody {
    @IsInt()
    @Min(1)
    activeCap!: number

    @IsInt()
    @Min(1)
    @Max(99)
    softThresholdPct!: number
}

export class UpdateAutomationRetentionSettingsDto implements UpdateAutomationRetentionSettingsBody {
    @IsInt()
    @Min(1)
    @Max(3650)
    retentionDays!: number
}

export class UpdateChatExecTimeoutsSettingsDto implements UpdateChatExecTimeoutsSettingsBody {
    @IsInt()
    @Min(1)
    keepAliveSeconds!: number

    @IsInt()
    @Min(1)
    livenessTimeoutSeconds!: number

    @IsInt()
    @Min(0)
    maxTimeoutSeconds!: number
}

export class UpdateA2aTurnTimeoutsSettingsDto implements UpdateA2aTurnTimeoutsSettingsBody {
    @IsInt()
    @Min(1)
    blockingTimeoutSeconds!: number

    @IsInt()
    @Min(1)
    asyncTimeoutSeconds!: number
}

export class BuiltinSkillRepoInputDto implements BuiltinSkillRepoInput {
    @IsString()
    owner!: string

    @IsString()
    name!: string

    @IsOptional()
    @IsString()
    branch?: string

    @IsOptional()
    @IsBoolean()
    enabled?: boolean
}

export class UpdateBuiltinSkillReposSettingsDto implements UpdateBuiltinSkillReposSettingsBody {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BuiltinSkillRepoInputDto)
    repos!: BuiltinSkillRepoInputDto[]
}

export class UpdateCliMinimumVersionSettingsDto implements UpdateCliMinimumVersionSettingsBody {
    @ValidateIf((_, value) => value !== null)
    @IsString()
    minVersion!: string | null
}

export class UpdateFrameworkRuntimeDefaultsSettingsDto implements UpdateFrameworkRuntimeDefaultsSettingsBody {
    @IsObject()
    defaults!: Record<
        ConfigurableFrameworkRuntimeDefault,
        FrameworkRuntimeChoice
    >
}

export class UpdateFrameworkDefaultVersionsSettingsDto implements UpdateFrameworkDefaultVersionsSettingsBody {
    @IsObject()
    defaults!: Partial<Record<AgentFramework, string>>

    @IsObject()
    @IsOptional()
    minVersions?: Partial<Record<AgentFramework, string>>

    @IsObject()
    @IsOptional()
    allowDowngrade?: Partial<Record<AgentFramework, boolean>>

    @IsObject()
    @IsOptional()
    blockedVersions?: Partial<
        Record<AgentFramework, FrameworkBlockedVersionRange[]>
    >

    @IsObject()
    @IsOptional()
    sourceRepos?: Partial<Record<AgentFramework, string>>

    @IsObject()
    @IsOptional()
    allowPrerelease?: Partial<Record<AgentFramework, boolean>>
}

export class UpdateFeatureToggleDto implements UpdateFeatureToggleBody {
    @IsString()
    key!: FeatureToggleKey

    @IsBoolean()
    enabled!: boolean
}

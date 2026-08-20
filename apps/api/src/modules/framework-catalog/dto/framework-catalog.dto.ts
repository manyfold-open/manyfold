import {
    IsBoolean,
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    Min
} from 'class-validator'
import {
    frameworkEnumKeys,
    frameworkModelKinds,
    type FrameworkModelCapabilitiesView
} from '@/modules/framework-catalog/framework-catalog.types'

export class CreateFrameworkModelDto {
    @IsString()
    @MaxLength(255)
    modelKey!: string

    @IsIn(frameworkModelKinds)
    kind!: 'model' | 'alias'

    @IsString()
    @MaxLength(255)
    displayName!: string

    @IsOptional()
    @IsObject()
    capabilities?: FrameworkModelCapabilitiesView

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number

    @IsOptional()
    @IsBoolean()
    isActive?: boolean

    @IsOptional()
    @IsBoolean()
    isDefault?: boolean
}

export class UpdateFrameworkModelDto {
    @IsOptional()
    @IsString()
    @MaxLength(255)
    modelKey?: string

    @IsOptional()
    @IsIn(frameworkModelKinds)
    kind?: 'model' | 'alias'

    @IsOptional()
    @IsString()
    @MaxLength(255)
    displayName?: string

    @IsOptional()
    @IsObject()
    capabilities?: FrameworkModelCapabilitiesView

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number

    @IsOptional()
    @IsBoolean()
    isActive?: boolean

    @IsOptional()
    @IsBoolean()
    isDefault?: boolean
}

export class CreateFrameworkEnumDto {
    @IsIn(frameworkEnumKeys)
    enumKey!: 'effort' | 'speed' | 'intelligence'

    @IsString()
    @MaxLength(255)
    value!: string

    @IsString()
    @MaxLength(255)
    displayName!: string

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number

    @IsOptional()
    @IsBoolean()
    isActive?: boolean

    @IsOptional()
    @IsBoolean()
    isDefault?: boolean
}

export class UpdateFrameworkEnumDto {
    @IsOptional()
    @IsString()
    @MaxLength(255)
    value?: string

    @IsOptional()
    @IsString()
    @MaxLength(255)
    displayName?: string

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number

    @IsOptional()
    @IsBoolean()
    isActive?: boolean

    @IsOptional()
    @IsBoolean()
    isDefault?: boolean
}

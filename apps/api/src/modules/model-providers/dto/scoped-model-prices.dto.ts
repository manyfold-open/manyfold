import {
    MODEL_PRICE_SOURCES,
    ModelPriceSource,
    UpsertBuiltInModelPriceBody,
    UpsertProviderModelPriceBody
} from '@manyfold/shared'
import {
    IsIn,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    MinLength,
    ValidateIf
} from 'class-validator'

// PUT is full-replace, so null and omitted mean the same thing here (cleared);
// ValidateIf lets null through the IsNumber check while the whitelist still
// strips anything not declared.
const OptionalPrice = (): PropertyDecorator => (target, key) => {
    IsOptional()(target, key)
    ValidateIf((_, value) => value !== null)(target, key)
    IsNumber()(target, key)
    Min(0)(target, key)
}

export class UpsertProviderModelPriceDto
    implements UpsertProviderModelPriceBody
{
    @IsString()
    @MinLength(1)
    @MaxLength(300)
    modelId!: string

    @OptionalPrice()
    inputCostPerToken?: number | null

    @OptionalPrice()
    outputCostPerToken?: number | null

    @OptionalPrice()
    cacheReadCostPerToken?: number | null

    @OptionalPrice()
    cacheCreationCostPerToken?: number | null

    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsIn([...MODEL_PRICE_SOURCES])
    priceRefSource?: ModelPriceSource | null

    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsString()
    priceRefKey?: string | null
}

export class UpsertBuiltInModelPriceDto
    extends UpsertProviderModelPriceDto
    implements UpsertBuiltInModelPriceBody
{
    @IsString()
    @MinLength(1)
    builtInId!: string
}

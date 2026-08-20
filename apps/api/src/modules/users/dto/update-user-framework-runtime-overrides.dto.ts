import type {
    ConfigurableFrameworkRuntimeDefault,
    FrameworkRuntimeChoice,
    UpdateUserFrameworkRuntimeOverridesSettingsBody
} from '@manyfold/shared'
import { IsObject } from 'class-validator'

export class UpdateUserFrameworkRuntimeOverridesDto implements UpdateUserFrameworkRuntimeOverridesSettingsBody {
    @IsObject()
    overrides!: Partial<
        Record<ConfigurableFrameworkRuntimeDefault, FrameworkRuntimeChoice>
    >
}

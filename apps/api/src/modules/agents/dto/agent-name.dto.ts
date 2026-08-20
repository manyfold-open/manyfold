import {
    normalizeAgentName,
    validateAgentName
} from '@manyfold/shared'
import { Transform } from 'class-transformer'
import {
    buildMessage,
    ValidateBy,
    type ValidationOptions
} from 'class-validator'

export const NormalizeAgentName = (): PropertyDecorator =>
    Transform(({ value }: { value: unknown }) =>
        typeof value === 'string' ? normalizeAgentName(value) : value
    )

export const IsAgentName = (
    validationOptions?: ValidationOptions
): PropertyDecorator =>
    ValidateBy(
        {
            name: 'isAgentName',
            validator: {
                validate: (value: unknown): boolean =>
                    typeof value === 'string' && validateAgentName(value).valid,
                defaultMessage: buildMessage(
                    () =>
                        'agent name must be 1-64 characters and can use any language, emoji, spaces, underscore, dash, and dot',
                    validationOptions
                )
            }
        },
        validationOptions
    )

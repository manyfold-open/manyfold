import { t } from '@manyfold/i18n'
import { ApiError } from '@manyfold/sdk'

// What a translation may name from the error's details ({{apiUrl}}): the
// flat string and number values, nothing nested.
const detailParams = (
    details: unknown
): Record<string, string | number> | undefined => {
    if (!details || typeof details !== 'object' || Array.isArray(details))
        return undefined
    const params: Record<string, string | number> = {}
    for (const [name, value] of Object.entries(details))
        if (typeof value === 'string' || typeof value === 'number')
            params[name] = value
    return params
}

export const apiErrorMessage = (err: unknown): string => {
    if (err instanceof ApiError) {
        if (err.code) {
            const key = `errors.api.${err.code}`
            const translated = t(key, detailParams(err.details))
            if (translated !== key) return translated
        }
        if (err.message) return err.message
        return t('errors.api.internal_error')
    }
    if (err instanceof Error) return err.message
    return String(err)
}

export const apiErrorDetailMessage = (err: unknown): string => {
    if (err instanceof ApiError && err.serverMessage) return err.serverMessage
    return apiErrorMessage(err)
}

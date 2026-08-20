import { t } from '@manyfold/i18n'
import { ApiError } from '@manyfold/sdk'

export const apiErrorMessage = (err: unknown): string => {
    if (err instanceof ApiError) {
        if (err.code) {
            const key = `errors.api.${err.code}`
            const translated = t(key)
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

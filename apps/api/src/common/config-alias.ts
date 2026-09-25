import { ConfigService } from '@nestjs/config'

export const configString = (
    config: ConfigService,
    keys: readonly string[]
): string | undefined => {
    for (const key of keys) {
        const value = config.get<string>(key)?.trim()
        if (value) return value
    }
    return undefined
}

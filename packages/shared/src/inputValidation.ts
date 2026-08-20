export const inputValidation = {
    AGENT_NAME: { MIN: 1, MAX: 64 },
    TOKEN_NAME: { MIN: 1, MAX: 64 },
    EMAIL: { MIN: 3, MAX: 254 },
    SPRITES_ACCOUNT_SLUG: { MIN: 1, MAX: 64 },
    USER_MODEL_PROVIDER_LABEL: { MIN: 1, MAX: 64 },
    MODEL_PROVIDER_API_KEY: { MIN: 8, MAX: 1024 }
} as const

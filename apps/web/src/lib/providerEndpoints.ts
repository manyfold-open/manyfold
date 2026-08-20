export const normalizeProviderBaseUrl = (
    value: string | null | undefined
): string | undefined => {
    const trimmed = value?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : undefined
}

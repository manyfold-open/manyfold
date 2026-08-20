import { BadRequestException } from '@nestjs/common'
import { normalizeProviderEndpoint } from '@manyfold/external-providers'

// Single SSRF implementation lives in @manyfold/external-providers; this wrapper
// only re-surfaces failures as BadRequestException for the provider-config API.
export const normalizeExternalProviderEndpoint = async (
    raw: string
): Promise<string> => {
    try {
        return await normalizeProviderEndpoint(raw)
    } catch (err) {
        throw new BadRequestException((err as Error).message)
    }
}

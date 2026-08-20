import { lookup } from 'mime-types'

const OCTET_STREAM = 'application/octet-stream'

const contentTypeEssence = (contentType: string): string =>
    contentType.split(';', 1)[0].trim().toLowerCase()

export const resolveImageContentType = (
    path: string,
    reportedContentType?: string | null
): string => {
    const reported = reportedContentType?.trim() ?? ''
    if (reported && contentTypeEssence(reported) !== OCTET_STREAM)
        return reported

    const inferred = lookup(path)
    if (inferred && inferred.startsWith('image/')) return inferred
    return reported || OCTET_STREAM
}

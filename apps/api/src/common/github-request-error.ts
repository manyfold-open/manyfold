import { ServiceUnavailableException } from '@nestjs/common'

export type GitHubFailure =
    | 'credential_invalid'
    | 'credential_policy'
    | 'rate_limited'
    | 'permission_denied'
    | 'upstream'

export class GitHubRequestError extends ServiceUnavailableException {
    constructor(
        readonly classification: GitHubFailure = 'upstream',
        readonly reason: 'request' | 'busy' | 'import' = 'request',
        // Epoch ms before which retrying is pointless: from GitHub's rate-limit
        // headers, or from a skill repository's recorded scan backoff.
        readonly retryAt?: number
    ) {
        super(
            reason === 'busy'
                ? {
                      code: 'skill_scan_busy',
                      message: 'Skill discovery is busy; retry shortly',
                      retryAfterSec: 2
                  }
                : reason === 'import'
                  ? {
                        code: 'skill_import_unavailable',
                        message:
                            'Skill import could not be persisted; retry shortly',
                        details: { classification }
                    }
                  : {
                        code: 'github_source_unavailable',
                        message: `GitHub source unavailable (${classification})`,
                        details: { classification },
                        ...(retryAt === undefined
                            ? {}
                            : {
                                  retryAfterSec: Math.max(
                                      1,
                                      Math.ceil((retryAt - Date.now()) / 1000)
                                  )
                              })
                    }
        )
    }
}

// GitHub's rate-limit guidance: wait out Retry-After (seconds or an HTTP
// date); with no requests remaining, wait until x-ratelimit-reset (epoch
// seconds). Undefined when the response names no time.
export const githubRetryAt = (
    headers: Headers,
    now = Date.now()
): number | undefined => {
    const after = headers.get('retry-after')?.trim()
    if (after) {
        if (/^\d+$/.test(after)) return now + Number(after) * 1000
        const date = Date.parse(after)
        if (Number.isFinite(date)) return date
    }
    const reset = headers.get('x-ratelimit-reset')?.trim()
    if (
        headers.get('x-ratelimit-remaining')?.trim() === '0' &&
        reset &&
        /^\d+$/.test(reset)
    )
        return Number(reset) * 1000
    return undefined
}

export const classifyGitHubResponse = (
    status: number,
    headers: Headers,
    body: string
): GitHubFailure => {
    if (status === 401) return 'credential_invalid'
    if (
        status === 429 ||
        (status === 403 &&
            (headers.get('x-ratelimit-remaining') === '0' ||
                headers.has('retry-after') ||
                /(?:secondary |api )?rate limit/i.test(body)))
    )
        return 'rate_limited'
    if (
        status === 403 &&
        /(?:personal access token|fine.grained|credential).*(?:lifetime|policy|expiration)|(?:lifetime|policy).*(?:personal access token|fine.grained)/i.test(
            body
        )
    )
        return 'credential_policy'
    if (status === 403 || status === 404) return 'permission_denied'
    return 'upstream'
}

export const githubResponseError = async (
    response: Response
): Promise<GitHubRequestError> => {
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        while (reader && length < 8192) {
            const { value, done } = await reader.read()
            if (done) break
            const part = value.subarray(0, 8192 - length)
            chunks.push(part)
            length += part.length
        }
    } catch {
    } finally {
        await reader?.cancel().catch(() => undefined)
    }
    return new GitHubRequestError(
        classifyGitHubResponse(
            response.status,
            response.headers,
            Buffer.concat(chunks).toString('utf8')
        )
    )
}

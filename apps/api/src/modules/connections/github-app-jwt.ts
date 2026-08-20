import { createPrivateKey, createSign } from 'node:crypto'

// Pure GitHub App auth helpers, shared by the platform-app connections
// service and the BYO-app github channel provider (which signs with
// per-channel credentials instead of ConfigService ones).

export const GITHUB_API_BASE = 'https://api.github.com'

// Accept either a base64-encoded PEM (recommended for .env / fly secrets) or
// a raw PEM pasted directly. createPrivateKey handles PKCS#1 and PKCS#8.
export const normalizeGithubPrivateKey = (
    raw: string
): string | undefined => {
    if (raw.includes('PRIVATE KEY')) return raw
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return decoded.includes('PRIVATE KEY') ? decoded : undefined
}

export const buildGithubAppJwt = (
    appId: string,
    privateKeyPem: string
): string => {
    const key = createPrivateKey(privateKeyPem)
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = b64url(
        JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })
    )
    const data = `${header}.${payload}`
    const sig = createSign('RSA-SHA256')
        .update(data)
        .sign(key)
        .toString('base64url')
    return `${data}.${sig}`
}

export const githubApiHeaders = (
    token: string,
    userAgent: string
): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent
})

const b64url = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64url')

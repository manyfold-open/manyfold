import type { LinkedAuthIdentity } from './auth-principal'

export const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com'

export const isGoogleIssuer = (issuer: string): boolean =>
    trimTrailingSlash(issuer) === GOOGLE_OIDC_ISSUER

export const normalizeEmail = (value: string | null | undefined): string => {
    const email = value?.trim().toLowerCase() ?? ''
    return email.includes('@') ? email : ''
}

export const DISPLAY_NAME_MAX = 50

// Strip control/format characters, collapse whitespace, trim. Length policy
// is the caller's (the profile editor rejects overlong input; the OAuth
// signup seed silently drops it), so this returns the cleaned string as-is.
export const cleanDisplayName = (
    raw: string | null | undefined
): string => {
    if (raw == null) return ''
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
}

export const dedupeLinkedIdentities = (
    identities: LinkedAuthIdentity[]
): LinkedAuthIdentity[] => {
    const seen = new Map<string, LinkedAuthIdentity>()
    for (const identity of identities) {
        const normalized = normalizeLinkedIdentity(identity)
        if (!normalized) continue
        const key = `${normalized.provider}:${normalized.subject}`
        const existing = seen.get(key)
        if (!existing) {
            seen.set(key, normalized)
            continue
        }
        if (!existing.email && normalized.email) existing.email = normalized.email
        if (!existing.sourceEmail && normalized.sourceEmail)
            existing.sourceEmail = normalized.sourceEmail
    }
    return Array.from(seen.values())
}

const normalizeLinkedIdentity = (
    identity: LinkedAuthIdentity
): LinkedAuthIdentity | null => {
    const subject =
        identity.provider === 'email'
            ? normalizeEmail(identity.subject)
            : identity.subject.trim()
    if (!subject) return null
    const email =
        identity.provider === 'email'
            ? subject
            : normalizeEmail(identity.email ?? identity.sourceEmail)
    return {
        provider: identity.provider,
        subject,
        email: email || undefined,
        sourceEmail: normalizeEmail(identity.sourceEmail) || email || null
    }
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

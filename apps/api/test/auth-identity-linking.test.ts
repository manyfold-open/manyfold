import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { AuthService } from '../src/modules/auth/auth.service'
import { OidcTokenVerifierService } from '../src/modules/auth/oidc-token-verifier.service'
import { noManagedModelsPort } from '@/common/ports/managed-models.ports'

const keyOf = (provider: string, subject: string): string =>
    `${provider}:${subject}`

const authServiceWith = (
    identities = new Map<string, { userId: string; email: string }>()
): AuthService => {
    const db = {
        insert: () => ({
            values: (value: {
                provider: string
                subject: string
                userId: string
                email: string
            }) => ({
                onConflictDoNothing: () => ({
                    returning: async () => {
                        const key = keyOf(value.provider, value.subject)
                        if (identities.has(key)) return []
                        identities.set(key, {
                            userId: value.userId,
                            email: value.email
                        })
                        return [{ userId: value.userId }]
                    }
                })
            })
        }),
        // Serves linkIdentities' one-email-per-account guard. The drizzle
        // where() filter is opaque here, so this returns every email identity
        // in the map — fine while each test exercises a single user.
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        [...identities.entries()]
                            .filter(([key]) => key.startsWith('email:'))
                            .map(([key]) => ({
                                subject: key.slice('email:'.length)
                            }))
                })
            })
        })
    }
    const service = new AuthService(
        db as never,
        { get: () => '' } as never,
        { get: () => ({ process: async () => {} }) } as never,
        { getInitialAdminEmails: async () => new Set<string>() } as never,
        { onUserProvisioned: async () => undefined } as never,
        noManagedModelsPort
    )
    ;(
        service as unknown as {
            findIdentity: (identity: {
                provider: string
                subject: string
            }) => Promise<{ userId: string; email: string } | null>
        }
    ).findIdentity = async (identity) =>
        identities.get(keyOf(identity.provider, identity.subject)) ?? null
    ;(
        service as unknown as {
            updateIdentityEmail: (
                identity: { provider: string; subject: string },
                email: string
            ) => Promise<void>
        }
    ).updateIdentityEmail = async (identity, email) => {
        const key = keyOf(identity.provider, identity.subject)
        const existing = identities.get(key)
        if (existing) identities.set(key, { ...existing, email })
    }
    return service
}

// A linked identity that already belongs to another user must NOT be reassigned
// (that would let a re-used Google sub or email hijack an account). The fresh
// identity still links; the conflict is counted and left untouched.
test('linkIdentities counts conflicts without reassigning the identity', async () => {
    const identities = new Map<string, { userId: string; email: string }>([
        [
            keyOf('google', 'google-sub'),
            { userId: 'existing-user', email: 'old@example.com' }
        ]
    ])
    const service = authServiceWith(identities)

    const result = await service.linkIdentities('target-user', [
        {
            provider: 'google',
            subject: 'google-sub',
            email: 'target@example.com'
        },
        {
            provider: 'email',
            subject: 'Target@Example.com',
            email: 'Target@Example.com'
        }
    ])

    assert.equal(result.linkedIdentities, 1)
    assert.equal(result.existingIdentities, 0)
    assert.equal(result.conflicts, 1)
    assert.deepEqual(identities.get(keyOf('google', 'google-sub')), {
        userId: 'existing-user',
        email: 'old@example.com'
    })
    assert.deepEqual(identities.get(keyOf('email', 'target@example.com')), {
        userId: 'target-user',
        email: 'target@example.com'
    })
})

// After a change-email swap the account's email identity differs from the
// OAuth provider's address. The next OAuth sign-in must NOT re-link the old
// address as a second email identity — that would silently undo the change.
test('linkIdentities skips a second email identity for the same account', async () => {
    const identities = new Map<string, { userId: string; email: string }>([
        [
            keyOf('email', 'new@example.com'),
            { userId: 'target-user', email: 'new@example.com' }
        ]
    ])
    const service = authServiceWith(identities)

    const result = await service.linkIdentities('target-user', [
        {
            provider: 'google',
            subject: 'google-sub',
            email: 'old@example.com'
        },
        {
            provider: 'email',
            subject: 'old@example.com',
            email: 'old@example.com'
        }
    ])

    assert.equal(result.linkedIdentities, 1)
    assert.equal(result.skippedEmails, 1)
    assert.equal(identities.has(keyOf('email', 'old@example.com')), false)
    assert.deepEqual(identities.get(keyOf('email', 'new@example.com')), {
        userId: 'target-user',
        email: 'new@example.com'
    })
})

// The guard must not break first-time merges: an account with no email
// identity yet still gets one auto-linked from the OAuth sign-in.
test('linkIdentities still links the first email identity', async () => {
    const identities = new Map<string, { userId: string; email: string }>()
    const service = authServiceWith(identities)

    const result = await service.linkIdentities('target-user', [
        {
            provider: 'email',
            subject: 'first@example.com',
            email: 'first@example.com'
        }
    ])

    assert.equal(result.linkedIdentities, 1)
    assert.equal(result.skippedEmails, 0)
    assert.deepEqual(identities.get(keyOf('email', 'first@example.com')), {
        userId: 'target-user',
        email: 'first@example.com'
    })
})

test('OidcTokenVerifierService maps Google OIDC to google identity', async (t) => {
    const { SignJWT, exportJWK, generateKeyPair } = await import('jose')
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey)
    jwk.kid = 'test-key'

    const server = createServer((_, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())

    const port = (server.address() as AddressInfo).port
    const settings = {
        authority: 'https://accounts.google.com',
        clientId: 'nca-client',
        audience: null,
        jwksUrl: `http://127.0.0.1:${port}/jwks`,
        userIdClaim: 'sub',
        emailClaim: 'email'
    } as const
    const service = new OidcTokenVerifierService()
    const token = await new SignJWT({
        email: 'User@Example.COM',
        email_verified: true
    })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(settings.authority)
        .setAudience(settings.clientId)
        .setSubject('google-sub')
        .setExpirationTime('1h')
        .sign(privateKey)

    assert.deepEqual(await service.verify(token, settings), {
        provider: 'google',
        subject: 'google-sub',
        email: 'user@example.com',
        linkedIdentities: [
            {
                provider: 'email',
                subject: 'user@example.com',
                email: 'user@example.com',
                sourceEmail: 'user@example.com'
            }
        ]
    })

    const unverified = await new SignJWT({
        email: 'user@example.com',
        email_verified: false
    })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(settings.authority)
        .setAudience(settings.clientId)
        .setSubject('google-sub')
        .setExpirationTime('1h')
        .sign(privateKey)

    await assert.rejects(
        () => service.verify(unverified, settings),
        /email is not verified/
    )

    // The `name` claim seeds the initial display name (once, at creation).
    // Passed through raw here; sanitization happens at the signup seed.
    const named = await new SignJWT({
        email: 'user@example.com',
        email_verified: true,
        name: 'Jiaming Fu'
    })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(settings.authority)
        .setAudience(settings.clientId)
        .setSubject('google-sub')
        .setExpirationTime('1h')
        .sign(privateKey)

    const withName = await service.verify(named, settings)
    assert.equal(withName.displayName, 'Jiaming Fu')
})

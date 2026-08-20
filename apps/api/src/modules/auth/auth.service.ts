import {
    AuthIdentitySummary,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ModuleRef } from '@nestjs/core'
import { and, eq, isNull } from 'drizzle-orm'
import {
    authIdentities,
    emailVerifications,
    userPasswords,
    users,
    type User,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    BILLING_LIFECYCLE_PORT,
    type BillingLifecyclePort
} from '@/common/ports/billing-lifecycle.ports'
import {
    MANAGED_MODELS_PORT,
    type ManagedModelsPort
} from '@/common/ports/managed-models.ports'
import { NotificationsService } from '@/modules/notifications/notifications.service'
import type { ExternalAuthIdentity, LinkedAuthIdentity } from './auth-principal'
import { AuthSettingsService } from './auth-settings.service'
import {
    DISPLAY_NAME_MAX,
    cleanDisplayName,
    dedupeLinkedIdentities,
    normalizeEmail
} from './linked-identities'

type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0]

interface StoredAuthIdentity {
    userId: string
    email: string
}

// Sanitize the provider-asserted name for the one-time signup seed. Unlike
// the explicit profile editor this never rejects — a weird name claim must
// not fail account creation, so overlong input is dropped, not erred.
const seedDisplayName = (raw: string | undefined): string | null => {
    const collapsed = cleanDisplayName(raw)
    if (!collapsed || [...collapsed].length > DISPLAY_NAME_MAX) return null
    return collapsed
}

interface LinkIdentitiesResult {
    linkedIdentities: number
    existingIdentities: number
    conflicts: number
    // Email identities dropped because the account already has a different
    // sign-in email (see the guard in linkIdentities).
    skippedEmails: number
}

@Injectable()
export class AuthService {
    private readonly log = new Logger(AuthService.name)
    private readonly adminEmails: Set<string>
    private readonly adminUserIds: Set<string>

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly moduleRef: ModuleRef,
        private readonly authSettings: AuthSettingsService,
        @Inject(BILLING_LIFECYCLE_PORT)
        private readonly billingLifecycle: BillingLifecyclePort,
        @Inject(MANAGED_MODELS_PORT)
        private readonly managedModels: ManagedModelsPort
    ) {
        const raw = this.config.get<string>('ADMIN_EMAILS') ?? ''
        this.adminEmails = new Set(
            raw
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s.length > 0)
        )
        this.adminUserIds = new Set(
            (this.config.get<string>('ADMIN_USER_IDS') ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
        )
    }

    async upsertUser(
        input: { id: string; email: string; displayName?: string },
        opts: { fireSignupHooks?: boolean } = {}
    ): Promise<User> {
        const result = await this.upsertUserWithResult(input)
        // Password sign-ups that still need email verification pass
        // fireSignupHooks:false so the managed-model bootstrap + signup credit do
        // NOT run for an unverified (potentially throwaway) address; they fire
        // from completeDeferredSignup() once the email is proven.
        if (opts.fireSignupHooks !== false)
            this.fireSignupHooks(result.user, result.created)
        return result.user
    }

    // Run the one-time new-user side effects (managed bootstrap + signup credit
    // + notification) for a user whose signup was deferred behind email
    // verification. Idempotent at the credit/bootstrap layer.
    async completeDeferredSignup(userId: string): Promise<void> {
        const user = await this.getUser(userId)
        if (user) this.fireSignupHooks(user, true)
    }

    private fireSignupHooks(user: User, newUser: boolean): void {
        void this.kickManagedBootstrap({ user, newUser })
        void this.kickStripeCustomerProvision(user.id)
        if (newUser) {
            try {
                this.moduleRef
                    .get(NotificationsService, { strict: false })
                    .dispatch('user.registered', {
                        userId: user.id,
                        email: user.email,
                        role: user.role
                    })
            } catch (err) {
                this.log.error(
                    `notification dispatch failed: ${(err as Error).message}`
                )
            }
        }
    }

    async getUser(id: string): Promise<User | null> {
        const [row] = await this.db
            .select()
            .from(users)
            .where(eq(users.id, id))
            .limit(1)
        return row ?? null
    }

    // Resolve a user by any of the supplied external identities (matched on
    // provider+subject), creating one on first sight, then link every identity.
    async upsertExternalIdentity(input: ExternalAuthIdentity): Promise<User> {
        const { user } = await this.upsertExternalIdentityWithResult(input)
        return user
    }

    // Same as upsertExternalIdentity but surfaces whether this call created
    // the users row — the authoritative "first account creation" signal that
    // conversion recording keys on (a plain upsert can't tell a login from a
    // signup).
    async upsertExternalIdentityWithResult(
        input: ExternalAuthIdentity
    ): Promise<{ user: User; created: boolean }> {
        const identities = dedupeLinkedIdentities([
            {
                provider: input.provider,
                subject: input.subject,
                email: input.email
            },
            ...(input.linkedIdentities ?? [])
        ])
        const existing = await this.findFirstIdentity(identities)
        const userId = existing?.userId ?? createObjectId('user')
        const result = await this.upsertUserWithResult({
            id: userId,
            email: input.email,
            displayName: input.displayName
        })
        this.fireSignupHooks(result.user, result.created)
        const linked = await this.linkIdentities(
            result.user.id,
            identities,
            input.email
        )
        if (linked.conflicts > 0) {
            this.log.warn(
                `auth identity linking skipped ${linked.conflicts} conflicting identities for user=${result.user.id}`
            )
        }
        return result
    }

    async findUserIdByIdentity(
        provider: LinkedAuthIdentity['provider'],
        subject: string
    ): Promise<string | null> {
        const existing = await this.findIdentity({ provider, subject })
        return existing?.userId ?? null
    }

    async listIdentities(userId: string): Promise<AuthIdentitySummary[]> {
        const rows = await this.db
            .select({
                provider: authIdentities.provider,
                subject: authIdentities.subject,
                email: authIdentities.email,
                createdAt: authIdentities.createdAt
            })
            .from(authIdentities)
            .where(eq(authIdentities.userId, userId))
            .orderBy(authIdentities.createdAt)
        // An email identity can exist without a password (OAuth sign-ins link
        // one automatically), so surface whether password login actually works.
        const [passwordRow] = await this.db
            .select({ userId: userPasswords.userId })
            .from(userPasswords)
            .where(eq(userPasswords.userId, userId))
            .limit(1)
        return rows.map((row) => ({
            provider: row.provider,
            subject: row.subject,
            email: row.email,
            createdAt: row.createdAt.toISOString(),
            ...(row.provider === 'email'
                ? { hasPassword: Boolean(passwordRow) }
                : {})
        }))
    }

    // Remove one of the current user's linked identities. Atomic + row-locked:
    // the FOR UPDATE lock serializes concurrent unlinks so two of them can't
    // both pass the usable-methods check and orphan the account.
    //
    // The email identity is never removable — the sign-in email is changed via
    // the explicit change-email flow, never left unbound. And because an email
    // identity only signs in when a password is set (OAuth sign-ins auto-link
    // one without), the "last method" check counts USABLE methods: OAuth
    // identities plus the email identity only if a password exists. Otherwise
    // a Google-only user could disconnect Google and be locked out behind a
    // password-less email row.
    async unlinkIdentity(
        userId: string,
        provider: string,
        subject: string
    ): Promise<void> {
        if (provider === 'email')
            throw new BadRequestException({
                code: 'auth.email_identity_locked',
                message:
                    'the sign-in email cannot be disconnected; change it instead'
            })
        await this.db.transaction(async (tx) => {
            const rows = await tx
                .select({
                    provider: authIdentities.provider,
                    subject: authIdentities.subject
                })
                .from(authIdentities)
                .where(eq(authIdentities.userId, userId))
                .for('update')
            const target = rows.find(
                (row) => row.provider === provider && row.subject === subject
            )
            if (!target)
                throw new NotFoundException({
                    code: 'auth.identity_not_found',
                    message: 'identity not found'
                })
            const [passwordRow] = await tx
                .select({ userId: userPasswords.userId })
                .from(userPasswords)
                .where(eq(userPasswords.userId, userId))
                .limit(1)
            const remaining = rows.filter((row) => row !== target)
            const usable =
                remaining.filter((row) => row.provider !== 'email').length +
                (remaining.some((row) => row.provider === 'email') &&
                passwordRow
                    ? 1
                    : 0)
            if (usable < 1)
                throw new BadRequestException({
                    code: 'auth.last_sign_in_method',
                    message: 'cannot remove your only usable sign-in method'
                })
            await tx
                .delete(authIdentities)
                .where(
                    and(
                        eq(authIdentities.provider, target.provider),
                        eq(authIdentities.subject, target.subject),
                        eq(authIdentities.userId, userId)
                    )
                )
        })
    }

    // Atomically swap the account's sign-in email: replace the email identity,
    // update the primary email, and void every pending verification code so a
    // reset code mailed to the OLD address can't act on the account after the
    // swap. The caller has already verified ownership of newEmail. An optional
    // passwordHash is written in the SAME transaction so a password-less
    // account never commits the swap and then fails to gain its password
    // (which would leave email sign-in permanently broken).
    async changeEmail(
        userId: string,
        newEmail: string,
        opts: { passwordHash?: string } = {}
    ): Promise<{ oldEmail: string }> {
        return await this.db.transaction(async (tx) => {
            const [account] = await tx
                .select({ email: users.email })
                .from(users)
                .where(eq(users.id, userId))
                .for('update')
            if (!account)
                throw new NotFoundException({
                    code: 'auth.account_not_found',
                    message: 'account not found'
                })
            const rows = await tx
                .select({
                    provider: authIdentities.provider,
                    subject: authIdentities.subject
                })
                .from(authIdentities)
                .where(eq(authIdentities.userId, userId))
                .for('update')
            const current = rows.find((row) => row.provider === 'email')
            // The old sign-in address is the email identity's subject, not
            // users.email — on drift-era accounts those differ, and the
            // security notice must reach the address that just lost access.
            const oldEmail = current?.subject ?? account.email
            if (current?.subject === newEmail) {
                if (opts.passwordHash)
                    await this.writePasswordTx(tx, userId, opts.passwordHash)
                return { oldEmail: newEmail }
            }
            if (current)
                await tx
                    .delete(authIdentities)
                    .where(
                        and(
                            eq(authIdentities.provider, 'email'),
                            eq(authIdentities.subject, current.subject),
                            eq(authIdentities.userId, userId)
                        )
                    )
            // The (provider, subject) primary key is the final arbiter of the
            // owns-this-email race — a concurrent register/verify/change that
            // claimed newEmail first makes this insert a silent no-op.
            const [inserted] = await tx
                .insert(authIdentities)
                .values({
                    provider: 'email',
                    subject: newEmail,
                    userId,
                    email: newEmail
                })
                .onConflictDoNothing()
                .returning({ userId: authIdentities.userId })
            if (!inserted)
                throw new ConflictException({
                    code: 'auth.email_in_use',
                    message: 'an account with that email already exists'
                })
            await tx
                .update(users)
                .set({ email: newEmail, updatedAt: new Date() })
                .where(eq(users.id, userId))
            if (opts.passwordHash)
                await this.writePasswordTx(tx, userId, opts.passwordHash)
            await tx
                .update(emailVerifications)
                .set({ consumedAt: new Date() })
                .where(
                    and(
                        eq(emailVerifications.userId, userId),
                        isNull(emailVerifications.consumedAt)
                    )
                )
            return { oldEmail }
        })
    }

    private async writePasswordTx(
        tx: DbTx,
        userId: string,
        passwordHash: string
    ): Promise<void> {
        await tx
            .insert(userPasswords)
            .values({ userId, passwordHash })
            .onConflictDoUpdate({
                target: userPasswords.userId,
                set: { passwordHash, updatedAt: new Date() }
            })
    }

    async linkIdentities(
        userId: string,
        identities: LinkedAuthIdentity[],
        defaultEmail = ''
    ): Promise<LinkIdentitiesResult> {
        const result: LinkIdentitiesResult = {
            linkedIdentities: 0,
            existingIdentities: 0,
            conflicts: 0,
            skippedEmails: 0
        }
        for (const identity of dedupeLinkedIdentities(identities)) {
            const email =
                normalizeEmail(identity.email) ||
                normalizeEmail(defaultEmail) ||
                identity.subject
            // One email identity per account, managed only by the explicit
            // change-email flow. Without this, a Google sign-in after a swap
            // would silently re-link the Google address as a SECOND email
            // identity, undoing the change. First-time merges are unaffected
            // (no email identity yet → falls through to the insert).
            if (identity.provider === 'email') {
                const [currentEmail] = await this.db
                    .select({ subject: authIdentities.subject })
                    .from(authIdentities)
                    .where(
                        and(
                            eq(authIdentities.userId, userId),
                            eq(authIdentities.provider, 'email')
                        )
                    )
                    .limit(1)
                if (currentEmail && currentEmail.subject !== identity.subject) {
                    result.skippedEmails += 1
                    continue
                }
            }
            const existing = await this.findIdentity(identity)
            if (existing) {
                if (existing.userId !== userId) {
                    result.conflicts += 1
                    continue
                }
                result.existingIdentities += 1
                if (email && existing.email !== email)
                    await this.updateIdentityEmail(identity, email)
                continue
            }

            const [inserted] = await this.db
                .insert(authIdentities)
                .values({
                    provider: identity.provider,
                    subject: identity.subject,
                    userId,
                    email
                })
                .onConflictDoNothing()
                .returning({ userId: authIdentities.userId })
            if (inserted) {
                result.linkedIdentities += 1
                continue
            }

            const raced = await this.findIdentity(identity)
            if (raced && raced.userId === userId) result.existingIdentities += 1
            else if (raced) result.conflicts += 1
        }
        return result
    }

    private async findFirstIdentity(
        identities: LinkedAuthIdentity[]
    ): Promise<StoredAuthIdentity | null> {
        for (const identity of identities) {
            const existing = await this.findIdentity(identity)
            if (existing) return existing
        }
        return null
    }

    private async findIdentity(
        identity: Pick<LinkedAuthIdentity, 'provider' | 'subject'>
    ): Promise<StoredAuthIdentity | null> {
        const [row] = await this.db
            .select({
                userId: authIdentities.userId,
                email: authIdentities.email
            })
            .from(authIdentities)
            .where(
                and(
                    eq(authIdentities.provider, identity.provider),
                    eq(authIdentities.subject, identity.subject)
                )
            )
            .limit(1)
        return row ?? null
    }

    private async updateIdentityEmail(
        identity: Pick<LinkedAuthIdentity, 'provider' | 'subject'>,
        email: string
    ): Promise<void> {
        await this.db
            .update(authIdentities)
            .set({ email, updatedAt: new Date() })
            .where(
                and(
                    eq(authIdentities.provider, identity.provider),
                    eq(authIdentities.subject, identity.subject)
                )
            )
    }

    private async upsertUserWithResult(input: {
        id: string
        email: string
        displayName?: string
    }): Promise<{ user: User; created: boolean }> {
        const settingsAdminEmails =
            await this.authSettings.getInitialAdminEmails()
        const shouldBeAdmin =
            settingsAdminEmails.has(input.email.toLowerCase()) ||
            this.adminEmails.has(input.email.toLowerCase()) ||
            this.adminUserIds.has(input.id)

        const existing = await this.db
            .select()
            .from(users)
            .where(eq(users.id, input.id))
            .limit(1)

        if (existing[0]) {
            const row = existing[0]
            const patch: Partial<User> = {}
            // The account's primary email is fixed at creation. Earlier this
            // overwrote it with whichever provider was used to sign in, so the
            // address drifted by login method — and anything keyed on it
            // (password identity, billing, notifications) drifted with it.
            // Changing the address is a future explicit change-email flow.
            if (shouldBeAdmin && row.role !== 'admin') patch.role = 'admin'
            if (Object.keys(patch).length > 0) {
                const [promoted] = await this.db
                    .update(users)
                    .set({ ...patch, updatedAt: new Date() })
                    .where(eq(users.id, row.id))
                    .returning()
                return { user: promoted, created: false }
            }
            return { user: row, created: false }
        }

        const [created] = await this.db
            .insert(users)
            .values({
                id: input.id,
                email: input.email,
                // Seed-only, like the primary email: the OAuth provider's
                // name pre-fills the account once; later sign-ins never
                // touch it (the user owns it from here).
                displayName: seedDisplayName(input.displayName),
                role: shouldBeAdmin ? 'admin' : 'user',
                // Deployment-owned default: the self-host stack points this
                // at the seeded unlimited plan. A typo'd plan id fails the FK
                // loudly instead of silently landing users on 'free'.
                planId:
                    this.config.get<string>('MF_DEFAULT_PLAN_ID')?.trim() ||
                    'free'
            })
            .returning()
        return { user: created, created: true }
    }

    async notifyNetmindLogin(input: {
        userId: string
        loginToken: string
        identity: { subject: string; email: string }
        trigger: 'login' | 'bind'
    }): Promise<void> {
        await this.managedModels.onNetmindLogin(input)
    }

    private async kickManagedBootstrap(input: {
        user: User
        newUser: boolean
    }): Promise<void> {
        await this.managedModels.onUserAuthenticated({
            userId: input.user.id,
            email: input.user.email,
            newUser: input.newUser
        })
    }

    // Provision billing state eagerly at register/login (e.g. the cloud
    // edition creates the billing customer so a later gift-subscription flow
    // always has one to attach to). The port impl is idempotent and edition
    // specific. Fire-and-forget — never blocks auth.
    private async kickStripeCustomerProvision(userId: string): Promise<void> {
        try {
            await this.billingLifecycle.onUserProvisioned(userId)
        } catch (err) {
            this.log.warn(
                `billing lifecycle hook failed user=${userId}: ${(err as Error).message}`
            )
        }
    }
}

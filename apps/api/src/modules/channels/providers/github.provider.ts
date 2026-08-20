import type {
    ChannelTestResult,
    GithubChannelConfig,
    GithubChannelCredentials
} from '@manyfold/shared'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
    GITHUB_API_BASE,
    buildGithubAppJwt,
    githubApiHeaders,
    normalizeGithubPrivateKey
} from '@/modules/connections/github-app-jwt'
import {
    UnsupportedEventError,
    type ChannelContext,
    type ChannelHistoryContext,
    type ChannelHandle,
    type ChannelProvider,
    type ChannelSendTarget,
    type InboundActorPolicy,
    type InboundRequest,
    type NormalizedInboundEvent,
    type PreviewHandle,
    type RegistrationResult,
    type SignatureCheck
} from '../channel-provider'
import {
    channelProviderJsonRequest,
    type ChannelProviderJsonResponse
} from './channel-http'
import { ChannelSendError } from '../channel-send-error'
import {
    parseFinalMessageMode,
    parseHistoryBackfillLimit,
    parseProgressMode,
    parseResetOnIdleMins
} from '../config-helpers'
import { chunkText } from '../text-chunk'

const GITHUB_EVENT_HEADER = 'x-github-event'
const GITHUB_DELIVERY_HEADER = 'x-github-delivery'
const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256'
// The app id the webhook belongs to; a mismatch means the stored credentials
// are for a different app than the one delivering (app recreated, stale
// secret copied over) and is worth a recorded drop.
const GITHUB_TARGET_ID_HEADER = 'x-github-hook-installation-target-id'
// GitHub caps a comment body at 65536 characters; stay under it so the
// chunker's fence reopen overhead can never push a chunk over the edge.
const GITHUB_COMMENT_MAX_BODY = 60_000
// Read a cached installation token as expired this far ahead of its real
// expiry so an in-flight call cannot straddle it.
const GITHUB_TOKEN_SKEW_MS = 60_000
const GITHUB_RATE_LIMIT_RETRY_MS = 60_000
// Comment edits count against GitHub's secondary content-creation budget
// (~80 content requests/minute across the whole installation), so pace the
// streaming preview well below the platform default.
const GITHUB_PREVIEW_MIN_INTERVAL_MS = 10_000
// Ceiling on the per-channel memo maps (repo -> installation, reaction ids).
// Evicting the oldest only costs an extra lookup or a leftover 👀, so the cap
// can be generous; without one a long-lived process grows them forever.
const GITHUB_MEMO_CAP = 4096
const GITHUB_ISSUE_BODY_MAX = 4_000
const GITHUB_HISTORY_COMMENT_MAX = 1_000
// Anyone can comment on a public repository, so the association gate
// defaults closed: repo owner, org members and collaborators.
const GITHUB_DEFAULT_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

interface GithubUserPayload {
    login?: unknown
    type?: unknown
}

interface GithubRepoPayload {
    full_name?: unknown
    html_url?: unknown
    clone_url?: unknown
    default_branch?: unknown
}

interface GithubIssuePayload {
    number?: unknown
    title?: unknown
    body?: unknown
    state?: unknown
    html_url?: unknown
    user?: GithubUserPayload | null
    author_association?: unknown
    pull_request?: unknown
}

interface GithubCommentPayload {
    id?: unknown
    body?: unknown
    user?: GithubUserPayload | null
    author_association?: unknown
}

interface GithubWebhookBody {
    action?: unknown
    repository?: GithubRepoPayload | null
    issue?: GithubIssuePayload | null
    comment?: GithubCommentPayload | null
    sender?: GithubUserPayload | null
    label?: { name?: unknown } | null
}

interface GithubTokenCacheEntry {
    token: string
    expiresAt: number
}

interface GithubReactionMemo {
    fullName: string
    reactionId: number
}

interface GithubAppResponse {
    name?: string
    slug?: string
    html_url?: string
}

interface GithubCommentResponse {
    id?: number
    body?: string
    user?: { login?: string }
    created_at?: string
}

@Injectable()
export class GithubChannelProvider implements ChannelProvider {
    readonly name = 'github' as const
    readonly previewUpdateMinIntervalMs = GITHUB_PREVIEW_MIN_INTERVAL_MS
    private readonly logger = new Logger(GithubChannelProvider.name)
    // Keyed by channel + installation so rotating the app credentials cannot
    // serve a token minted under the old key pair.
    private readonly tokenCache = new Map<string, GithubTokenCacheEntry>()
    // channel:{repo} -> installation id. Insertion-capped; a re-lookup after
    // eviction is one JWT-authenticated GET.
    private readonly installationCache = new Map<string, number>()
    // scopeKey:{messageId} -> the 👀 reaction to delete on the terminal.
    // Insertion-capped; losing an entry only leaves the 👀 in place.
    private readonly reactionMemo = new Map<string, GithubReactionMemo>()

    validateConfig(config: unknown): GithubChannelConfig {
        if (!config || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            appSlug: optionalString(c.appSlug),
            botLogin: optionalString(c.botLogin),
            appHtmlUrl: optionalString(c.appHtmlUrl),
            allowedRepos: stringList(c.allowedRepos),
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            allowedAssociations: parseAssociations(c.allowedAssociations),
            triggerLabel: optionalString(c.triggerLabel),
            progressMode: parseProgressMode(c.progressMode),
            finalMessageMode: parseFinalMessageMode(c.finalMessageMode),
            historyBackfill: c.historyBackfill !== false,
            historyBackfillLimit: parseHistoryBackfillLimit(
                c.historyBackfillLimit
            ),
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(credentials: unknown): GithubChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const appId =
            typeof c.appId === 'string'
                ? c.appId.trim()
                : typeof c.appId === 'number'
                  ? String(c.appId)
                  : ''
        if (!/^\d+$/.test(appId))
            throw new BadRequestException(
                'credentials.appId must be the numeric GitHub App ID'
            )
        const rawKey =
            typeof c.privateKey === 'string' ? c.privateKey.trim() : ''
        if (!rawKey || !normalizeGithubPrivateKey(rawKey))
            throw new BadRequestException(
                'credentials.privateKey must be the app private key PEM (or base64-encoded PEM)'
            )
        const webhookSecret =
            typeof c.webhookSecret === 'string' ? c.webhookSecret.trim() : ''
        if (webhookSecret.length < 8)
            throw new BadRequestException(
                'credentials.webhookSecret is required (the webhook secret configured on your GitHub App)'
            )
        return { appId, privateKey: rawKey, webhookSecret }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const credentials = ctx.credentials as GithubChannelCredentials | null
        const secret = credentials?.webhookSecret
        if (!secret) return { ok: false, reason: 'webhook_secret_missing' }
        const headers = lowercaseHeaders(req.headers)
        const signature = headers[GITHUB_SIGNATURE_HEADER]
        if (!signature) return { ok: false, reason: 'missing_signature' }
        const rawBody =
            req.rawBody ??
            (typeof req.body === 'string'
                ? req.body
                : JSON.stringify(req.body ?? {}))
        const expected = `sha256=${createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex')}`
        const a = Buffer.from(expected)
        const b = Buffer.from(signature)
        if (a.length !== b.length || !timingSafeEqual(a, b))
            return { ok: false, reason: 'signature_mismatch' }
        // The ping GitHub sends when the webhook is created doubles as the
        // activation handshake: answering it flips a draft channel to
        // connected (there is no url_verification challenge to satisfy).
        if (headers[GITHUB_EVENT_HEADER] === 'ping')
            return {
                ok: true,
                challengeResponse: { status: 200, body: { ok: true } }
            }
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const headers = lowercaseHeaders(req.headers)
        const eventName = headers[GITHUB_EVENT_HEADER] ?? 'unknown'
        const config = ctx.config as GithubChannelConfig
        const credentials = ctx.credentials as GithubChannelCredentials | null
        // A delivery signed with our secret but produced by another app id
        // means the stored credentials are stale (app recreated); recorded,
        // not silent, so the drop is diagnosable from the deliveries list.
        const targetId = headers[GITHUB_TARGET_ID_HEADER]
        if (credentials?.appId && targetId && targetId !== credentials.appId)
            throw new UnsupportedEventError('app_mismatch')
        if (eventName !== 'issues' && eventName !== 'issue_comment')
            // The app receives every subscribed event on every installed
            // repo; anything but the two conversation events is pure volume.
            throw new UnsupportedEventError(eventName, { silent: true })
        const body = (req.body ?? {}) as GithubWebhookBody
        const action = typeof body.action === 'string' ? body.action : 'unknown'
        const fullName =
            typeof body.repository?.full_name === 'string'
                ? body.repository.full_name
                : ''
        if (!fullName)
            throw new BadRequestException('missing repository.full_name')
        const issue = body.issue
        const issueNumber =
            typeof issue?.number === 'number' ? issue.number : null
        if (issueNumber === null)
            throw new UnsupportedEventError(`${eventName}:no_issue`, {
                silent: true
            })
        const senderLogin =
            typeof body.sender?.login === 'string' ? body.sender.login : ''
        // Loop guard: the agent's own comments (and any other bot's) come
        // back through this webhook; letting one start a turn is a feedback
        // loop. Applies to every event, including label delegation — a human
        // must be the one who delegates.
        const botLogin = config.botLogin ?? null
        if (
            body.sender?.type === 'Bot' ||
            (botLogin && senderLogin.toLowerCase() === botLogin.toLowerCase())
        )
            throw new UnsupportedEventError('bot_sender', { silent: true })
        if (!repoAllowed(config.allowedRepos, fullName))
            throw new UnsupportedEventError('repo_not_allowed', {
                silent: true
            })
        const deliveryId = headers[GITHUB_DELIVERY_HEADER] ?? null
        const issueRef = `${fullName}#${issueNumber}`
        const base = {
            chatId: `${fullName.toLowerCase()}:${issueNumber}`,
            // An issue is a shared surface: whoever watches it sees the
            // conversation, so it is a group, never a DM.
            chatType: 'group' as const,
            // Every event that survives the gates below is addressed to the
            // agent by construction (mention or trigger label).
            isMention: true,
            senderId: senderLogin,
            senderName: senderLogin || null,
            threadId: null,
            raw: body
        }
        if (eventName === 'issue_comment') {
            if (action !== 'created')
                throw new UnsupportedEventError(`issue_comment:${action}`, {
                    silent: true
                })
            const comment = body.comment
            const commentId =
                typeof comment?.id === 'number' ? comment.id : null
            if (commentId === null)
                throw new BadRequestException('missing comment.id')
            const commentBody =
                typeof comment?.body === 'string' ? comment.body : ''
            if (!hasMention(commentBody, config.appSlug))
                throw new UnsupportedEventError('no_mention', { silent: true })
            const text = stripLeadingMention(commentBody, config.appSlug)
            return {
                ...base,
                providerEventId:
                    deliveryId ?? `issue_comment:created:${commentId}`,
                text:
                    text.length > 0
                        ? text
                        : issueDirective('mentioned on', issueRef, issue),
                messageId: `comment:${commentId}`
            }
        }
        if (action === 'opened') {
            const issueBody = typeof issue?.body === 'string' ? issue.body : ''
            if (!hasMention(issueBody, config.appSlug))
                throw new UnsupportedEventError('no_mention', { silent: true })
            const text = stripLeadingMention(issueBody, config.appSlug)
            return {
                ...base,
                providerEventId:
                    deliveryId ?? `issues:opened:${fullName}:${issueNumber}`,
                text:
                    text.length > 0
                        ? text
                        : issueDirective('mentioned on', issueRef, issue),
                messageId: 'issue'
            }
        }
        if (action === 'labeled') {
            const trigger = config.triggerLabel?.trim()
            const labelName =
                typeof body.label?.name === 'string' ? body.label.name : null
            if (!trigger || labelName !== trigger)
                throw new UnsupportedEventError('issues:labeled', {
                    silent: true
                })
            return {
                ...base,
                providerEventId:
                    deliveryId ??
                    `issues:labeled:${fullName}:${issueNumber}:${labelName}`,
                text: issueDirective('delegated', issueRef, issue),
                messageId: 'issue'
            }
        }
        throw new UnsupportedEventError(`issues:${action}`, { silent: true })
    }

    computeScopeKey(event: NormalizedInboundEvent): {
        scopeKey: string
        scopeName: string | null
    } {
        const raw = event.raw as GithubWebhookBody | null
        const fullName =
            typeof raw?.repository?.full_name === 'string'
                ? raw.repository.full_name
                : null
        const number =
            typeof raw?.issue?.number === 'number' ? raw.issue.number : null
        const title =
            typeof raw?.issue?.title === 'string' ? raw.issue.title : null
        const ref = fullName && number !== null ? `${fullName}#${number}` : null
        const scopeName = ref ? (title ? `${ref} ${title}` : ref) : null
        return { scopeKey: `github:${event.chatId}`, scopeName }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: ChannelConfigLike
    ): InboundActorPolicy {
        const github = config as GithubChannelConfig
        const sender = event.senderId.toLowerCase()
        const operator = (github.operatorUserIds ?? []).some(
            (login) => login.toLowerCase() === sender
        )
        const allowed = github.allowedUserIds ?? []
        // A non-empty login allowlist is the whole policy: the owner picked
        // exactly who may drive the agent, so association is not consulted.
        if (allowed.length > 0) {
            if (allowed.some((login) => login.toLowerCase() === sender))
                return { allowed: true, operator }
            return {
                allowed: false,
                reason: 'sender_not_allowed',
                operator: false
            }
        }
        const raw = event.raw as GithubWebhookBody | null
        const association =
            typeof raw?.comment?.author_association === 'string'
                ? raw.comment.author_association
                : typeof raw?.issue?.author_association === 'string'
                  ? raw.issue.author_association
                  : 'NONE'
        const associations =
            github.allowedAssociations &&
            github.allowedAssociations.length > 0
                ? github.allowedAssociations
                : GITHUB_DEFAULT_ASSOCIATIONS
        if (!associations.includes(association.toUpperCase()))
            return {
                allowed: false,
                reason: 'association_not_allowed',
                operator: false
            }
        return { allowed: true, operator }
    }

    // The issue is the conversation the mention arrived in, but mention
    // gating means the agent never saw it: replay the title, body and recent
    // comments as a supplemental block. Bodies are authored by whoever can
    // comment on the repo — untrusted content, never trusted instructions.
    async fetchHistoryContext(
        ctx: ChannelContext,
        event: NormalizedInboundEvent,
        opts: { scopeKey: string; limit: number }
    ): Promise<ChannelHistoryContext | null> {
        const raw = event.raw as GithubWebhookBody | null
        const repo = raw?.repository
        const issue = raw?.issue
        const fullName =
            typeof repo?.full_name === 'string' ? repo.full_name : null
        const number =
            typeof issue?.number === 'number' ? issue.number : null
        if (!fullName || number === null) return null
        const lines: string[] = ['[GitHub issue context]']
        const cloneUrl =
            typeof repo?.clone_url === 'string' ? repo.clone_url : null
        const defaultBranch =
            typeof repo?.default_branch === 'string'
                ? repo.default_branch
                : null
        lines.push(
            `Repository: ${fullName}${cloneUrl ? ` (clone: ${cloneUrl}${defaultBranch ? `, default branch: ${defaultBranch}` : ''})` : ''}`
        )
        const title = typeof issue?.title === 'string' ? issue.title : ''
        const state = typeof issue?.state === 'string' ? issue.state : null
        const author =
            typeof issue?.user?.login === 'string' ? issue.user.login : null
        const kind = issue?.pull_request ? 'Pull request' : 'Issue'
        lines.push(
            `${kind} #${number}: ${title}${state ? ` [${state}]` : ''}${author ? ` by @${author}` : ''}`
        )
        const body = typeof issue?.body === 'string' ? issue.body.trim() : ''
        if (body.length > 0)
            lines.push('', truncate(body, GITHUB_ISSUE_BODY_MAX))
        const comments = await this.recentComments(
            ctx,
            fullName,
            number,
            opts.limit,
            event.messageId ?? null
        )
        if (comments.length > 0) {
            lines.push('', `Recent comments:`)
            for (const comment of comments) lines.push(comment)
        }
        return { text: lines.join('\n') }
    }

    // GitHub has no typing indicator; the 👀 reaction on the triggering
    // comment is the acknowledgement, flipped to 🚀/😕 at the terminal.
    async setInboundReaction(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string,
        state: 'working' | 'done' | 'failed'
    ): Promise<void> {
        const { fullName, issueNumber } = parseScopeKey(scopeKey)
        const reactionPath = providerMessageId.startsWith('comment:')
            ? `/repos/${fullName}/issues/comments/${providerMessageId.slice('comment:'.length)}/reactions`
            : `/repos/${fullName}/issues/${issueNumber}/reactions`
        const memoKey = `${scopeKey}:${providerMessageId}`
        if (state === 'working') {
            const created = await this.rest<{ id?: number }>(
                ctx,
                fullName,
                'reaction-create',
                'POST',
                reactionPath,
                { content: 'eyes' }
            )
            if (typeof created?.id === 'number')
                rememberCapped(this.reactionMemo, memoKey, {
                    fullName,
                    reactionId: created.id
                })
            return
        }
        await this.rest(ctx, fullName, 'reaction-create', 'POST', reactionPath, {
            content: state === 'done' ? 'rocket' : 'confused'
        })
        const memo = this.reactionMemo.get(memoKey)
        if (!memo) return
        this.reactionMemo.delete(memoKey)
        // Best-effort: a leftover 👀 next to the terminal emoji is cosmetic.
        await this.rest(
            ctx,
            fullName,
            'reaction-delete',
            'DELETE',
            `${reactionPath}/${memo.reactionId}`
        ).catch(() => {})
    }

    async sendPreviewStart(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<PreviewHandle> {
        const { fullName, issueNumber } = parseScopeKey(scopeKey)
        const comment = await this.createComment(
            ctx,
            fullName,
            issueNumber,
            '⏳ Working…'
        )
        return {
            providerMessageId: String(comment.id),
            raw: { fullName, issueNumber }
        }
    }

    async updatePreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void> {
        const fullName = previewRepo(handle)
        await this.rest(
            ctx,
            fullName,
            'comment-edit',
            'PATCH',
            `/repos/${fullName}/issues/comments/${handle.providerMessageId}`,
            { body: truncate(partial, GITHUB_COMMENT_MAX_BODY) }
        )
    }

    async finishPreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void> {
        const fullName = previewRepo(handle)
        // The preview holds only the first chunk of an oversize reply; the
        // rest goes out as fresh comments so nothing is truncated away.
        const chunks = chunkText(finalText, GITHUB_COMMENT_MAX_BODY)
        await this.rest(
            ctx,
            fullName,
            'comment-edit',
            'PATCH',
            `/repos/${fullName}/issues/comments/${handle.providerMessageId}`,
            { body: chunks[0] ?? finalText }
        )
        const issueNumber = issueNumberOfPreview(handle)
        for (const chunk of chunks.slice(1)) {
            if (issueNumber === null) break
            await this.createComment(ctx, fullName, issueNumber, chunk)
        }
    }

    async deleteMessage(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string
    ): Promise<void> {
        const { fullName } = parseScopeKey(scopeKey)
        const commentId = providerMessageId.startsWith('comment:')
            ? providerMessageId.slice('comment:'.length)
            : providerMessageId
        await this.rest(
            ctx,
            fullName,
            'comment-delete',
            'DELETE',
            `/repos/${fullName}/issues/comments/${commentId}`
        )
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const { fullName, issueNumber } = parseScopeKey(scopeKey)
        let lastId: string | undefined
        for (const chunk of chunkText(text, GITHUB_COMMENT_MAX_BODY)) {
            const comment = await this.createComment(
                ctx,
                fullName,
                issueNumber,
                chunk
            )
            lastId = String(comment.id)
        }
        return { providerMessageId: lastId }
    }

    // After a crash, look for the reply among the bot's own comments since
    // the attempt started. 'sent' must be high-precision (a false positive
    // silently drops the reply), so it requires an exact body match on the
    // LAST chunk — chunks post sequentially, so its presence implies the
    // earlier ones landed too.
    async reconcileSend(
        ctx: ChannelContext,
        opts: {
            scopeKey: string
            target: ChannelSendTarget | null
            text: string
            attemptStartedAt: Date
        }
    ): Promise<{
        outcome: 'sent' | 'not_sent' | 'unknown'
        providerMessageId?: string
    }> {
        const config = ctx.config as GithubChannelConfig
        const botLogin = config.botLogin?.toLowerCase()
        if (!botLogin) return { outcome: 'unknown' }
        try {
            const { fullName, issueNumber } = parseScopeKey(opts.scopeKey)
            const since = new Date(
                opts.attemptStartedAt.getTime() - 60_000
            ).toISOString()
            const comments = await this.rest<GithubCommentResponse[]>(
                ctx,
                fullName,
                'comments-list',
                'GET',
                `/repos/${fullName}/issues/${issueNumber}/comments?since=${encodeURIComponent(since)}&per_page=100`
            )
            const chunks = chunkText(opts.text, GITHUB_COMMENT_MAX_BODY)
            const needle = chunks[chunks.length - 1] ?? opts.text
            for (const comment of comments ?? []) {
                if (comment.user?.login?.toLowerCase() !== botLogin) continue
                if ((comment.body ?? '') !== needle) continue
                return {
                    outcome: 'sent',
                    providerMessageId:
                        comment.id !== undefined
                            ? String(comment.id)
                            : undefined
                }
            }
            return { outcome: 'not_sent' }
        } catch (err) {
            this.logger.debug(
                `github reconcile failed channel=${ctx.channel.id}: ${(err as Error).message}`
            )
            return { outcome: 'unknown' }
        }
    }

    async register(ctx: ChannelContext): Promise<RegistrationResult> {
        const credentials = ctx.credentials as GithubChannelCredentials | null
        if (!credentials)
            // No credentials yet is a valid resting state: the manifest flow
            // fills them in later. ok without activate leaves the channel in
            // draft instead of marking it errored.
            return {
                ok: true,
                message:
                    'Create the GitHub App (or paste its credentials) to finish setup'
            }
        const app = await this.fetchApp(credentials)
        const config = ctx.config as GithubChannelConfig
        return {
            ok: true,
            activate: true,
            configPatch: {
                ...config,
                appSlug: app.slug,
                botLogin: `${app.slug}[bot]`,
                appHtmlUrl: app.html_url ?? null
            },
            message: `authenticated as ${app.name ?? app.slug} (@${app.slug})`
        }
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials = ctx.credentials as GithubChannelCredentials | null
        if (!credentials)
            return {
                ok: false,
                message:
                    '✗ credentials missing — use Create GitHub App or paste the app credentials'
            }
        const lines: string[] = []
        let ok = true
        try {
            const app = await this.fetchApp(credentials)
            lines.push(
                `✓ authenticated as ${app.name ?? app.slug} (@${app.slug})`
            )
        } catch (err) {
            return {
                ok: false,
                message: `✗ GitHub authentication failed: ${(err as Error).message}`
            }
        }
        try {
            const installations = await this.appApi<
                { account?: { login?: string } }[]
            >(
                credentials,
                'installations',
                'GET',
                '/app/installations?per_page=100'
            )
            const accounts = (installations ?? [])
                .map((installation) => installation.account?.login ?? null)
                .filter((login): login is string => login !== null)
            if (accounts.length === 0) {
                ok = false
                lines.push(
                    '✗ the app is not installed anywhere — open the app page and install it on the account that owns your repositories'
                )
            } else {
                lines.push(`✓ installed on: ${accounts.join(', ')}`)
            }
        } catch (err) {
            ok = false
            lines.push(
                `✗ could not list installations: ${(err as Error).message}`
            )
        }
        if (ctx.channel.status === 'draft') {
            ok = false
            lines.push('✗ channel is still draft — run Register to activate it')
        } else if (ctx.channel.status === 'error') {
            ok = false
            lines.push(
                `✗ channel status is error — ${ctx.channel.lastErrorMessage ?? 'unknown error'}`
            )
        } else {
            lines.push(`✓ channel status: ${ctx.channel.status}`)
        }
        return { ok, message: lines.join('\n') }
    }

    private async recentComments(
        ctx: ChannelContext,
        fullName: string,
        issueNumber: number,
        limit: number,
        triggerMessageId: string | null
    ): Promise<string[]> {
        try {
            const comments = await this.rest<GithubCommentResponse[]>(
                ctx,
                fullName,
                'comments-list',
                'GET',
                `/repos/${fullName}/issues/${issueNumber}/comments?per_page=100`
            )
            const triggerId =
                triggerMessageId?.startsWith('comment:') === true
                    ? Number(triggerMessageId.slice('comment:'.length))
                    : null
            const out: string[] = []
            for (const comment of comments ?? []) {
                if (comment.id !== undefined && comment.id === triggerId)
                    continue
                const login = comment.user?.login ?? 'unknown'
                const body = (comment.body ?? '').trim()
                if (body.length === 0) continue
                out.push(
                    `@${login}: ${truncate(body.replace(/\s+/g, ' '), GITHUB_HISTORY_COMMENT_MAX)}`
                )
            }
            return out.slice(-Math.max(1, limit))
        } catch (err) {
            // Fail open: the issue header block is still worth sending.
            this.logger.debug(
                `github history fetch failed channel=${ctx.channel.id}: ${(err as Error).message}`
            )
            return []
        }
    }

    private async createComment(
        ctx: ChannelContext,
        fullName: string,
        issueNumber: number,
        body: string
    ): Promise<{ id: number }> {
        const created = await this.rest<{ id?: number }>(
            ctx,
            fullName,
            'comment-create',
            'POST',
            `/repos/${fullName}/issues/${issueNumber}/comments`,
            { body }
        )
        if (typeof created?.id !== 'number')
            throw new Error('github comment create returned no id')
        return { id: created.id }
    }

    private async fetchApp(
        credentials: GithubChannelCredentials
    ): Promise<GithubAppResponse & { slug: string }> {
        const app = await this.appApi<GithubAppResponse>(
            credentials,
            'app',
            'GET',
            '/app'
        )
        if (!app || typeof app.slug !== 'string' || app.slug.length === 0)
            throw new Error(
                'github /app returned no app for these credentials'
            )
        return { ...app, slug: app.slug }
    }

    // JWT-authenticated call (app-level endpoints: /app, /app/installations,
    // /repos/{r}/installation, token mint).
    private async appApi<T>(
        credentials: GithubChannelCredentials,
        operation: string,
        method: string,
        path: string
    ): Promise<T> {
        const pem = normalizeGithubPrivateKey(credentials.privateKey)
        if (!pem)
            throw new BadRequestException(
                'github privateKey is not a valid PEM'
            )
        const jwt = buildGithubAppJwt(credentials.appId, pem)
        const res = await this.requestRaw<T>(operation, method, path, jwt)
        return this.classify(operation, res)
    }

    // Installation-token-authenticated call (everything repo-scoped). A 401
    // means the cached installation token expired or was revoked, so one
    // forced re-mint retries before the error propagates; a 403 is a real
    // permission problem and is never retried.
    private async rest<T>(
        ctx: ChannelContext,
        fullName: string,
        operation: string,
        method: string,
        path: string,
        body?: unknown
    ): Promise<T> {
        const token = await this.installationToken(ctx, fullName)
        let res = await this.requestRaw<T>(operation, method, path, token, body)
        if (res.status === 401) {
            const fresh = await this.installationToken(ctx, fullName, {
                force: true
            })
            res = await this.requestRaw<T>(operation, method, path, fresh, body)
        }
        return this.classify(operation, res)
    }

    private async requestRaw<T>(
        operation: string,
        method: string,
        path: string,
        token: string,
        body?: unknown
    ): Promise<ChannelProviderJsonResponse<T>> {
        return channelProviderJsonRequest<T>({
            provider: 'github',
            operation,
            url: `${GITHUB_API_BASE}${path}`,
            init: {
                method,
                headers: {
                    ...githubApiHeaders(token, 'manyfold-github-channel'),
                    ...(body !== undefined
                        ? { 'Content-Type': 'application/json' }
                        : {})
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {})
            }
        })
    }

    private classify<T>(
        operation: string,
        res: ChannelProviderJsonResponse<T>
    ): T {
        if (res.ok) return res.json as T
        const detail = truncate(res.text, 200)
        if (res.status === 401 || res.status === 403) {
            // Secondary rate limits arrive as 403 + Retry-After; both mean
            // wait, not fail.
            if (res.status === 403 && res.retryAfterMs)
                throw new ChannelSendError(
                    'rate_limited',
                    `github ${operation} rate limited`,
                    { retryAfterMs: res.retryAfterMs }
                )
            throw new ChannelSendError(
                'forbidden',
                `github ${operation} ${res.status === 401 ? 'unauthorized' : 'forbidden'}: ${detail}`
            )
        }
        if (res.status === 429)
            throw new ChannelSendError(
                'rate_limited',
                `github ${operation} rate limited`,
                { retryAfterMs: res.retryAfterMs ?? GITHUB_RATE_LIMIT_RETRY_MS }
            )
        if (res.status === 404)
            throw new ChannelSendError(
                'not_found',
                `github ${operation} not found: ${detail}`
            )
        if (res.status === 422)
            throw new ChannelSendError(
                'bad_format',
                `github ${operation} rejected: ${detail}`
            )
        throw new Error(
            `github ${operation} failed: status=${res.status} ${detail}`
        )
    }

    private async installationToken(
        ctx: ChannelContext,
        fullName: string,
        opts: { force?: boolean } = {}
    ): Promise<string> {
        const credentials = ctx.credentials as GithubChannelCredentials | null
        if (!credentials)
            throw new BadRequestException('github credentials missing')
        const installationId = await this.installationIdForRepo(
            ctx,
            credentials,
            fullName
        )
        const cacheKey = `${ctx.channel.id}:${installationId}`
        if (!opts.force) {
            const cached = this.tokenCache.get(cacheKey)
            if (cached && cached.expiresAt - Date.now() > GITHUB_TOKEN_SKEW_MS)
                return cached.token
        }
        const minted = await this.appApi<{
            token?: string
            expires_at?: string
        }>(
            credentials,
            'installation-token',
            'POST',
            `/app/installations/${installationId}/access_tokens`
        )
        if (typeof minted?.token !== 'string')
            throw new ChannelSendError(
                'forbidden',
                'github installation token mint returned no token'
            )
        const expiresAt = minted.expires_at
            ? new Date(minted.expires_at).getTime()
            : Date.now() + 3_600_000
        this.tokenCache.set(cacheKey, { token: minted.token, expiresAt })
        return minted.token
    }

    private async installationIdForRepo(
        ctx: ChannelContext,
        credentials: GithubChannelCredentials,
        fullName: string
    ): Promise<number> {
        const cacheKey = `${ctx.channel.id}:${fullName.toLowerCase()}`
        const cached = this.installationCache.get(cacheKey)
        if (cached !== undefined) return cached
        let installation: { id?: number }
        try {
            installation = await this.appApi<{ id?: number }>(
                credentials,
                'repo-installation',
                'GET',
                `/repos/${fullName}/installation`
            )
        } catch (err) {
            if (err instanceof ChannelSendError && err.kind === 'not_found')
                throw new ChannelSendError(
                    'not_found',
                    `the GitHub App is not installed on ${fullName}`
                )
            throw err
        }
        if (typeof installation?.id !== 'number')
            throw new Error(
                `github installation lookup for ${fullName} returned no id`
            )
        rememberCapped(this.installationCache, cacheKey, installation.id)
        return installation.id
    }
}

// The manifest GitHub's create-app-from-manifest form consumes. Least
// privilege: issues:write covers issue/PR-conversation comments and
// reactions, pull_requests:write the PR side; repo contents stay with the
// GitHub *Connection* app, whose token is what the agent clones with.
export const buildGithubAppManifest = (opts: {
    name: string
    homepageUrl: string
    hookUrl: string
    redirectUrl: string
}): Record<string, unknown> => ({
    // GitHub caps app names at 34 characters; the create form lets the user
    // edit the prefill, so truncation is never destructive.
    name: opts.name.slice(0, 34),
    url: opts.homepageUrl,
    hook_attributes: { url: opts.hookUrl, active: true },
    redirect_url: opts.redirectUrl,
    public: false,
    default_events: ['issues', 'issue_comment'],
    default_permissions: {
        issues: 'write',
        pull_requests: 'write'
    }
})

export interface GithubManifestConversion {
    appId: string
    slug: string
    name: string | null
    htmlUrl: string | null
    pem: string
    webhookSecret: string
}

// Exchange the one-hour code GitHub redirects back with for the new app's
// credentials. Unauthenticated by design — the code is the proof.
export const convertGithubAppManifestCode = async (
    code: string
): Promise<GithubManifestConversion> => {
    const res = await channelProviderJsonRequest<{
        id?: number
        slug?: string
        name?: string
        html_url?: string
        pem?: string
        webhook_secret?: string
    }>({
        provider: 'github',
        operation: 'manifest-conversion',
        url: `${GITHUB_API_BASE}/app-manifests/${encodeURIComponent(code)}/conversions`,
        init: {
            method: 'POST',
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'manyfold-github-channel'
            }
        }
    })
    const body = res.json
    if (
        !res.ok ||
        typeof body?.id !== 'number' ||
        typeof body.slug !== 'string' ||
        typeof body.pem !== 'string' ||
        typeof body.webhook_secret !== 'string'
    )
        throw new BadRequestException(
            `github app manifest conversion failed: status=${res.status} ${truncate(res.text, 200)}`
        )
    return {
        appId: String(body.id),
        slug: body.slug,
        name: body.name ?? null,
        htmlUrl: body.html_url ?? null,
        pem: body.pem,
        webhookSecret: body.webhook_secret
    }
}

// evaluateInboundActor receives the whole ChannelConfig union; this keeps the
// cast local without importing every provider's config shape.
type ChannelConfigLike = Parameters<
    NonNullable<ChannelProvider['evaluateInboundActor']>
>[1]

const optionalString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const stringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
        : []

const parseAssociations = (value: unknown): string[] => {
    const parsed = stringList(value).map((item) => item.toUpperCase())
    return parsed.length > 0
        ? Array.from(new Set(parsed))
        : [...GITHUB_DEFAULT_ASSOCIATIONS]
}

// Insertion-order eviction: Maps iterate oldest-first, and each entry only
// memoizes a re-derivable value, so dropping the oldest is always safe.
const rememberCapped = <T>(
    map: Map<string, T>,
    key: string,
    value: T
): void => {
    map.set(key, value)
    if (map.size <= GITHUB_MEMO_CAP) return
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
}

const lowercaseHeaders = (
    headers: Record<string, string>
): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers ?? {}))
        out[key.toLowerCase()] = value
    return out
}

const repoAllowed = (allowedRepos: string[], fullName: string): boolean => {
    if (allowedRepos.length === 0) return true
    const needle = fullName.toLowerCase()
    return allowedRepos.some((repo) => repo.toLowerCase() === needle)
}

// Mention scan: fenced blocks, inline code and quoted lines are stripped
// first — a mention inside a code sample must not trigger, and GitHub email
// replies quote the previous comment (including its mention) verbatim.
const hasMention = (body: string, appSlug: string | null | undefined): boolean => {
    if (!appSlug) return false
    const scannable = body
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/^[ \t]*>.*$/gm, ' ')
    return mentionPattern(appSlug).test(scannable)
}

// GitHub renders @slug as a mention when it stands alone: preceded by a
// non-word boundary and not followed by more login characters. '/' is
// excluded on the left so owner/repo paths never read as mentions.
const mentionPattern = (appSlug: string): RegExp =>
    new RegExp(
        `(^|[^\\w/])@${escapeRegExp(appSlug)}(?![A-Za-z0-9-])`,
        'i'
    )

const stripLeadingMention = (
    body: string,
    appSlug: string | null | undefined
): string => {
    if (!appSlug) return body.trim()
    return body
        .replace(
            new RegExp(`^\\s*@${escapeRegExp(appSlug)}(?![A-Za-z0-9-])[,:]?\\s*`, 'i'),
            ''
        )
        .trim()
}

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const issueDirective = (
    verb: 'mentioned on' | 'delegated',
    issueRef: string,
    issue: GithubIssuePayload | null | undefined
): string => {
    const title = typeof issue?.title === 'string' ? issue.title : null
    const lead =
        verb === 'delegated'
            ? `You have been delegated GitHub issue ${issueRef}`
            : `You were mentioned on GitHub issue ${issueRef}`
    // The issue body reaches the turn as the GitHub issue context block above
    // this directive, so the directive points at it rather than repeating it.
    const tail =
        'Work it using the details in the GitHub issue context above, and reply with your result.'
    return title ? `${lead}: ${title}. ${tail}` : `${lead}. ${tail}`
}

const parseScopeKey = (
    scopeKey: string
): { fullName: string; issueNumber: number } => {
    const segments = scopeKey.split(':')
    const fullName = segments[1]
    const issueNumber = Number(segments[2])
    if (
        segments[0] !== 'github' ||
        !fullName ||
        !fullName.includes('/') ||
        !Number.isInteger(issueNumber)
    )
        throw new BadRequestException(`invalid github scopeKey ${scopeKey}`)
    return { fullName, issueNumber }
}

const previewRepo = (handle: PreviewHandle): string => {
    const fullName = (handle.raw as { fullName?: unknown } | undefined)
        ?.fullName
    if (typeof fullName !== 'string' || !fullName)
        throw new BadRequestException('github preview handle lost its repo')
    return fullName
}

const issueNumberOfPreview = (handle: PreviewHandle): number | null => {
    const value = (handle.raw as { issueNumber?: unknown } | undefined)
        ?.issueNumber
    return typeof value === 'number' && Number.isInteger(value) ? value : null
}

const truncate = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`

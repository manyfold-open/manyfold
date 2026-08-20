import { classifyHttpStatus, SpritesError } from './errors'
import { redact, redactHeaders } from './redaction'
import type {
    ExecSessionInfo,
    ListSpritesResponse,
    NetworkPolicy,
    ServiceDef,
    ServiceListResponse,
    ServiceMutationOptions,
    ServiceObject,
    ServiceStopOptions,
    Sprite,
    SpritesClientOptions,
    SpritesLogger
} from './types'

const DEFAULT_BASE_URL = 'https://api.sprites.dev/v1'
const DEFAULT_WS_BASE_URL = 'wss://api.sprites.dev/v1'
const DEFAULT_TIMEOUT_MS = 15_000
// Runaway guard for listSprites pagination — an account has O(hundreds) of
// sprites at most, so 50 pages (~2.5k) is far past any real listing.
const MAX_SPRITE_PAGES = 50

const silentLogger: SpritesLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
}

export interface SpritesClient {
    readonly baseUrl: string
    readonly wsBaseUrl: string
    readonly accountSlug?: string
    createSprite(input: { name: string; [k: string]: unknown }): Promise<Sprite>
    getSprite(name: string): Promise<Sprite>
    updateSprite(name: string, patch: Record<string, unknown>): Promise<Sprite>
    listSprites(): Promise<ListSpritesResponse>
    deleteSprite(name: string): Promise<void>
    getNetworkPolicy(name: string): Promise<NetworkPolicy>
    setNetworkPolicy(name: string, policy: NetworkPolicy): Promise<void>
    listServices(spriteName: string): Promise<ServiceListResponse>
    getService(spriteName: string, serviceName: string): Promise<ServiceObject>
    /**
     * PUT a service definition (create if missing, otherwise update).
     *
     * EMPIRICAL CAVEAT (probe 2026-06-02): in-place `env` updates are NOT
     * propagated to a running process, even after an explicit `restartService`.
     * To rotate credentials, callers must `deleteService` then `upsertService`
     * then `startService`. The bootstrap layer wraps this dance.
     */
    upsertService(
        spriteName: string,
        serviceName: string,
        def: ServiceDef,
        opts?: ServiceMutationOptions
    ): Promise<ServiceObject>
    deleteService(spriteName: string, serviceName: string): Promise<void>
    startService(
        spriteName: string,
        serviceName: string,
        opts?: ServiceMutationOptions
    ): Promise<ServiceObject>
    /**
     * POST stop. EMPIRICAL CAVEAT: the platform refuses to stop a service that
     * has live dependents — caller should stop dependents first. The returned
     * state reflects post-call GET, so callers can detect refusal by checking
     * `state.status` (e.g. still `running`).
     */
    stopService(
        spriteName: string,
        serviceName: string,
        opts?: ServiceStopOptions
    ): Promise<ServiceObject>
    restartService(
        spriteName: string,
        serviceName: string,
        opts?: ServiceMutationOptions
    ): Promise<ServiceObject>
    /**
     * POST kill for a running exec session (SIGTERM by default, escalating to
     * SIGKILL after `timeoutSec`). The WSS exec protocol has no kill message —
     * this is the only way to terminate a detached process before its
     * `max_run_after_disconnect` window lapses.
     */
    killExecSession(
        spriteName: string,
        sessionId: string,
        opts?: { signal?: string; timeoutSec?: number }
    ): Promise<void>
    // `is_active:false` means no client is attached (the process may still be
    // running); a session that exited unattached is reaped and never listed.
    listExecSessions(spriteName: string): Promise<ExecSessionInfo[]>
    authHeaderForInternalUse(): { Authorization: string }
}

export const createClient = (opts: SpritesClientOptions): SpritesClient => {
    if (!opts.token) throw new Error('SpritesClient requires a token')

    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    const wsBaseUrl = (opts.wsBaseUrl ?? DEFAULT_WS_BASE_URL).replace(
        /\/+$/,
        ''
    )
    const logger = opts.logger ?? silentLogger
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch
    if (!fetchImpl)
        throw new Error('No fetch implementation available for @manyfold/sprites')
    const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const authHeader = `Bearer ${opts.token}`

    const request = async <T>(
        method: string,
        path: string,
        body?: unknown
    ): Promise<T> => {
        const url = `${baseUrl}${path}`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const headers: Record<string, string> = {
            Authorization: authHeader,
            Accept: 'application/json'
        }
        let payload: BodyInit | undefined
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json'
            payload = JSON.stringify(body)
        }
        logger.debug('sprites.request', {
            method,
            url,
            headers: redactHeaders(headers)
        })
        try {
            const res = await fetchImpl(url, {
                method,
                headers,
                body: payload,
                signal: controller.signal
            })
            const text = await res.text()
            const parsed = text ? safeJson(text) : undefined
            if (!res.ok) {
                const code = classifyHttpStatus(res.status)
                const message = `sprites.dev ${method} ${path} → ${res.status}`
                logger.warn('sprites.error', {
                    status: res.status,
                    code,
                    body: redact(text).slice(0, 2048)
                })
                throw new SpritesError(
                    code,
                    message,
                    res.status,
                    parsed ?? text
                )
            }
            return (parsed ?? (undefined as unknown)) as T
        } catch (err) {
            if (err instanceof SpritesError) throw err
            const isAbort = err instanceof Error && err.name === 'AbortError'
            throw new SpritesError(
                'transient',
                isAbort
                    ? `sprites.dev ${method} ${path} timed out after ${timeoutMs}ms`
                    : `sprites.dev ${method} ${path} network error: ${(err as Error).message}`
            )
        } finally {
            clearTimeout(timer)
        }
    }

    // sprites.dev paginates GET /sprites (~50 per page). A single request drops
    // every sprite past page 1, which makes the status-sync account listing
    // falsely treat page-2+ sprites as deleted. Follow next_continuation_token
    // to the end. A whole page failing propagates — a partial listing would
    // re-create the false-missing bug, so callers must see all-or-error.
    const listAllSprites = async (): Promise<ListSpritesResponse> => {
        const first = await request<ListSpritesResponse>('GET', '/sprites')
        const sprites = [...first.sprites]
        const seen = new Set<string>()
        let token = first.has_more ? (first.next_continuation_token ?? null) : null
        let pages = 1
        while (token && pages < MAX_SPRITE_PAGES) {
            if (seen.has(token)) {
                logger.warn('sprites.listSprites.repeated_token', { pages })
                break
            }
            seen.add(token)
            const page = await request<ListSpritesResponse>(
                'GET',
                `/sprites?continuation_token=${encodeURIComponent(token)}`
            )
            for (const sprite of page.sprites) sprites.push(sprite)
            pages += 1
            token = page.has_more ? (page.next_continuation_token ?? null) : null
        }
        if (token && pages >= MAX_SPRITE_PAGES)
            logger.warn('sprites.listSprites.page_cap', { pages })
        return {
            ...first,
            sprites,
            has_more: false,
            next_continuation_token: null
        }
    }

    const servicesBase = (spriteName: string): string =>
        `/sprites/${encodeURIComponent(spriteName)}/services`

    const servicePath = (spriteName: string, serviceName: string): string =>
        `${servicesBase(spriteName)}/${encodeURIComponent(serviceName)}`

    const withDuration = (path: string, durationSec: number): string =>
        `${path}${path.includes('?') ? '&' : '?'}duration=${durationSec}s`

    const withTimeout = (path: string, timeoutSec: number): string =>
        `${path}${path.includes('?') ? '&' : '?'}timeout=${timeoutSec}s`

    return {
        baseUrl,
        wsBaseUrl,
        accountSlug: opts.accountSlug,
        createSprite: (input) => request('POST', '/sprites', input),
        getSprite: (name) =>
            request('GET', `/sprites/${encodeURIComponent(name)}`),
        updateSprite: (name, patch) =>
            request('PUT', `/sprites/${encodeURIComponent(name)}`, patch),
        listSprites: () => listAllSprites(),
        deleteSprite: async (name) => {
            await request('DELETE', `/sprites/${encodeURIComponent(name)}`)
        },
        getNetworkPolicy: (name) =>
            request(
                'GET',
                `/sprites/${encodeURIComponent(name)}/policy/network`
            ),
        setNetworkPolicy: async (name, policy) => {
            await request(
                'POST',
                `/sprites/${encodeURIComponent(name)}/policy/network`,
                policy
            )
        },
        listServices: (spriteName) =>
            request('GET', servicesBase(spriteName)),
        getService: (spriteName, serviceName) =>
            request('GET', servicePath(spriteName, serviceName)),
        upsertService: async (spriteName, serviceName, def, mutOpts) => {
            const duration = mutOpts?.durationSec ?? 0
            await request(
                'PUT',
                withDuration(servicePath(spriteName, serviceName), duration),
                def
            )
            return request<ServiceObject>(
                'GET',
                servicePath(spriteName, serviceName)
            )
        },
        deleteService: async (spriteName, serviceName) => {
            await request(
                'DELETE',
                servicePath(spriteName, serviceName)
            )
        },
        startService: async (spriteName, serviceName, mutOpts) => {
            const duration = mutOpts?.durationSec ?? 0
            await request(
                'POST',
                withDuration(
                    `${servicePath(spriteName, serviceName)}/start`,
                    duration
                )
            )
            return request<ServiceObject>(
                'GET',
                servicePath(spriteName, serviceName)
            )
        },
        stopService: async (spriteName, serviceName, stopOpts) => {
            const timeout = stopOpts?.timeoutSec ?? 10
            await request(
                'POST',
                withTimeout(
                    `${servicePath(spriteName, serviceName)}/stop`,
                    timeout
                )
            )
            return request<ServiceObject>(
                'GET',
                servicePath(spriteName, serviceName)
            )
        },
        restartService: async (spriteName, serviceName, mutOpts) => {
            const duration = mutOpts?.durationSec ?? 0
            await request(
                'POST',
                withDuration(
                    `${servicePath(spriteName, serviceName)}/restart`,
                    duration
                )
            )
            return request<ServiceObject>(
                'GET',
                servicePath(spriteName, serviceName)
            )
        },
        killExecSession: async (spriteName, sessionId, killOpts) => {
            const signal = killOpts?.signal ?? 'SIGTERM'
            const timeout = killOpts?.timeoutSec ?? 10
            await request(
                'POST',
                `/sprites/${encodeURIComponent(spriteName)}/exec/${encodeURIComponent(sessionId)}/kill?signal=${encodeURIComponent(signal)}&timeout=${timeout}s`
            )
        },
        listExecSessions: async (spriteName) => {
            const res = await request<{ sessions?: ExecSessionInfo[] }>(
                'GET',
                `/sprites/${encodeURIComponent(spriteName)}/exec`
            )
            return res?.sessions ?? []
        },
        authHeaderForInternalUse: () => ({ Authorization: authHeader })
    }
}

const safeJson = (text: string): unknown => {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

import type {
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
    SignalKeyStore,
    WASocket
} from 'baileys'

// baileys ships ESM-only, and apps/api compiles to CommonJS. A plain
// `await import()` is rewritten by tsc into `require()`, which throws
// ERR_REQUIRE_ESM on the Node 20 runtime image, so the import expression has
// to survive the transform untouched.
const nativeImport = new Function(
    'specifier',
    'return import(specifier)'
) as (specifier: string) => Promise<unknown>

type BaileysModule = typeof import('baileys')

let modulePromise: Promise<BaileysModule> | null = null

export const loadBaileys = async (): Promise<BaileysModule> => {
    if (!modulePromise)
        modulePromise = nativeImport('baileys').then(
            (mod) => mod as BaileysModule
        )
    return modulePromise
}

// Close codes we branch on. Everything else is an ordinary transient drop and
// goes back through the manager's persisted reconnect backoff.
export const WA_LOGGED_OUT = 401
export const WA_RESTART_REQUIRED = 515

export const waCloseCode = (err: unknown): number | null => {
    const output = (err as { output?: { statusCode?: unknown } } | null)?.output
    return typeof output?.statusCode === 'number' ? output.statusCode : null
}

// Serialized Baileys auth: creds plus every Signal key bucket, in the shape
// BufferJSON round-trips. Stored as one encrypted blob rather than per-key
// rows — Signal keys are only ever read and written as a set by one live
// socket, so there is nothing to gain from splitting them.
export interface WhatsappAuthSnapshot {
    creds: AuthenticationCreds
    keys: Record<string, Record<string, unknown>>
}

export interface WhatsappAuthStore {
    state: AuthenticationState
    // Resolves once every write queued so far has landed. Callers that must
    // not lose auth (pairing handoff, shutdown) await it.
    flush: () => Promise<void>
    stop: () => void
}

export interface WhatsappAuthStoreDeps {
    load: () => Promise<WhatsappAuthSnapshot | null>
    save: (snapshot: WhatsappAuthSnapshot) => Promise<void>
    onError?: (err: Error) => void
}

// Baileys rewrites creds on nearly every message and rotates Signal keys in
// bursts. Writing straight through would mean a row update per event, so
// writes coalesce: one timer, one in-flight write, and a trailing write when
// changes arrive mid-flight.
const SAVE_DEBOUNCE_MS = 400

export const createWhatsappAuthStore = async (
    deps: WhatsappAuthStoreDeps
): Promise<WhatsappAuthStore> => {
    const { initAuthCreds } = await loadBaileys()
    const snapshot = await deps.load()
    const creds = snapshot?.creds ?? initAuthCreds()
    const keys: Record<string, Record<string, unknown>> = snapshot?.keys ?? {}

    let timer: NodeJS.Timeout | null = null
    let inFlight: Promise<void> = Promise.resolve()
    let pending = false
    let stopped = false

    const write = async (): Promise<void> => {
        try {
            await deps.save({ creds, keys })
        } catch (err) {
            deps.onError?.(err as Error)
        }
    }

    const drain = (): void => {
        if (!pending || stopped) return
        pending = false
        inFlight = inFlight.then(write, write)
    }

    const schedule = (): void => {
        if (stopped) return
        pending = true
        if (timer) return
        timer = setTimeout(() => {
            timer = null
            drain()
        }, SAVE_DEBOUNCE_MS)
        timer.unref?.()
    }

    const keyStore: SignalKeyStore = {
        get: async <T extends keyof SignalDataTypeMap>(
            type: T,
            ids: string[]
        ) => {
            const bucket = keys[type] ?? {}
            const out: { [id: string]: SignalDataTypeMap[T] } = {}
            for (const id of ids) {
                const value = bucket[id]
                if (value !== undefined && value !== null)
                    out[id] = value as SignalDataTypeMap[T]
            }
            return out
        },
        set: async (data) => {
            for (const [type, entries] of Object.entries(data)) {
                if (!entries) continue
                const bucket = (keys[type] ??= {})
                for (const [id, value] of Object.entries(entries)) {
                    if (value === null || value === undefined)
                        delete bucket[id]
                    else bucket[id] = value
                }
            }
            schedule()
        }
    }

    return {
        state: { creds, keys: keyStore },
        flush: async () => {
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
            drain()
            await inFlight
        },
        stop: () => {
            stopped = true
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
        }
    }
}

// BufferJSON is what Baileys itself uses to persist auth: it encodes the
// Uint8Arrays inside creds and Signal keys as tagged objects. JSON.stringify
// alone would silently turn them into `{"0":12,...}` maps and the session
// would fail to decrypt after a restart.
export const serializeWhatsappAuth = async (
    snapshot: WhatsappAuthSnapshot
): Promise<string> => {
    const { BufferJSON } = await loadBaileys()
    return JSON.stringify(snapshot, BufferJSON.replacer)
}

export const deserializeWhatsappAuth = async (
    raw: string
): Promise<WhatsappAuthSnapshot> => {
    const { BufferJSON } = await loadBaileys()
    return JSON.parse(raw, BufferJSON.reviver) as WhatsappAuthSnapshot
}

export interface CreateWaSocketOptions {
    state: AuthenticationState
    // Silences Baileys' own pino logger; the provider logs through Nest.
    onQr?: (qr: string) => void
}

const silentLogger = {
    level: 'silent',
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger
}

export const createWaSocket = async (
    opts: CreateWaSocketOptions
): Promise<WASocket> => {
    const {
        default: makeWASocket,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore
    } = await loadBaileys()
    const { version } = await fetchLatestBaileysVersion()
    const logger = silentLogger as unknown as Parameters<
        typeof makeWASocket
    >[0]['logger']
    return makeWASocket({
        version,
        logger,
        auth: {
            creds: opts.state.creds,
            keys: makeCacheableSignalKeyStore(opts.state.keys, logger!)
        },
        // Shows up under Linked Devices on the user's phone.
        browser: ['Manyfold', 'Chrome', '1.0.0'],
        // The agent answers live messages; replaying the phone's whole archive
        // would cost a large sync for history nobody reads.
        syncFullHistory: false,
        // Leaves the phone's own presence alone: going online here would stop
        // WhatsApp pushing notifications to the user's handset.
        markOnlineOnConnect: false
    })
}

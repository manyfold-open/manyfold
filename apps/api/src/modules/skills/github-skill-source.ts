import { AsyncLocalStorage } from 'node:async_hooks'
import { suppressTracing } from '@sentry/opentelemetry'
import {
    GitHubRequestError,
    classifyGitHubResponse
} from '@/common/github-request-error'

export const SKILL_FETCH_CONCURRENCY = 8
export const SKILL_SCAN_LIMITS = {
    requests: 4096,
    files: 4000,
    fileBytes: 1024 * 1024,
    totalBytes: 32 * 1024 * 1024,
    snapshotBytes: 4 * 1024 * 1024,
    treeBytes: 12 * 1024 * 1024,
    durationMs: 120_000
} as const

export interface SkillRequestBudget {
    requests: number
    bytes: number
    rateRemaining: number | null
    signal: AbortSignal
}

const budgets = new AsyncLocalStorage<SkillRequestBudget>()
let active = 0
const waiting: Array<() => void> = []

const slot = async <T>(
    signal: AbortSignal,
    work: () => Promise<T>
): Promise<T> => {
    if (active >= SKILL_FETCH_CONCURRENCY)
        await new Promise<void>((resolve, reject) => {
            if (waiting.length >= 256) {
                reject(new GitHubRequestError())
                return
            }
            const resume = () => {
                signal.removeEventListener('abort', abort)
                resolve()
            }
            const abort = () => {
                const index = waiting.indexOf(resume)
                if (index >= 0) waiting.splice(index, 1)
                reject(new GitHubRequestError())
            }
            waiting.push(resume)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
        })
    else active++
    try {
        signal.throwIfAborted()
        return await work()
    } finally {
        const next = waiting.shift()
        if (next) next()
        else active--
    }
}

export const withSkillRequestBudget = async <T>(
    work: (budget: SkillRequestBudget) => Promise<T>,
    signal?: AbortSignal
): Promise<T> => {
    const inherited = budgets.getStore()
    if (inherited) {
        if (!signal) return work(inherited)
        const child = Object.create(inherited) as SkillRequestBudget
        for (const key of ['requests', 'bytes', 'rateRemaining'] as const)
            Object.defineProperty(child, key, {
                get: () => inherited[key],
                set: (value) => {
                    ;(inherited as unknown as Record<string, unknown>)[key] =
                        value
                }
            })
        child.signal = AbortSignal.any([signal, inherited.signal])
        return budgets.run(child, () => work(child))
    }
    const timeout = AbortSignal.timeout(SKILL_SCAN_LIMITS.durationMs)
    const budget: SkillRequestBudget = {
        requests: 0,
        bytes: 0,
        rateRemaining: null,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    }
    return budgets.run(budget, () => work(budget))
}

const readBytes = async (
    response: Response,
    maximum: number,
    budget: SkillRequestBudget
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            budget.bytes += value.length
            if (size > maximum || budget.bytes > SKILL_SCAN_LIMITS.totalBytes)
                throw new GitHubRequestError()
            chunks.push(value)
        }
        return Buffer.concat(chunks)
    } finally {
        await reader.cancel().catch(() => undefined)
    }
}

// Only skill-source requests use this boundary. Automatic outgoing spans would
// export arbitrary repository/path inputs; scans emit bounded summary telemetry.
export const fetchSkillSource = async (
    url: string,
    maximum = SKILL_SCAN_LIMITS.fileBytes,
    allowMissing = false
): Promise<Buffer | null> =>
    withSkillRequestBudget(async (budget) => {
        try {
            return await slot(budget.signal, () =>
                suppressTracing(async () => {
                    let current = new URL(url)
                    for (let redirect = 0; redirect <= 2; redirect++) {
                        if (
                            current.protocol !== 'https:' ||
                            ![
                                'api.github.com',
                                'raw.githubusercontent.com'
                            ].includes(current.hostname) ||
                            current.username ||
                            current.password ||
                            current.port
                        )
                            throw new GitHubRequestError()
                        if (++budget.requests > SKILL_SCAN_LIMITS.requests)
                            throw new GitHubRequestError()
                        const response = await fetch(current, {
                            headers: {
                                accept: 'application/vnd.github+json',
                                'user-agent': 'manyfold-api'
                            },
                            redirect: 'manual',
                            signal: AbortSignal.any([
                                budget.signal,
                                AbortSignal.timeout(15_000)
                            ])
                        })
                        const remaining = response.headers.get(
                            'x-ratelimit-remaining'
                        )
                        if (
                            current.hostname === 'api.github.com' &&
                            remaining !== null &&
                            /^\d+$/.test(remaining)
                        )
                            budget.rateRemaining = Number(remaining)
                        if ([301, 302, 307, 308].includes(response.status)) {
                            await response.body?.cancel()
                            const location = response.headers.get('location')
                            if (!location) throw new GitHubRequestError()
                            current = new URL(location, current)
                            continue
                        }
                        if (response.status === 404 && allowMissing) {
                            await response.body?.cancel()
                            return null
                        }
                        if (!response.ok) {
                            const body = await readBytes(
                                response,
                                8192,
                                budget
                            ).catch(() => Buffer.alloc(0))
                            throw new GitHubRequestError(
                                classifyGitHubResponse(
                                    response.status,
                                    response.headers,
                                    body.toString('utf8')
                                )
                            )
                        }
                        return readBytes(response, maximum, budget)
                    }
                    throw new GitHubRequestError()
                })
            )
        } catch (error) {
            throw error instanceof GitHubRequestError
                ? error
                : new GitHubRequestError()
        }
    })

export const mapSkillRequests = async <T, R>(
    items: readonly T[],
    work: (item: T) => Promise<R>
): Promise<R[]> => {
    const output: R[] = new Array(items.length)
    let cursor = 0
    let failure: unknown
    await Promise.all(
        Array.from(
            { length: Math.min(SKILL_FETCH_CONCURRENCY, items.length) },
            async () => {
                while (cursor < items.length && !failure) {
                    const index = cursor++
                    try {
                        output[index] = await work(items[index])
                    } catch (error) {
                        failure = error
                    }
                }
            }
        )
    )
    if (failure) throw failure
    return output
}

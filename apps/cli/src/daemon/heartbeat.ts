import { buildApiError } from '@manyfold/sdk'

// One interval's worth: a heartbeat that hangs must not pile up behind the
// next ones.
export const HEARTBEAT_TIMEOUT_MS = 15_000

// Why a heartbeat did not land, from the status and the error envelope only:
// the unparsed body never reaches the log.
export const heartbeatProblem = async (
    res: Response
): Promise<string | null> => {
    if (res.ok) {
        await res.body?.cancel().catch(() => {})
        return null
    }
    const err = await buildApiError(res)
    return `heartbeat rejected: HTTP ${res.status} ${err.code}${
        err.serverMessage ? ` (${err.serverMessage})` : ''
    }`
}

// A problem is logged when it starts or changes and once when it clears,
// not every 15 s while it lasts.
export const heartbeatReporter = (
    log: (message: string) => Promise<void> | void
): ((problem: string | null) => Promise<void>) => {
    let current: string | null = null
    return async (problem) => {
        if (problem === current) return
        const cleared = current !== null
        current = problem
        if (problem) await log(problem)
        else if (cleared) await log('heartbeat ok again')
    }
}

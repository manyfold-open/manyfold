import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRuntime } from '@manyfold/shared'
import { useApiClient } from '@/lib/apiClient'
import type { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'
import {
    wakeRefusalEndsWait,
    wakeRefusalKind,
    type WakeRefusal
} from '@/lib/wakeRefusal'

// Picking a sandbox runtime in the create form is the user's intent to use
// its accounts, so the runner is started then — the same way the composer
// prewarms the VM on focus — and the list is re-read until the runner
// answers. The list load itself stays wake-free; only the pick spends wakes.
// A runner that has not answered by the end of a cycle is asked for again:
// the form never hands the user a "start runner" button for a sandbox they
// already picked. Once it answers, the pick keeps renewing the sandbox's
// short awake hold, and moving the pick (or leaving the page) releases it —
// a sandbox the user only glanced at must not sit in the plan's active slot.
// The API debounces prewarms per runtime to one per 45s, which every cadence
// here outlasts.
const POLL_MS = 4_000
const CYCLE_MS = 90_000
const KEEP_MS = 60_000

const settled = (availability: string | undefined): boolean =>
    availability !== undefined &&
    availability !== 'host-unavailable' &&
    availability !== 'sandbox-asleep'

export interface RunnerPrewarmState {
    // The runner is being brought up; the surface shows progress.
    prewarming: boolean
    // The last ask was refused by the plan's concurrent cap: the wait goes
    // on, but it is a wait for another sandbox to sleep, not for a boot.
    waitingForSlot: boolean
    // A refusal that ended the wait (used-up hours, a failed wake): the
    // surface says why; `retry` asks again.
    refusal: WakeRefusal | null
    retry: () => void
}

export const useRunnerPrewarm = (
    runtimeId: string | null,
    kind: AgentRuntime | null,
    auth: ReturnType<typeof useRuntimeAuthList>
): RunnerPrewarmState => {
    const client = useApiClient()
    const [prewarming, setPrewarming] = useState(false)
    const [waitingForSlot, setWaitingForSlot] = useState(false)
    const [refusal, setRefusal] = useState<WakeRefusal | null>(null)
    const [attempt, setAttempt] = useState(0)
    const availability = auth.list?.availability
    const reload = auth.reload
    // The runtime whose list already answered, so a re-pick of it within the
    // same page life shows no wait (the hold is still renewed).
    const settledFor = useRef<string | null>(null)
    const retry = useCallback((): void => {
        setRefusal(null)
        setAttempt((n) => n + 1)
    }, [])

    useEffect(() => {
        setRefusal(null)
        setWaitingForSlot(false)
        if (!runtimeId || kind !== 'sprites') {
            setPrewarming(false)
            return
        }
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        // The ask. A refusal that ends the wait stops everything here; a
        // full slot is reported and the cycle goes on.
        const prewarm = (): void => {
            void client.runtimeAuth
                .prewarm(runtimeId)
                .then((view) => {
                    if (cancelled) return
                    if (!view.refused) {
                        setWaitingForSlot(false)
                        return
                    }
                    if (wakeRefusalEndsWait(view.refused.code)) {
                        cancelled = true
                        if (timer) clearTimeout(timer)
                        setPrewarming(false)
                        setWaitingForSlot(false)
                        setRefusal(view.refused)
                        return
                    }
                    setWaitingForSlot(
                        wakeRefusalKind(view.refused.code) === 'slot'
                    )
                })
                .catch(() => null)
        }
        // Answering runner: renew the hold while the pick stays here.
        const keep = (): void => {
            if (cancelled) return
            timer = setTimeout(() => {
                if (cancelled) return
                prewarm()
                keep()
            }, KEEP_MS)
        }
        const finish = (): void => {
            settledFor.current = runtimeId
            setPrewarming(false)
            keep()
        }
        const cycle = (): void => {
            if (cancelled) return
            prewarm()
            const deadline = Date.now() + CYCLE_MS
            const poll = (): void => {
                if (cancelled) return
                timer = setTimeout(() => {
                    if (cancelled) return
                    void reload().then((next) => {
                        if (cancelled) return
                        if (settled(next?.availability)) {
                            finish()
                            return
                        }
                        // Ask again once the cycle is spent; the runner
                        // may have been refused, or the VM slow to thaw.
                        if (Date.now() >= deadline) cycle()
                        else poll()
                    })
                }, POLL_MS)
            }
            poll()
        }
        if (settledFor.current === runtimeId) {
            prewarm()
            keep()
        } else {
            setPrewarming(true)
            cycle()
        }
        return (): void => {
            cancelled = true
            if (timer) clearTimeout(timer)
            setPrewarming(false)
            void client.runtimeAuth.release(runtimeId).catch(() => null)
        }
    }, [attempt, client, kind, reload, runtimeId])

    // A list that already answers ends the wait early (the runner was awake
    // before the poll got to it).
    useEffect(() => {
        if (prewarming && settled(availability)) {
            settledFor.current = runtimeId
            setPrewarming(false)
        }
    }, [availability, prewarming, runtimeId])

    return { prewarming, waitingForSlot, refusal, retry }
}

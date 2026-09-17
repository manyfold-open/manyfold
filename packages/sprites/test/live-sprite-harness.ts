import type { TestContext } from 'node:test'
import type { SpritesClient } from '../src/client'

const DELETE_BACKOFF_MS = [500, 1500]

export const withLiveSprite = async (
    t: TestContext,
    client: Pick<SpritesClient, 'createSprite' | 'deleteSprite'>,
    name: string,
    body: (signal: AbortSignal) => Promise<void>,
    options: {
        log?: (message: string) => void
        wait?: (milliseconds: number) => Promise<void>
    } = {}
): Promise<void> => {
    const log = options.log ?? console.log
    const wait =
        options.wait ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const run = async () => {
        t.signal.throwIfAborted()
        log(`[sprites live] creating ${name}`)
        await client.createSprite({ name })
        const failures: unknown[] = []
        let onAbort!: () => void
        const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => reject(t.signal.reason)
            t.signal.addEventListener('abort', onAbort, { once: true })
            if (t.signal.aborted) onAbort()
        })
        try {
            await Promise.race([
                cancelled,
                Promise.resolve().then(() => {
                    t.signal.throwIfAborted()
                    return body(t.signal)
                })
            ])
        } catch (error) {
            failures.push(error)
        } finally {
            t.signal.removeEventListener('abort', onAbort)
        }
        for (let attempt = 0; ; attempt++) {
            try {
                await client.deleteSprite(name)
                log(`[sprites live] cleanup deleted ${name}`)
                break
            } catch (error) {
                const backoff = DELETE_BACKOFF_MS[attempt]
                if (backoff === undefined) {
                    log(
                        `[sprites live] cleanup failed ${name} after ${attempt + 1} attempts`
                    )
                    failures.push(
                        new Error(
                            `Could not delete owned Sprite ${name} after ${attempt + 1} attempts`,
                            { cause: error }
                        )
                    )
                    break
                }
                await wait(backoff)
            }
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1)
            throw new AggregateError(
                failures,
                `Live probe and cleanup failed for Sprite ${name}`
            )
    }
    const lifecycle = run()
    // Node may cancel the test before its body settles. The hook must still
    // await create (15s) and three bounded SDK deletes (15s each + backoff).
    t.after(() => lifecycle.catch(() => {}), { timeout: 75_000 })
    await lifecycle
}

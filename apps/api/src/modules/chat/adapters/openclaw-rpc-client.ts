import type { ExecDriver } from './exec-driver'

export class OpenclawRpcClient {
    constructor(private readonly driver: ExecDriver) {}

    disconnect(): void {}

    async call<T = unknown>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs = 30_000
    ): Promise<T> {
        if (method !== 'sessions.list' && method !== 'sessions.history')
            throw new Error('unsupported session query')
        const handle = this.driver.stream({
            cmd: [
                'openclaw',
                'gateway',
                'call',
                method,
                '--params',
                JSON.stringify(params),
                '--json',
                '--timeout',
                String(timeoutMs)
            ],
            timeoutMs: timeoutMs + 5_000
        })
        const collect = async (
            stream: AsyncIterable<string>
        ): Promise<string> => {
            let text = ''
            for await (const chunk of stream) text += chunk
            return text
        }
        const [stdout, , result] = await Promise.all([
            collect(handle.stdout),
            collect(handle.stderr),
            handle.result
        ])
        if (result.exitCode !== 0)
            throw new Error('runner gateway session query failed')
        return JSON.parse(stdout.trim()) as T
    }
}

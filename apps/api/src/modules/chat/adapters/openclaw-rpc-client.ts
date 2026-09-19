import { redactCredentialText } from '@/common/telemetry/redact-credentials'
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
            env: { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' },
            timeoutMs: timeoutMs + 5_000
        })
        const collect = async (
            stream: AsyncIterable<string>
        ): Promise<string> => {
            let text = ''
            for await (const chunk of stream) text += chunk
            return text
        }
        const [stdout, stderr, result] = await Promise.all([
            collect(handle.stdout),
            collect(handle.stderr),
            handle.result
        ])
        if (result.exitCode !== 0)
            throw new Error(
                `runner gateway session query failed (exit ${result.exitCode}): ${redactCredentialText(stderr).slice(-1024).trim()}`
            )
        // Older CLIs can emit startup notes even with banner suppression.
        const start = stdout.indexOf('{')
        const end = stdout.lastIndexOf('}')
        try {
            if (start < 0 || end < start) throw new Error('missing JSON')
            return JSON.parse(stdout.slice(start, end + 1)) as T
        } catch {
            throw new Error(
                'runner gateway session query returned invalid JSON'
            )
        }
    }
}

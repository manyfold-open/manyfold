export interface GatewayConfig {
    port: number
    host: string
    tokens: Set<string>
    maxBodyBytes: number
    defaultExecTimeoutMs: number
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): GatewayConfig => {
    const rawTokens = env.MF_K8S_GATEWAY_TOKEN ?? ''
    const tokens = new Set(
        rawTokens
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
    )
    if (tokens.size === 0)
        throw new Error(
            'MF_K8S_GATEWAY_TOKEN is required (comma-separated for rotation)'
        )

    const port = Number(env.PORT ?? '3000')
    if (!Number.isFinite(port) || port <= 0 || port > 65535)
        throw new Error(`invalid PORT: ${env.PORT}`)

    return {
        port,
        host: env.HOST ?? '0.0.0.0',
        tokens,
        maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 1_048_576),
        defaultExecTimeoutMs: Number(env.DEFAULT_EXEC_TIMEOUT_MS ?? 60_000)
    }
}

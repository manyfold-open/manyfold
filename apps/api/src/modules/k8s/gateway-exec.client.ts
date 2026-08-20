import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type {
    GatewayExecRequestBody,
    GatewayExecResponseBody,
    PodExecRequest,
    PodExecResult,
    PodExecTarget
} from '@manyfold/k8s-exec-core'

const TRANSPORT_ERROR_CODES = new Set([502, 503])
const MAX_TRANSPORT_RETRIES = 2

export class GatewayExecError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly httpStatus: number
    ) {
        super(message)
        this.name = 'GatewayExecError'
    }
}

@Injectable()
export class GatewayExecClient {
    private readonly log = new Logger(GatewayExecClient.name)
    private readonly baseUrl: string | null
    private readonly token: string | null

    // Missing gateway config must not crash boot: K8sModule is @Global and
    // eagerly instantiated, while deployments that never use the k8s runtime
    // (self-hosted daemon/sprites-only) have no reason to set these envs.
    // Validation is deferred to exec(), matching the isConfigured() pattern
    // used by the other optional integrations.
    constructor(config: ConfigService) {
        const url = (config.get<string>('MF_K8S_GATEWAY_URL') ?? '').trim()
        const token = (config.get<string>('MF_K8S_GATEWAY_TOKEN') ?? '').trim()
        this.baseUrl = url ? url.replace(/\/+$/, '') : null
        this.token = token || null
    }

    isConfigured(): boolean {
        return this.baseUrl !== null && this.token !== null
    }

    async exec(
        target: PodExecTarget,
        req: PodExecRequest
    ): Promise<PodExecResult> {
        if (this.baseUrl === null || this.token === null)
            throw new GatewayExecError(
                'k8s gateway is not configured: set MF_K8S_GATEWAY_URL (gateway base URL, e.g. https://k8s-gateway.example.com) and MF_K8S_GATEWAY_TOKEN to enable pod exec',
                'NOT_CONFIGURED',
                0
            )
        const body: GatewayExecRequestBody = {
            namespace: target.namespace,
            pod: target.pod,
            container: target.container,
            cmd: req.cmd,
            stdin: req.stdin,
            timeoutMs: req.timeoutMs
        }
        const wallClockBudget = Math.max(1_000, req.timeoutMs + 5_000)
        const controller = new AbortController()
        const wallClockTimer = setTimeout(
            () => controller.abort(),
            wallClockBudget
        )

        try {
            const resp = await this.fetchWithRetry(
                `${this.baseUrl}/exec`,
                {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${this.token}`,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                }
            )
            const text = await resp.text()
            const parsed = safeJsonParse(text)
            if (resp.ok) {
                const r = parsed as GatewayExecResponseBody
                if (
                    !r ||
                    typeof r.exitCode !== 'number' ||
                    typeof r.stdout !== 'string' ||
                    typeof r.stderr !== 'string'
                )
                    throw new GatewayExecError(
                        `gateway returned malformed success body: ${text.slice(0, 200)}`,
                        'BAD_GATEWAY_RESPONSE',
                        resp.status
                    )
                return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
            }
            const errBody = (parsed ?? {}) as {
                error?: string
                code?: string
            }
            const message =
                errBody.error ??
                `gateway error: HTTP ${resp.status} ${text.slice(0, 200)}`
            throw new GatewayExecError(
                message,
                errBody.code ?? `HTTP_${resp.status}`,
                resp.status
            )
        } catch (err) {
            if (err instanceof GatewayExecError) throw err
            if (controller.signal.aborted)
                throw new GatewayExecError(
                    `gateway client wall-clock budget exceeded (${wallClockBudget}ms)`,
                    'CLIENT_TIMEOUT',
                    0
                )
            const message = err instanceof Error ? err.message : String(err)
            throw new GatewayExecError(
                `gateway transport error: ${message}`,
                'TRANSPORT',
                0
            )
        } finally {
            clearTimeout(wallClockTimer)
        }
    }

    private async fetchWithRetry(
        url: string,
        init: RequestInit
    ): Promise<Response> {
        let lastErr: unknown
        for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
            try {
                const resp = await fetch(url, init)
                if (!TRANSPORT_ERROR_CODES.has(resp.status)) return resp
                lastErr = new Error(`gateway HTTP ${resp.status}`)
            } catch (err) {
                lastErr = err
            }
            if (attempt < MAX_TRANSPORT_RETRIES) {
                const backoffMs = 100 * 2 ** attempt
                await new Promise((r) => setTimeout(r, backoffMs))
                this.log.debug(
                    `gateway retry attempt ${attempt + 1} after ${backoffMs}ms`
                )
            }
        }
        throw lastErr ?? new Error('gateway request failed after retries')
    }
}

const safeJsonParse = (text: string): unknown => {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

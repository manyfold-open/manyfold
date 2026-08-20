export interface PodExecRequest {
    cmd: string[]
    timeoutMs: number
    stdin?: string
}

export interface PodExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface PodExecTarget {
    namespace: string
    pod: string
    container: string
}

export interface GatewayExecRequestBody extends PodExecTarget, PodExecRequest {}

export interface GatewayExecResponseBody extends PodExecResult {
    durationMs: number
}

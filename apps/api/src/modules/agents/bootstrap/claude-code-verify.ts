import { BootstrapError } from '@/modules/agents/bootstrap/framework-bootstrap'

export interface ClaudePrintResult {
    is_error?: boolean
    result?: string
}

export interface ClaudePrintExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

export const assertClaudePrintSucceeded = (
    verify: ClaudePrintExecResult,
    step: string
): void => {
    const parsed = parseClaudePrintJson(verify.stdout)
    if (parsed?.is_error)
        throw new BootstrapError(
            step,
            `claude --print returned is_error=true: ${summarizeText(parsed.result ?? 'no result')}`
        )

    if (verify.exitCode !== 0)
        throw new BootstrapError(
            step,
            `claude --print exited ${verify.exitCode}: ${summarizeProcessOutput(verify)}`
        )

    if (!parsed)
        throw new BootstrapError(
            step,
            `claude --print did not return JSON: ${summarizeText(verify.stdout)}`
        )
}

const parseClaudePrintJson = (stdout: string): ClaudePrintResult | null => {
    const text = stdout.trim()
    if (!text) return null
    try {
        return JSON.parse(text) as ClaudePrintResult
    } catch {
        return null
    }
}

const summarizeProcessOutput = (result: ClaudePrintExecResult): string => {
    const stderr = summarizeText(result.stderr)
    if (stderr) return stderr
    const stdout = summarizeText(result.stdout)
    return stdout || 'no process output'
}

const summarizeText = (value: string): string =>
    value
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(
            /\b(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)=\S+/gi,
            '$1=[REDACTED]'
        )
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
        .slice(0, 512)

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
    selectInterface,
    type AgentCard,
    type Message,
    type Part,
    type Task,
    type TextPart
} from '@manyfold/a2a'
import type { A2aSelfPeer } from '@manyfold/shared'

export interface BuildMessageOpts {
    contextId?: string
    taskId?: string
    skill?: string
    inputFile?: string
}

export const resolveBearer = (flag?: string): string | undefined => {
    if (flag === '-') {
        const piped = readFileSync(0, 'utf8').trim()
        return piped.length > 0 ? piped : undefined
    }
    if (flag) return flag
    const env = process.env.MF_A2A_BEARER
    return env && env.length > 0 ? env : undefined
}

export const partsToText = (parts: Part[]): string =>
    parts
        .filter((part): part is TextPart => part.kind === 'text')
        .map((part) => part.text)
        .join('')

export const artifactText = (task: Task): string =>
    (task.artifacts ?? []).map((artifact) => partsToText(artifact.parts)).join('\n')

export const buildA2aMessage = (
    prompt: string | undefined,
    opts: BuildMessageOpts
): Message => {
    const parts: Part[] = []
    if (prompt) parts.push({ kind: 'text', text: prompt })
    if (opts.inputFile) {
        const bytes = readFileSync(opts.inputFile)
        parts.push({
            kind: 'file',
            file: { name: basename(opts.inputFile), bytes: bytes.toString('base64') }
        })
    }
    if (parts.length === 0)
        throw new Error('provide a prompt or --input-file')
    const message: Message = {
        kind: 'message',
        role: 'user',
        parts,
        messageId: randomUUID()
    }
    if (opts.taskId) message.taskId = opts.taskId
    if (opts.contextId) message.contextId = opts.contextId
    if (opts.skill) message.metadata = { skillId: opts.skill }
    return message
}

// A target arg is a raw A2A endpoint when it parses as an http(s) URL; anything
// else (a name or agent id) is a granted-peer reference resolved via agent-self.
// This is the peer-vs-url split shared by `send` and the `tasks` subcommands.
export const isHttpUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
        return false
    }
}

export const looksLikeRpcEndpoint = (url: string): boolean => {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return false
    }
    return /\/(rpc|a2a)$/.test(parsed.pathname.replace(/\/+$/, ''))
}

export const resolveInterfaceUrl = (card: AgentCard, cardUrl: string): string => {
    const iface = selectInterface(card, 'JSONRPC')
    return new URL(iface.url, cardUrl).toString()
}

// Match a peer from `mf a2a peers` by agent id (preferred) or name.
export const findSelfPeer = (
    peers: A2aSelfPeer[],
    ref: string
): A2aSelfPeer | undefined => {
    const needle = ref.trim().toLowerCase()
    return (
        peers.find((peer) => peer.agentId.toLowerCase() === needle) ??
        peers.find((peer) => peer.name.toLowerCase() === needle)
    )
}

export const DEFAULT_A2A_TIMEOUT_SECONDS = 900

export interface Deadline {
    signal: AbortSignal
    timedOut: () => boolean
    dispose: () => void
}

// A client-side deadline for blocking A2A calls: aborts on SIGINT or after
// `seconds` (0 disables). The hosted server enforces its own per-turn cap;
// this is the backstop so the CLI can't hang forever if a peer wedges or the
// server stops responding.
export const createDeadline = (seconds: number): Deadline => {
    const controller = new AbortController()
    let timedOut = false
    const onSigint = (): void => controller.abort()
    process.once('SIGINT', onSigint)
    const timer =
        seconds > 0
            ? setTimeout(() => {
                  timedOut = true
                  controller.abort()
              }, seconds * 1000)
            : undefined
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose: () => {
            if (timer) clearTimeout(timer)
            process.removeListener('SIGINT', onSigint)
        }
    }
}

export const resolveTimeoutSeconds = (raw?: string): number => {
    if (raw === undefined) return DEFAULT_A2A_TIMEOUT_SECONDS
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_A2A_TIMEOUT_SECONDS
}

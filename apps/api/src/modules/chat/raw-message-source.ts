import {
    AgentFramework,
    AgentRuntime,
    createObjectId
} from '@manyfold/shared'
import { createHash } from 'node:crypto'
import type { NewChatMessageSource } from '@manyfold/db'
import { sanitizeForJsonb } from '@/common/jsonb-sanitize'
import type { RawMessageSourcePayload } from './chat-adapter'

export type ChatMessageSourceKind = 'live_stream' | 'local_session_recovery'

export interface BuildChatMessageSourceInput {
    sourceKind: ChatMessageSourceKind
    sessionId: string
    messageId: string | null
    framework: AgentFramework
    runtime: AgentRuntime
    source: RawMessageSourcePayload
    runnerSeq?: number
}

export const buildChatMessageSourceRow = (
    input: BuildChatMessageSourceInput
): NewChatMessageSource => {
    // Sanitize raw payloads BEFORE hashing so rawSha256/sourceEventKey/
    // rawBytes match the stored content; Postgres rejects NUL in both text
    // and jsonb columns.
    const source = sanitizeRawPayload(input.source)
    const rawMaterial = rawMaterialForHash(source)
    const rawSha256 = sha256(rawMaterial)
    const sourceEventKey =
        input.sourceKind === 'live_stream'
            ? buildSourceEventKey({
                  sourceKind: input.sourceKind,
                  messageId: input.messageId,
                  sourceSeq: source.sourceSeq,
                  rawSha256
              })
            : buildSourceEventKey({
                  sourceKind: input.sourceKind,
                  sessionId: input.sessionId,
                  sourceRef: source.sourceRef ?? null,
                  sourceFile: source.sourceFile ?? null,
                  sourceSeq: source.sourceSeq,
                  externalId: source.externalId ?? null,
                  rawSha256
              })
    const now = new Date()
    return {
        id: createObjectId('chatMessageSource'),
        sessionId: input.sessionId,
        messageId: input.messageId,
        sourceKind: input.sourceKind,
        framework: input.framework,
        runtime: input.runtime,
        sourceRef: source.sourceRef ?? null,
        sourceFile: source.sourceFile ?? null,
        sourceSeq: source.sourceSeq,
        runnerSeq: input.runnerSeq ?? null,
        sourceEventKey,
        externalId: source.externalId ?? null,
        parentExternalId: source.parentExternalId ?? null,
        rawFormat: source.rawFormat,
        rawText: source.rawText ?? null,
        rawJson: source.rawJson === undefined ? null : source.rawJson,
        rawSha256,
        rawBytes: Buffer.byteLength(rawMaterial, 'utf8'),
        parserName: source.parserName,
        parserVersion: source.parserVersion,
        parsedAt: now,
        rawClearedAt: null,
        createdAt: now,
        updatedAt: now
    }
}

const sanitizeRawPayload = (
    source: RawMessageSourcePayload
): RawMessageSourcePayload => ({
    ...source,
    rawText: sanitizeForJsonb(source.rawText),
    rawJson: sanitizeForJsonb(source.rawJson)
})

const rawMaterialForHash = (source: RawMessageSourcePayload): string => {
    if (source.rawText != null) return source.rawText
    return stableJson(source.rawJson ?? null)
}

const buildSourceEventKey = (value: Record<string, unknown>): string =>
    `${value.sourceKind}:${sha256(stableJson(value))}`

const sha256 = (text: string): string =>
    createHash('sha256').update(text).digest('hex')

const stableJson = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`
}

import { inputValidation } from './inputValidation'

export type AgentNameValidationCode =
    | 'empty'
    | 'too_long'
    | 'control_character'
    | 'invalid_start'
    | 'invalid_character'

export type AgentNameValidationResult =
    | { valid: true; value: string }
    | {
          valid: false
          code: AgentNameValidationCode
          message: string
      }

const MAX_AGENT_NAME_GRAPHEMES = inputValidation.AGENT_NAME.MAX

const CONTROL_CHARACTER_RE = /\p{Cc}/u
const CONTROL_CHARACTER_GLOBAL_RE = /\p{Cc}/gu
const LEADING_PUNCTUATION_OR_SPACE_RE = /^[\p{P}\p{White_Space}]/u
const LEADING_PUNCTUATION_OR_SPACE_GLOBAL_RE = /^[\p{P}\p{White_Space}]+/u
const WHITE_SPACE_RUN_RE = /\p{White_Space}+/gu
const DASH_LOOKALIKE_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu
const TEXT_CLUSTER_RE = /^[\p{L}\p{N}\p{M} _.-]+$/u
const EMOJI_MARKER_RE =
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}]/u
const EMOJI_CLUSTER_PART_RE =
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Emoji_Component}|\p{Regional_Indicator})$/u

interface SegmentResult {
    segment: string
}

type Segmenter = new (
    locale?: string,
    options?: { granularity: 'grapheme' }
) => {
    segment(input: string): Iterable<SegmentResult>
}

export const normalizeAgentName = (input: string): string =>
    input.trim().normalize('NFC')

export const validateAgentName = (input: string): AgentNameValidationResult => {
    if (CONTROL_CHARACTER_RE.test(input))
        return {
            valid: false,
            code: 'control_character',
            message: 'Agent name cannot contain control characters.'
        }
    const value = normalizeAgentName(input)
    if (!value)
        return {
            valid: false,
            code: 'empty',
            message: 'Agent name is required.'
        }

    const graphemes = splitGraphemes(value)
    if (graphemes.length > MAX_AGENT_NAME_GRAPHEMES)
        return {
            valid: false,
            code: 'too_long',
            message: `Agent name must be ${MAX_AGENT_NAME_GRAPHEMES} characters or fewer.`
        }
    if (LEADING_PUNCTUATION_OR_SPACE_RE.test(value))
        return {
            valid: false,
            code: 'invalid_start',
            message: 'Agent name must start with a letter, number, or emoji.'
        }
    if (!graphemes.every(isAllowedAgentNameCluster))
        return {
            valid: false,
            code: 'invalid_character',
            message:
                'Agent name can contain letters, numbers, emoji, spaces, underscore, dash, and dot.'
        }

    return { valid: true, value }
}

const splitGraphemes = (value: string): string[] => {
    const SegmenterCtor = (Intl as unknown as { Segmenter?: Segmenter })
        .Segmenter
    if (!SegmenterCtor) return Array.from(value)
    return Array.from(
        new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(
            value
        ),
        (part) => part.segment
    )
}

const isAllowedAgentNameCluster = (cluster: string): boolean => {
    if (TEXT_CLUSTER_RE.test(cluster)) return true
    return (
        EMOJI_MARKER_RE.test(cluster) &&
        Array.from(cluster).every((part) => EMOJI_CLUSTER_PART_RE.test(part))
    )
}

export const suggestAgentName = (input: string): string | null => {
    const source = input
        .replace(CONTROL_CHARACTER_GLOBAL_RE, ' ')
        .replace(DASH_LOOKALIKE_RE, '-')
    const kept = splitGraphemes(normalizeAgentName(source))
        .map((cluster) => (isAllowedAgentNameCluster(cluster) ? cluster : ' '))
        .join('')
        .replace(WHITE_SPACE_RUN_RE, ' ')
        .replace(LEADING_PUNCTUATION_OR_SPACE_GLOBAL_RE, '')
    const candidate = normalizeAgentName(
        splitGraphemes(kept).slice(0, MAX_AGENT_NAME_GRAPHEMES).join('')
    )
    if (!candidate || candidate === normalizeAgentName(input)) return null
    return validateAgentName(candidate).valid ? candidate : null
}

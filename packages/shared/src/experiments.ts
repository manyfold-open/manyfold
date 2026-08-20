export const EXPERIMENT_KEYS = Object.freeze({
    AGENT_CREATE_UX: 'agent_create_ux'
} as const)

export interface ExperimentVariantWeight {
    id: string
    weight: number
}

export type ExperimentStatus = 'draft' | 'active' | 'disabled'

export interface ExperimentConfig {
    key: string
    variants: ExperimentVariantWeight[]
    defaultVariant: string
    status: ExperimentStatus
    salt: string
}

export type ExperimentAssignmentReason =
    | 'override'
    | 'rollout'
    | 'kill_switch'
    | 'default'

export interface ExperimentAssignment {
    variant: string
    reason: ExperimentAssignmentReason
}

export const assignVariant = (
    cfg: ExperimentConfig,
    userId: string,
    override?: string | null
): ExperimentAssignment => {
    if (cfg.status === 'disabled')
        return { variant: cfg.defaultVariant, reason: 'kill_switch' }
    if (override) return { variant: override, reason: 'override' }

    const validVariants = cfg.variants.filter(
        (v) => Number.isFinite(v.weight) && v.weight > 0
    )
    if (validVariants.length === 0)
        return { variant: cfg.defaultVariant, reason: 'default' }

    const totalWeight = validVariants.reduce((sum, v) => sum + v.weight, 0)
    if (totalWeight <= 0)
        return { variant: cfg.defaultVariant, reason: 'default' }

    const bucket = hashUint32(`${userId}:${cfg.key}:${cfg.salt}`) % totalWeight
    let cumulative = 0
    for (const variant of validVariants) {
        cumulative += variant.weight
        if (bucket < cumulative)
            return { variant: variant.id, reason: 'rollout' }
    }
    return { variant: cfg.defaultVariant, reason: 'default' }
}

const hashUint32 = (input: string): number => {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}

export const generateExperimentSalt = (): string => {
    const bytes = new Uint8Array(8)
    if (
        typeof globalThis !== 'undefined' &&
        globalThis.crypto?.getRandomValues
    )
        globalThis.crypto.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    let out = ''
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
    return out
}

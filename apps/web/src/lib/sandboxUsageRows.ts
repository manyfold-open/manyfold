import type {
    AgentFramework,
    SandboxUsageHost
} from '@manyfold/shared'

export interface SandboxStorageRow {
    key: string
    kind: 'workspace' | 'home' | 'other'
    label: string
    framework: AgentFramework | null
    bytes: number | null
    measuredBytes: number | null
    pct: number
}

const DECIMAL_UNITS = [
    { value: 1_000_000_000, suffix: 'GB', decimals: 2 },
    { value: 1_000_000, suffix: 'MB', decimals: 1 },
    { value: 1_000, suffix: 'KB', decimals: 1 }
]

// Decimal (1000-base), matching the plan meter's bytes/1e9 GB. A 1024-base
// formatter here would make the drill-down rows appear to under-count the
// meter they explain.
export const formatBytesDecimal = (bytes: number | null): string => {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
    for (const unit of DECIMAL_UNITS) {
        if (bytes >= unit.value)
            return `${(bytes / unit.value).toFixed(unit.decimals)} ${unit.suffix}`
    }
    return `${Math.round(bytes)} B`
}

export const sharePct = (value: number, total: number): number =>
    total > 0 ? Math.min(100, (value / total) * 100) : 0

export const hostStorageRows = (
    host: SandboxUsageHost
): SandboxStorageRow[] => {
    const total = host.storageBytes ?? 0
    const rows: SandboxStorageRow[] = host.agents.map((agent) => ({
        key: `ws-${agent.agentId}`,
        kind: 'workspace',
        label: agent.name,
        framework: agent.framework,
        bytes: agent.attributedBytes,
        measuredBytes: agent.workspaceBytes,
        pct: sharePct(agent.attributedBytes ?? 0, total)
    }))
    for (const [index, home] of host.homes.entries())
        rows.push({
            key: `home-${home.framework}-${index}`,
            kind: 'home',
            label: home.path ?? home.framework,
            framework: home.framework,
            bytes: home.bytes,
            measuredBytes: home.measuredBytes,
            pct: sharePct(home.bytes ?? 0, total)
        })
    if (host.storageBytes !== null && host.storageMeasured && host.attributionComplete) {
        const accounted = rows.reduce((acc, row) => acc + (row.bytes ?? 0), 0)
        const other = accounted > host.storageBytes ? null : host.storageBytes - accounted
        rows.push({
            key: 'other',
            kind: 'other',
            label: '',
            framework: null,
            bytes: other,
            measuredBytes: null,
            pct: sharePct(other ?? 0, total)
        })
    }
    return rows
}

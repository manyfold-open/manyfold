import type { DaemonClientProcess } from '@manyfold/shared'

export const parseDaemonClientProcess = (
    value: unknown
): DaemonClientProcess | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined
    const record = value as Record<string, unknown>
    if (
        typeof record.instanceId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            record.instanceId
        ) ||
        typeof record.pid !== 'number' ||
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        record.pid > 2147483647
    )
        return undefined
    return { instanceId: record.instanceId.toLowerCase(), pid: record.pid }
}

export const daemonClientProcessFields = (
    value: DaemonClientProcess | undefined
): string =>
    `clientInstanceId=${value?.instanceId ?? 'unknown'} clientPid=${value?.pid ?? 'unknown'}`

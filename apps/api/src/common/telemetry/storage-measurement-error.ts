export type StorageFailureClass =
    | 'timeout'
    | 'transport'
    | 'permission'
    | 'command'
    | 'unreadable'
    | 'persistence'
    | 'unknown'

export class StorageMeasurementError extends Error {
    constructor(readonly failureClass: StorageFailureClass) {
        super(`sprite storage measurement failed (${failureClass})`)
        this.name = 'StorageMeasurementError'
    }
}

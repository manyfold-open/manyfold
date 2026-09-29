export class BootstrapError extends Error {
    readonly step: string
    readonly cause?: unknown
    constructor(step: string, message: string, cause?: unknown) {
        super(message)
        this.name = 'BootstrapError'
        this.step = step
        this.cause = cause
    }
}

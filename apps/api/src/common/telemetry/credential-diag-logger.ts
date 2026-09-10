import { DiagConsoleLogger, type DiagLogger } from '@opentelemetry/api'
import {
    redactCredentialText,
    redactCredentialValue
} from './redact-credentials'

export const credentialDiagLogger = (): DiagLogger => {
    const logger = new DiagConsoleLogger()
    return {
        error: (message, ...args) =>
            logger.error(
                redactCredentialText(message),
                ...args.map(redactCredentialValue)
            ),
        warn: (message, ...args) =>
            logger.warn(
                redactCredentialText(message),
                ...args.map(redactCredentialValue)
            ),
        info: (message, ...args) =>
            logger.info(
                redactCredentialText(message),
                ...args.map(redactCredentialValue)
            ),
        debug: (message, ...args) =>
            logger.debug(
                redactCredentialText(message),
                ...args.map(redactCredentialValue)
            ),
        verbose: (message, ...args) =>
            logger.verbose(
                redactCredentialText(message),
                ...args.map(redactCredentialValue)
            )
    }
}

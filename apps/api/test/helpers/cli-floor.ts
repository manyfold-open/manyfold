import { DAEMON_MIN_CLI_VERSION } from '@manyfold/shared'

// Daemon fixtures sit at or above the floor unless the test is about the
// floor itself, so raising it does not push every fixture below it.
const [major, minor, patch] = DAEMON_MIN_CLI_VERSION.split('.').map(Number)

export const CLI_AT_FLOOR = DAEMON_MIN_CLI_VERSION
export const CLI_ABOVE_FLOOR = `${major}.${minor}.${patch + 1}`
export const CLI_BELOW_FLOOR =
    patch > 0
        ? `${major}.${minor}.${patch - 1}`
        : minor > 0
          ? `${major}.${minor - 1}.0`
          : `${major - 1}.0.0`
// The refusal the API gives a daemon below the floor, with or without "is".
export const FLOOR_REFUSAL = new RegExp(
    `daemon CLI ${DAEMON_MIN_CLI_VERSION.replace(/\./g, '\\.')} or newer (is )?required`
)

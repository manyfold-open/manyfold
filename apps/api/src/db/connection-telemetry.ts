import { inBackgroundContext } from '@/common/telemetry/background-context'
import type { TelemetryService } from '@/common/telemetry/telemetry.service'

export type DbPool = 'app' | 'bus' | 'broker'

// postgres.js calls onclose once per closed pool connection: a lifetime
// recycle now and then, or every connection at once when the pooler drops
// them. A burst across pools and machines is the shared-cluster signature
// (#843). Root context: the close is not part of whatever request happened
// to open the connection.
export const onDbConnectionClosed = (
    telemetry: TelemetryService | undefined,
    pool: DbPool
): (() => void) =>
    inBackgroundContext(() => telemetry?.event('db.connection.closed', { pool }))

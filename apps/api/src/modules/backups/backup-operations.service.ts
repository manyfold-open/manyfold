import { Inject, Injectable } from '@nestjs/common'
import { and, eq, gt } from 'drizzle-orm'
import { serviceLeases, type Database } from '@manyfold/db'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { DRIZZLE } from '@/db/tokens'

const LEASE_MS = 2 * 60_000
const RENEW_MS = 20_000
const JOB_MS = 30 * 60_000

export interface BackupOperationClaim {
    signal: AbortSignal
    assertOwned(): Promise<void>
    ownsLease(): Promise<boolean>
    close(): Promise<void>
}

@Injectable()
export class BackupOperationsService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly leases: ServiceLeaseService
    ) {}

    async claim(
        key: string,
        operationId: string
    ): Promise<BackupOperationClaim | null> {
        const name = `workspace-backup:${key}`
        if (!(await this.leases.tryAcquireOrRenew(name, operationId, LEASE_MS)))
            return null
        const controller = new AbortController()
        let closed = false
        let renewing: Promise<boolean> | null = null
        const renew = (): Promise<boolean> => {
            if (closed) return Promise.resolve(false)
            if (renewing) return renewing
            renewing = (async () => {
                const now = new Date()
                const rows = await this.db
                    .update(serviceLeases)
                    .set({
                        expiresAt: new Date(now.getTime() + LEASE_MS),
                        updatedAt: now
                    })
                    .where(
                        and(
                            eq(serviceLeases.name, name),
                            eq(serviceLeases.holderId, operationId),
                            gt(serviceLeases.expiresAt, now)
                        )
                    )
                    .returning({ name: serviceLeases.name })
                return rows.length === 1
            })().finally(() => {
                renewing = null
            })
            return renewing
        }
        const heartbeat = setInterval(() => {
            void renew()
                .then((owned) => {
                    if (!owned)
                        controller.abort(
                            new Error('backup operation lease lost')
                        )
                })
                .catch(() =>
                    controller.abort(
                        new Error('backup operation lease unavailable')
                    )
                )
        }, RENEW_MS)
        heartbeat.unref()
        const deadline = setTimeout(() => {
            controller.abort(new Error('backup operation timed out'))
        }, JOB_MS)
        deadline.unref()
        return {
            signal: controller.signal,
            ownsLease: renew,
            assertOwned: async () => {
                controller.signal.throwIfAborted()
                if (!(await renew())) {
                    controller.abort(new Error('backup operation lease lost'))
                    controller.signal.throwIfAborted()
                }
            },
            close: async () => {
                closed = true
                clearInterval(heartbeat)
                clearTimeout(deadline)
                controller.abort(new Error('backup operation finished'))
                await renewing?.catch(() => {})
                await this.leases.release(name, operationId)
            }
        }
    }
}

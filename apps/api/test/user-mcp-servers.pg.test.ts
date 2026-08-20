import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { inArray } from 'drizzle-orm'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { createDb, users, type Database } from '@manyfold/db'
import { UserMcpServersService } from '../src/modules/mcp-catalog/user-mcp-servers.service'

const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    userId: string
    otherUserId: string
    servers: UserMcpServersService
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `usr_pgtest_mcp_${suffix}`
    const otherUserId = `usr_pgtest_mcp_other_${suffix}`
    await db.insert(users).values([
        { id: userId, email: `mcp-${suffix}@pgtest.local` },
        { id: otherUserId, email: `mcp-other-${suffix}@pgtest.local` }
    ])
    return {
        db,
        userId,
        otherUserId,
        servers: new UserMcpServersService(db),
        close: async (): Promise<void> => {
            await db
                .delete(users)
                .where(inArray(users.id, [userId, otherUserId]))
            await db.$client.end()
        }
    }
}

test(
    'user MCP library is reusable and isolated by owner',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const created = await h.servers.create(h.userId, {
                serverKey: 'context7',
                name: 'Context7',
                description: 'Docs lookup',
                transport: 'http',
                url: 'https://mcp.example.com/mcp',
                headers: { Authorization: 'Bearer secret' }
            })
            assert.match(created.id, /^ums_[a-z2-7]{26}$/)
            assert.equal(created.serverKey, 'context7')
            assert.deepEqual(created.headers, {
                Authorization: 'Bearer secret'
            })

            await assert.rejects(
                h.servers.create(h.userId, {
                    serverKey: 'context7',
                    name: 'Duplicate',
                    transport: 'http',
                    url: 'https://example.com/mcp'
                }),
                ConflictException
            )
            await assert.rejects(
                h.servers.get(h.otherUserId, created.id),
                NotFoundException
            )

            const switched = await h.servers.update(h.userId, created.id, {
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@example/mcp']
            })
            assert.equal(switched.transport, 'stdio')
            assert.equal(switched.url, undefined)
            assert.equal(switched.headers, undefined)
            assert.equal(switched.command, 'npx')

            assert.deepEqual(
                (await h.servers.list(h.userId)).map((server) => server.id),
                [created.id]
            )
            await h.servers.delete(h.userId, created.id)
            assert.deepEqual(await h.servers.list(h.userId), [])
        } finally {
            await h.close()
        }
    }
)
